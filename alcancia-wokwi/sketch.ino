/*
 * Alcancía inteligente de colones - prototipo para Wokwi
 *
 * Flujo: entra una moneda o un billete -> el monedero programable (CH-926) o
 * el lector de billetes lo reconoce y lo deja caer a la alcancía -> envía un
 * tren de pulsos -> el ESP32 cuenta los pulsos y sabe qué entró -> la
 * pantalla y el sonido confirman -> se genera el evento que irá a Supabase.
 *
 * El monedero se entrena con monedas reales de varios años de acuñación, así
 * que las diferencias de peso y aleación entre emisiones las resuelve él. Lo
 * que no reconoce lo devuelve por su salida de rechazo, donde un sensor IR
 * avisa al ESP32. El lector de billetes envía 1 pulso por cada ₡1000.
 *
 * Wokwi no tiene monedero ni lector de billetes. Con MODO_SIMULACION = true
 * cada botón hace de lector: el GPIO 17 genera los pulsos del monedero (un
 * cable los lleva al GPIO 16) y el GPIO 2 los del lector de billetes (cable al
 * GPIO 39). Así el conteo de pulsos es el mismo código que en el hardware real.
 *
 * Con SUPABASE_URL vacío funciona sin conexión. Al configurarlo, los eventos
 * entran a una cola y se envían a la Edge Function "dispositivo"; si no hay
 * red se reintentan, y el id de cada evento evita duplicados en la nube. La
 * orden de abrir la cerradura llega desde la app al sincronizar.
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>

const bool MODO_SIMULACION = true;

// Nube. Las claves reales van en secretos.h, que nunca se sube al repositorio
#if __has_include("secretos.h")
#include "secretos.h"
#else
const char *WIFI_SSID = "Wokwi-GUEST";
const char *WIFI_CLAVE = "";
const char *SUPABASE_URL = "";  // https://<proyecto>.supabase.co/functions/v1/dispositivo
const char *CODIGO_ALCANCIA = "";
const char *CLAVE_ALCANCIA = "";
#endif

const unsigned long SINCRONIZAR_MS = 10000;
const unsigned long REINTENTO_MS = 30000;  // Sin nube, reintenta menos para no estorbar
const unsigned long ESPERA_WIFI_MS = 10000;
const int TAMANO_COLA = 32;
const int EVENTOS_POR_ENVIO = 10;
// Con la cola casi llena se apagan los lectores: sin poder registrarlo, mejor
// que la moneda o el billete salga por la devolución a que se cuente mal
const int MARGEN_COLA = 2;

// Conexiones
const int PIN_PULSOS_MONEDAS = 16;   // Salida COIN del CH-926, por optoacoplador: LOW en cada pulso
const int PIN_PULSOS_BILLETES = 39;  // Salida de pulsos del lector de billetes, por optoacoplador
const int PIN_LECTORES_ACTIVOS = 18; // Relé que da los 12 V al monedero y al lector de billetes
const int PIN_BUZZER = 19;
const int PIN_RELE = 23;             // Cerradura solenoide
const int PIN_LED_OK = 13;
const int PIN_LED_ERROR = 5;
const int PIN_DEVOLUCION = 34;  // Solo hardware real: FC-51 en la salida de rechazo, LOW al pasar moneda

// Solo simulación
const int PIN_SIM_MONEDERO = 17;  // Genera los pulsos del monedero; en Wokwi va cableado al GPIO 16
const int PIN_SIM_BILLETES = 2;   // Genera los pulsos de billetes; en Wokwi va cableado al GPIO 39
const int PIN_OBJETO_RARO = 4;    // Hace de sensor de la devolución
const int PINES_MONEDA[] = {32, 33, 25, 26, 27};
const int PINES_BILLETE[] = {14, 15, 12, 0, 35};  // El 35 lleva una resistencia de pull-up externa

// Monedas y billetes en circulación
struct Denominacion {
  int valor;
  int cantidad;
};

Denominacion denominaciones[] = {
  {10, 0}, {25, 0}, {50, 0}, {100, 0}, {500, 0},             // Monedas: índices 0-4
  {1000, 0}, {2000, 0}, {5000, 0}, {10000, 0}, {20000, 0},   // Billetes: índices 5-9
};
const int TOTAL_DENOMINACIONES = sizeof(denominaciones) / sizeof(denominaciones[0]);
const int PRIMER_BILLETE = 5;

// Cada lector envía una cantidad fija de pulsos por denominación
struct Canal {
  int pulsos;
  int indice;
};

// Programación del CH-926: canales A-E. Si una moneda tiene emisiones muy
// distintas, se entrena el canal F con la otra emisión y se agrega {6, índice}.
const Canal CANALES_MONEDAS[] = {
  {1, 0},  // A: ₡10
  {2, 1},  // B: ₡25
  {3, 2},  // C: ₡50
  {4, 3},  // D: ₡100
  {5, 4},  // E: ₡500
};

// Lector de billetes: 1 pulso por cada ₡1000
const Canal CANALES_BILLETES[] = {
  {1, 5},   // ₡1000
  {2, 6},   // ₡2000
  {5, 7},   // ₡5000
  {10, 8},  // ₡10 000
  {20, 9},  // ₡20 000
};

// Tiempos de los lectores en modo de pulso "medio" (50 ms)
const unsigned long ANCHO_PULSO_MS = 50;
const unsigned long PULSO_MINIMO_MS = 15;   // Flancos más seguidos son rebote o ruido
const unsigned long FIN_PULSOS_MS = 300;    // Sin pulsos por este tiempo, la moneda o el billete terminó
const unsigned long ARRANQUE_LECTORES_MS = 1000;  // Al encender pueden soltar pulsos falsos

const unsigned long APERTURA_MS = 3000;  // El solenoide admite 5 s como máximo

Adafruit_SSD1306 pantalla(128, 64, &Wire, -1);

struct EventoPendiente {
  String id;
  String tipo;
  int valor;
  String fecha;
};

EventoPendiente cola[TAMANO_COLA];
int eventosEnCola = 0;
unsigned long numeroEvento = 0;
unsigned long ultimaSincronizacion = 0;
unsigned long esperaSincronizacion = SINCRONIZAR_MS;
uint32_t idArranque = 0;  // Distingue los eventos entre reinicios
bool lectoresActivos = false;

// Conteo de pulsos de una línea (monedero o lector de billetes)
struct LineaPulsos {
  const char *nombre;
  const Canal *canales;
  int totalCanales;
  volatile int contados;
  volatile unsigned long ultimoPulsoMs;
};

LineaPulsos monedero = {"monedero", CANALES_MONEDAS, 5, 0, 0};
LineaPulsos lectorBilletes = {"lector de billetes", CANALES_BILLETES, 5, 0, 0};

portMUX_TYPE candadoPulsos = portMUX_INITIALIZER_UNLOCKED;
volatile unsigned long ignorarPulsosHastaMs = 0;
volatile bool monedaDevuelta = false;

void IRAM_ATTR contarPulso(LineaPulsos &linea) {
  unsigned long ahora = millis();
  portENTER_CRITICAL_ISR(&candadoPulsos);
  if ((long)(ahora - ignorarPulsosHastaMs) >= 0 && ahora - linea.ultimoPulsoMs >= PULSO_MINIMO_MS) {
    linea.contados++;
    linea.ultimoPulsoMs = ahora;
  }
  portEXIT_CRITICAL_ISR(&candadoPulsos);
}

void IRAM_ATTR alPulsoMonedero() {
  contarPulso(monedero);
}

void IRAM_ATTR alPulsoBillete() {
  contarPulso(lectorBilletes);
}

void IRAM_ATTR alDevolverMoneda() {
  monedaDevuelta = true;
}

// Devuelve los pulsos de algo que ya terminó de pasar, o 0 si no hay
int leerPulsosTerminados(LineaPulsos &linea) {
  int pulsos = 0;
  portENTER_CRITICAL(&candadoPulsos);
  if (linea.contados > 0 && millis() - linea.ultimoPulsoMs >= FIN_PULSOS_MS) {
    pulsos = linea.contados;
    linea.contados = 0;
  }
  portEXIT_CRITICAL(&candadoPulsos);
  return pulsos;
}

// Devuelve el índice de la denominación, o -1 si ningún canal envía esos pulsos
int clasificar(const LineaPulsos &linea, int pulsos) {
  for (int i = 0; i < linea.totalCanales; i++) {
    if (linea.canales[i].pulsos == pulsos) {
      return linea.canales[i].indice;
    }
  }
  return -1;
}

long totalColones(int desde = 0, int hasta = TOTAL_DENOMINACIONES) {
  long total = 0;
  for (int i = desde; i < hasta; i++) {
    total += (long)denominaciones[i].valor * denominaciones[i].cantidad;
  }
  return total;
}

String conMiles(long valor) {
  String texto = String(valor);
  for (int i = texto.length() - 3; i > 0; i -= 3) {
    texto = texto.substring(0, i) + "." + texto.substring(i);
  }
  return texto;
}

void pitido(int frecuencia, int duracionMs) {
  long ciclos = (long)frecuencia * duracionMs / 1000;
  int medioPeriodo = 500000 / frecuencia;
  for (long i = 0; i < ciclos; i++) {
    digitalWrite(PIN_BUZZER, HIGH);
    delayMicroseconds(medioPeriodo);
    digitalWrite(PIN_BUZZER, LOW);
    delayMicroseconds(medioPeriodo);
  }
}

void mostrarReposo() {
  pantalla.clearDisplay();
  pantalla.setTextSize(1);
  pantalla.setCursor(0, 0);
  pantalla.print(lectoresActivos ? "ALCANCIA  colones" : "PAUSADA: sin nube");
  pantalla.setTextSize(2);
  pantalla.setCursor(0, 16);
  pantalla.print(conMiles(totalColones()));
  pantalla.setTextSize(1);
  pantalla.setCursor(0, 42);
  pantalla.print("Monedas:  " + conMiles(totalColones(0, PRIMER_BILLETE)));
  pantalla.setCursor(0, 54);
  pantalla.print("Billetes: " + conMiles(totalColones(PRIMER_BILLETE)));
  pantalla.display();
}

void mostrarMensaje(const String &titulo, const String &detalle) {
  pantalla.clearDisplay();
  pantalla.setTextSize(2);
  pantalla.setCursor(0, 8);
  pantalla.print(titulo);
  pantalla.setTextSize(1);
  pantalla.setCursor(0, 42);
  pantalla.print(detalle);
  pantalla.display();
}

bool nubeConfigurada() {
  return strlen(SUPABASE_URL) > 0;
}

// Enciende los lectores solo si queda espacio en la cola para registrar lo que entre
void actualizarLectores() {
  bool debenEstarActivos = eventosEnCola <= TAMANO_COLA - MARGEN_COLA;
  if (debenEstarActivos == lectoresActivos) {
    return;
  }
  lectoresActivos = debenEstarActivos;
  if (lectoresActivos) {
    ignorarPulsosHastaMs = millis() + ARRANQUE_LECTORES_MS;
  }
  digitalWrite(PIN_LECTORES_ACTIVOS, lectoresActivos ? HIGH : LOW);
  Serial.println(lectoresActivos ? "Lectores encendidos" : "Cola llena: lectores apagados");
  mostrarReposo();
}

// Devuelve la hora UTC en ISO 8601, o vacío si aún no se sincronizó el reloj
String fechaActual() {
  struct tm hora;
  if (!getLocalTime(&hora, 0)) {
    return "";
  }
  char texto[21];
  strftime(texto, sizeof(texto), "%Y-%m-%dT%H:%M:%SZ", &hora);
  return String(texto);
}

void enviarEvento(const char *tipo, int valor) {
  numeroEvento++;
  EventoPendiente evento = {
    String(idArranque, HEX) + "-" + String(numeroEvento), tipo, valor, fechaActual()
  };
  Serial.printf("{\"id\":\"%s\",\"tipo\":\"%s\",\"denominacion\":%d,\"total\":%ld}\n",
                evento.id.c_str(), tipo, valor, totalColones());

  if (!nubeConfigurada()) {
    return;
  }
  if (eventosEnCola >= TAMANO_COLA) {
    Serial.println("Cola llena: evento sin registrar en la nube");
    return;
  }
  cola[eventosEnCola++] = evento;
  if (esperaSincronizacion == SINCRONIZAR_MS) {
    ultimaSincronizacion = millis() - SINCRONIZAR_MS;  // Envía en la próxima vuelta
  }
  actualizarLectores();
}

void quitarDeCola(int cantidad) {
  for (int i = cantidad; i < eventosEnCola; i++) {
    cola[i - cantidad] = cola[i];
  }
  eventosEnCola -= cantidad;
}

void abrirCerradura();

// Envía eventos pendientes y recibe el saldo y las órdenes de la app
void sincronizar() {
  if (!nubeConfigurada() || WiFi.status() != WL_CONNECTED) {
    return;
  }

  int enviados = min(eventosEnCola, EVENTOS_POR_ENVIO);
  JsonDocument solicitud;
  solicitud["codigo"] = CODIGO_ALCANCIA;
  JsonArray eventos = solicitud["eventos"].to<JsonArray>();
  for (int i = 0; i < enviados; i++) {
    JsonObject evento = eventos.add<JsonObject>();
    evento["id"] = cola[i].id;
    evento["tipo"] = cola[i].tipo;
    if (cola[i].valor > 0) {
      evento["denominacion"] = cola[i].valor;
    }
    if (cola[i].fecha.length() > 0) {
      evento["ocurrido_en"] = cola[i].fecha;
    }
  }
  String cuerpo;
  serializeJson(solicitud, cuerpo);

  // Sin validar el certificado en el prototipo; la versión final debe fijar la CA
  WiFiClientSecure cliente;
  cliente.setInsecure();
  HTTPClient http;
  http.setTimeout(8000);
  http.begin(cliente, SUPABASE_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-clave-dispositivo", CLAVE_ALCANCIA);
  unsigned long inicioEnvio = millis();
  int estado = http.POST(cuerpo);
  Serial.printf("Nube respondio %d en %lu ms\n", estado, millis() - inicioEnvio);
  if (estado != 200) {
    char detalle[100] = "";
    cliente.lastError(detalle, sizeof(detalle));
    Serial.printf("Sin sincronizar (%d) %s. Eventos en cola: %d\n", estado, detalle, eventosEnCola);
    http.end();
    esperaSincronizacion = REINTENTO_MS;
    return;
  }

  JsonDocument respuesta;
  DeserializationError error = deserializeJson(respuesta, http.getString());
  http.end();
  if (error) {
    Serial.println("Respuesta de la nube ilegible");
    esperaSincronizacion = REINTENTO_MS;
    return;
  }

  esperaSincronizacion = SINCRONIZAR_MS;
  quitarDeCola(enviados);
  if (enviados > 0) {
    Serial.printf("Sincronizados: %d eventos\n", enviados);
  }
  actualizarLectores();
  if (eventosEnCola == 0) {
    // Con la cola vacía, la nube tiene la verdad: incluye los retiros hechos en la app
    for (int i = 0; i < TOTAL_DENOMINACIONES; i++) {
      denominaciones[i].cantidad = respuesta["conteo"][String(denominaciones[i].valor)] | 0;
    }
    mostrarReposo();
  }
  if (respuesta["abrir"] | false) {
    abrirCerradura();
  }
}

void conectarWifi() {
  if (!nubeConfigurada()) {
    return;
  }
  WiFi.begin(WIFI_SSID, WIFI_CLAVE, MODO_SIMULACION ? 6 : 0);
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < ESPERA_WIFI_MS) {
    delay(100);
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "WiFi conectado" : "Sin WiFi: se reintentara");
  configTime(0, 0, "pool.ntp.org");
}

void registrarPulsos(const LineaPulsos &linea, int pulsos) {
  Serial.printf("Pulsos del %s: %d\n", linea.nombre, pulsos);
  int indice = clasificar(linea, pulsos);
  if (indice < 0) {
    // Ya cayó a la alcancía pero no se sabe qué fue: hay que revisar la
    // programación del lector o el ruido en el cable de pulsos
    digitalWrite(PIN_LED_ERROR, HIGH);
    mostrarMensaje("Revisar", String(pulsos) + " pulsos sin canal");
    pitido(300, 300);
    delay(700);
    digitalWrite(PIN_LED_ERROR, LOW);
    mostrarReposo();
    return;
  }

  denominaciones[indice].cantidad++;
  digitalWrite(PIN_LED_OK, HIGH);
  mostrarMensaje("+" + conMiles(denominaciones[indice].valor), "Total: " + conMiles(totalColones()));
  pitido(1200, 80);
  pitido(1800, 120);
  delay(300);
  digitalWrite(PIN_LED_OK, LOW);
  enviarEvento("deposito", denominaciones[indice].valor);
  mostrarReposo();
}

void registrarDevolucion() {
  digitalWrite(PIN_LED_ERROR, HIGH);
  mostrarMensaje("Devuelta", "No reconocida");
  pitido(300, 300);
  delay(700);
  digitalWrite(PIN_LED_ERROR, LOW);
  enviarEvento("rechazo", 0);
  mostrarReposo();
}

void abrirCerradura() {
  mostrarMensaje("Abierta", "Retira lo registrado");
  digitalWrite(PIN_RELE, HIGH);
  delay(APERTURA_MS);
  digitalWrite(PIN_RELE, LOW);
  enviarEvento("apertura", 0);
  mostrarReposo();
}

// Imita a un lector: el pin pasa a LOW durante cada pulso
void simularLector(int pinSalida, int pulsos) {
  if (!lectoresActivos) {
    registrarDevolucion();  // Apagado, el lector deja salir la moneda o el billete por la devolución
    return;
  }
  for (int i = 0; i < pulsos; i++) {
    digitalWrite(pinSalida, LOW);
    delay(ANCHO_PULSO_MS);
    digitalWrite(pinSalida, HIGH);
    delay(ANCHO_PULSO_MS);
  }
}

int pulsosDe(const Canal *canales, int totalCanales, int indice) {
  for (int i = 0; i < totalCanales; i++) {
    if (canales[i].indice == indice) {
      return canales[i].pulsos;
    }
  }
  return 0;
}

bool botonPresionado(int pin) {
  if (digitalRead(pin) == HIGH) {
    return false;
  }
  delay(30);
  while (digitalRead(pin) == LOW) {
    delay(5);
  }
  return true;
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_PULSOS_MONEDAS, INPUT_PULLUP);
  pinMode(PIN_PULSOS_BILLETES, INPUT);  // El GPIO 39 no tiene pull-up: lo da el optoacoplador o el GPIO 2
  pinMode(PIN_DEVOLUCION, INPUT);       // El GPIO 34 no tiene pull-up; el FC-51 maneja la línea
  pinMode(PIN_LECTORES_ACTIVOS, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_RELE, OUTPUT);
  pinMode(PIN_LED_OK, OUTPUT);
  pinMode(PIN_LED_ERROR, OUTPUT);

  if (MODO_SIMULACION) {
    pinMode(PIN_SIM_MONEDERO, OUTPUT);
    digitalWrite(PIN_SIM_MONEDERO, HIGH);
    pinMode(PIN_SIM_BILLETES, OUTPUT);
    digitalWrite(PIN_SIM_BILLETES, HIGH);
    for (int pin : PINES_MONEDA) {
      pinMode(pin, INPUT_PULLUP);
    }
    for (int pin : PINES_BILLETE) {
      pinMode(pin, pin == 35 ? INPUT : INPUT_PULLUP);
    }
    pinMode(PIN_OBJETO_RARO, INPUT_PULLUP);
  } else {
    attachInterrupt(digitalPinToInterrupt(PIN_DEVOLUCION), alDevolverMoneda, FALLING);
  }
  attachInterrupt(digitalPinToInterrupt(PIN_PULSOS_MONEDAS), alPulsoMonedero, FALLING);
  attachInterrupt(digitalPinToInterrupt(PIN_PULSOS_BILLETES), alPulsoBillete, FALLING);

  pantalla.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  pantalla.setTextColor(SSD1306_WHITE);

  idArranque = esp_random();
  actualizarLectores();
  conectarWifi();
  Serial.println("Lista. Echa una moneda o un billete.");
}

void loop() {
  if (MODO_SIMULACION) {
    for (int i = 0; i < PRIMER_BILLETE; i++) {
      if (botonPresionado(PINES_MONEDA[i])) {
        simularLector(PIN_SIM_MONEDERO, pulsosDe(CANALES_MONEDAS, 5, i));
      }
    }
    for (int i = PRIMER_BILLETE; i < TOTAL_DENOMINACIONES; i++) {
      if (botonPresionado(PINES_BILLETE[i - PRIMER_BILLETE])) {
        simularLector(PIN_SIM_BILLETES, pulsosDe(CANALES_BILLETES, 5, i));
      }
    }
    if (botonPresionado(PIN_OBJETO_RARO)) {
      registrarDevolucion();
    }
  } else if (monedaDevuelta) {
    monedaDevuelta = false;
    registrarDevolucion();
  }

  int pulsos = leerPulsosTerminados(monedero);
  if (pulsos > 0) {
    registrarPulsos(monedero, pulsos);
  }
  pulsos = leerPulsosTerminados(lectorBilletes);
  if (pulsos > 0) {
    registrarPulsos(lectorBilletes, pulsos);
  }

  if (millis() - ultimaSincronizacion >= esperaSincronizacion) {
    sincronizar();
    ultimaSincronizacion = millis();  // Se cuenta desde el final: un envío lento no encadena otro
  }

  delay(10);  // Acelera la simulación en Wokwi
}
