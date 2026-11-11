/*
 * Alcancía inteligente de colones - prototipo para Wokwi
 *
 * Flujo: entra una moneda -> el monedero programable (CH-926) la reconoce y
 * la deja caer a la alcancía -> envía un tren de pulsos según el canal -> el
 * ESP32 cuenta los pulsos y sabe qué moneda fue -> la pantalla y el sonido
 * confirman -> se genera el evento que irá a Supabase.
 *
 * El monedero se entrena con monedas reales de varios años de acuñación, así
 * que las diferencias de peso y aleación entre emisiones las resuelve él. Lo
 * que no reconoce lo devuelve por su salida de rechazo, donde un sensor IR
 * avisa al ESP32.
 *
 * Wokwi no tiene monedero. Con MODO_SIMULACION = true cada botón hace de
 * monedero: el GPIO 17 genera los mismos pulsos que el CH-926 y un cable los
 * lleva al GPIO 16, así que el conteo de pulsos es el mismo código que en el
 * hardware real. Con false, los pulsos llegan del monedero.
 *
 * Con SUPABASE_URL vacío funciona sin conexión. Al configurarlo, los eventos
 * entran a una cola y se envían a la Edge Function "dispositivo"; si no hay
 * red se reintentan, y el id de cada evento evita duplicados en la nube.
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
// Con la cola casi llena se apaga el monedero: sin poder registrarla, mejor
// que la moneda salga por la devolución a que se cuente mal en la nube
const int MARGEN_COLA = 2;

// Conexiones
const int PIN_PULSOS = 16;           // Salida COIN del CH-926, por optoacoplador: LOW en cada pulso
const int PIN_MONEDERO_ACTIVO = 18;  // Relé que da los 12 V al monedero
const int PIN_BUZZER = 19;
const int PIN_RELE = 23;             // Cerradura solenoide
const int PIN_LED_OK = 13;
const int PIN_LED_ERROR = 5;
const int PIN_DEVOLUCION = 34;  // Solo hardware real: FC-51 en la salida de rechazo, LOW al pasar moneda
const int PIN_ABRIR = 14;       // En la versión final esta orden viene de la app

// Solo simulación
const int PIN_SIM_MONEDERO = 17;  // Genera los pulsos; en Wokwi va cableado al GPIO 16
const int PIN_OBJETO_RARO = 4;    // Hace de sensor de la devolución
const int PINES_MONEDA[] = {32, 33, 25, 26, 27};

// Monedas en circulación
struct Moneda {
  int valor;
  int cantidad;
};

Moneda monedas[] = {
  {10, 0},
  {25, 0},
  {50, 0},
  {100, 0},
  {500, 0},
};
const int TOTAL_DENOMINACIONES = sizeof(monedas) / sizeof(monedas[0]);

// Programación del CH-926: cada canal (A-F) se entrena con una moneda y
// envía una cantidad fija de pulsos. Si una denominación tiene emisiones muy
// distintas, se entrena el canal F con la otra emisión y se agrega {6, índice}.
struct Canal {
  int pulsos;
  int indiceMoneda;
};

const Canal CANALES[] = {
  {1, 0},  // A: ₡10
  {2, 1},  // B: ₡25
  {3, 2},  // C: ₡50
  {4, 3},  // D: ₡100
  {5, 4},  // E: ₡500
};
const int TOTAL_CANALES = sizeof(CANALES) / sizeof(CANALES[0]);

// Tiempos del monedero en modo de pulso "medio" (50 ms)
const unsigned long ANCHO_PULSO_MS = 50;
const unsigned long PULSO_MINIMO_MS = 15;   // Flancos más seguidos son rebote o ruido
const unsigned long FIN_MONEDA_MS = 300;    // Sin pulsos por este tiempo, la moneda terminó
const unsigned long ARRANQUE_MONEDERO_MS = 1000;  // Al encender puede soltar pulsos falsos

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
bool monederoActivo = false;

portMUX_TYPE candadoPulsos = portMUX_INITIALIZER_UNLOCKED;
volatile int pulsosContados = 0;
volatile unsigned long ultimoPulsoMs = 0;
volatile unsigned long ignorarPulsosHastaMs = 0;
volatile bool monedaDevuelta = false;

void IRAM_ATTR alRecibirPulso() {
  unsigned long ahora = millis();
  portENTER_CRITICAL_ISR(&candadoPulsos);
  if ((long)(ahora - ignorarPulsosHastaMs) >= 0 && ahora - ultimoPulsoMs >= PULSO_MINIMO_MS) {
    pulsosContados++;
    ultimoPulsoMs = ahora;
  }
  portEXIT_CRITICAL_ISR(&candadoPulsos);
}

void IRAM_ATTR alDevolverMoneda() {
  monedaDevuelta = true;
}

// Devuelve los pulsos de una moneda que ya terminó de pasar, o 0 si no hay
int leerMonedaTerminada() {
  int pulsos = 0;
  portENTER_CRITICAL(&candadoPulsos);
  if (pulsosContados > 0 && millis() - ultimoPulsoMs >= FIN_MONEDA_MS) {
    pulsos = pulsosContados;
    pulsosContados = 0;
  }
  portEXIT_CRITICAL(&candadoPulsos);
  return pulsos;
}

// Devuelve el índice de la moneda, o -1 si ningún canal envía esos pulsos
int clasificar(int pulsos) {
  for (int i = 0; i < TOTAL_CANALES; i++) {
    if (CANALES[i].pulsos == pulsos) {
      return CANALES[i].indiceMoneda;
    }
  }
  return -1;
}

long totalColones() {
  long total = 0;
  for (int i = 0; i < TOTAL_DENOMINACIONES; i++) {
    total += (long)monedas[i].valor * monedas[i].cantidad;
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
  pantalla.print(monederoActivo ? "ALCANCIA  colones" : "PAUSADA: sin nube");
  pantalla.setTextSize(2);
  pantalla.setCursor(0, 16);
  pantalla.print(conMiles(totalColones()));
  pantalla.setTextSize(1);
  pantalla.setCursor(0, 42);
  pantalla.printf("10:%d 25:%d 50:%d", monedas[0].cantidad, monedas[1].cantidad, monedas[2].cantidad);
  pantalla.setCursor(0, 54);
  pantalla.printf("100:%d 500:%d", monedas[3].cantidad, monedas[4].cantidad);
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

// Enciende el monedero solo si queda espacio en la cola para registrar monedas
void actualizarMonedero() {
  bool debeEstarActivo = eventosEnCola <= TAMANO_COLA - MARGEN_COLA;
  if (debeEstarActivo == monederoActivo) {
    return;
  }
  monederoActivo = debeEstarActivo;
  if (monederoActivo) {
    ignorarPulsosHastaMs = millis() + ARRANQUE_MONEDERO_MS;
  }
  digitalWrite(PIN_MONEDERO_ACTIVO, monederoActivo ? HIGH : LOW);
  Serial.println(monederoActivo ? "Monedero encendido" : "Cola llena: monedero apagado");
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
  actualizarMonedero();
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
  actualizarMonedero();
  if (eventosEnCola == 0) {
    for (int i = 0; i < TOTAL_DENOMINACIONES; i++) {
      monedas[i].cantidad = respuesta["conteo"][String(monedas[i].valor)] | 0;
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

void registrarMoneda(int pulsos) {
  Serial.printf("Pulsos recibidos: %d\n", pulsos);
  int indice = clasificar(pulsos);
  if (indice < 0) {
    // La moneda ya cayó a la alcancía pero no se sabe cuál fue: hay que revisar
    // la programación del monedero o el ruido en el cable de pulsos
    digitalWrite(PIN_LED_ERROR, HIGH);
    mostrarMensaje("Revisar", String(pulsos) + " pulsos sin canal");
    pitido(300, 300);
    delay(700);
    digitalWrite(PIN_LED_ERROR, LOW);
    mostrarReposo();
    return;
  }

  monedas[indice].cantidad++;
  digitalWrite(PIN_LED_OK, HIGH);
  mostrarMensaje("+" + String(monedas[indice].valor), "Total: " + conMiles(totalColones()));
  pitido(1200, 80);
  pitido(1800, 120);
  delay(300);
  digitalWrite(PIN_LED_OK, LOW);
  enviarEvento("deposito", monedas[indice].valor);
  mostrarReposo();
}

void registrarDevolucion() {
  digitalWrite(PIN_LED_ERROR, HIGH);
  mostrarMensaje("Devuelta", "Moneda no reconocida");
  pitido(300, 300);
  delay(700);
  digitalWrite(PIN_LED_ERROR, LOW);
  enviarEvento("rechazo", 0);
  mostrarReposo();
}

void abrirCerradura() {
  mostrarMensaje("Abierta", "Retira y registra en la app");
  digitalWrite(PIN_RELE, HIGH);
  delay(APERTURA_MS);
  digitalWrite(PIN_RELE, LOW);
  enviarEvento("apertura", 0);
  mostrarReposo();
}

// Imita al CH-926: el pin pasa a LOW durante cada pulso
void simularMonedero(int pulsos) {
  if (!monederoActivo) {
    registrarDevolucion();  // Apagado, el monedero deja salir la moneda por la devolución
    return;
  }
  for (int i = 0; i < pulsos; i++) {
    digitalWrite(PIN_SIM_MONEDERO, LOW);
    delay(ANCHO_PULSO_MS);
    digitalWrite(PIN_SIM_MONEDERO, HIGH);
    delay(ANCHO_PULSO_MS);
  }
}

int pulsosDeMoneda(int indiceMoneda) {
  for (int i = 0; i < TOTAL_CANALES; i++) {
    if (CANALES[i].indiceMoneda == indiceMoneda) {
      return CANALES[i].pulsos;
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

  pinMode(PIN_PULSOS, INPUT_PULLUP);
  pinMode(PIN_DEVOLUCION, INPUT);  // El GPIO 34 no tiene pull-up; el FC-51 maneja la línea
  pinMode(PIN_ABRIR, INPUT_PULLUP);
  pinMode(PIN_MONEDERO_ACTIVO, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_RELE, OUTPUT);
  pinMode(PIN_LED_OK, OUTPUT);
  pinMode(PIN_LED_ERROR, OUTPUT);

  if (MODO_SIMULACION) {
    pinMode(PIN_SIM_MONEDERO, OUTPUT);
    digitalWrite(PIN_SIM_MONEDERO, HIGH);
    for (int pin : PINES_MONEDA) {
      pinMode(pin, INPUT_PULLUP);
    }
    pinMode(PIN_OBJETO_RARO, INPUT_PULLUP);
  } else {
    attachInterrupt(digitalPinToInterrupt(PIN_DEVOLUCION), alDevolverMoneda, FALLING);
  }
  attachInterrupt(digitalPinToInterrupt(PIN_PULSOS), alRecibirPulso, FALLING);

  pantalla.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  pantalla.setTextColor(SSD1306_WHITE);

  idArranque = esp_random();
  actualizarMonedero();
  conectarWifi();
  Serial.println("Lista. Echa una moneda.");
}

void loop() {
  if (MODO_SIMULACION) {
    for (int i = 0; i < TOTAL_DENOMINACIONES; i++) {
      if (botonPresionado(PINES_MONEDA[i])) {
        simularMonedero(pulsosDeMoneda(i));
      }
    }
    if (botonPresionado(PIN_OBJETO_RARO)) {
      registrarDevolucion();
    }
  } else if (monedaDevuelta) {
    monedaDevuelta = false;
    registrarDevolucion();
  }

  int pulsos = leerMonedaTerminada();
  if (pulsos > 0) {
    registrarMoneda(pulsos);
  }

  if (botonPresionado(PIN_ABRIR)) {
    abrirCerradura();
  }

  if (millis() - ultimaSincronizacion >= esperaSincronizacion) {
    sincronizar();
    ultimaSincronizacion = millis();  // Se cuenta desde el final: un envío lento no encadena otro
  }

  delay(10);  // Acelera la simulación en Wokwi
}
