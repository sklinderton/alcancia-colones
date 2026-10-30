/*
 * Alcancía inteligente de colones - prototipo para Wokwi
 *
 * Flujo: entra una moneda -> se pesa -> se clasifica -> la pantalla y el
 * sonido confirman -> el servo inclina la bandeja hacia la alcancía o hacia
 * la devolución -> se genera el evento que irá a Supabase.
 *
 * En Wokwi la celda de carga simulada no distingue 1 g, así que con
 * MODO_SIMULACION = true cada botón equivale a "entró esta moneda" y genera
 * su peso con ruido. Con false se usan el sensor IR y el HX711 reales.
 *
 * Con SUPABASE_URL vacío funciona sin conexión. Al configurarlo, los eventos
 * entran a una cola y se envían a la Edge Function "dispositivo"; si no hay
 * red se reintentan, y el id de cada evento evita duplicados en la nube.
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>
#include <HX711.h>
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

// Conexiones
const int PIN_HX711_DT = 16;
const int PIN_HX711_SCK = 17;
const int PIN_SERVO = 18;
const int PIN_BUZZER = 19;
const int PIN_RELE = 23;
const int PIN_LED_OK = 13;
const int PIN_LED_ERROR = 5;
const int PIN_IR = 34;  // Solo hardware real: FC-51 en LOW al detectar moneda
const int PIN_ABRIR = 14;  // En la versión final esta orden viene de la app

// Botones de simulación
const int PIN_OBJETO_RARO = 4;
const int PINES_MONEDA[] = {32, 33, 25, 26, 27};

// Monedas en circulación, pesos oficiales del BCCR
struct Moneda {
  int valor;
  float pesoGramos;
  int cantidad;
};

Moneda monedas[] = {
  {10, 2.43, 0},
  {25, 4.30, 0},
  {50, 5.54, 0},
  {100, 8.30, 0},
  {500, 10.50, 0},
};
const int TOTAL_DENOMINACIONES = sizeof(monedas) / sizeof(monedas[0]);

// La menor diferencia es 1,24 g (₡25 y ₡50). Con 0,50 g queda una franja
// muerta entre ambas: ante la duda la moneda se devuelve, no se cuenta mal.
const float TOLERANCIA_GRAMOS = 0.50;
const float PESO_OBJETO_RARO = 7.00;
const float RUIDO_SIMULADO_GRAMOS = 0.12;
const float FACTOR_CALIBRACION = 420.0;  // Se ajusta con la celda real

// Posiciones del servo que inclina la bandeja
const int ANGULO_DEVOLVER = 20;
const int ANGULO_REPOSO = 90;
const int ANGULO_ALCANCIA = 160;

const unsigned long APERTURA_MS = 3000;  // El solenoide admite 5 s como máximo

Adafruit_SSD1306 pantalla(128, 64, &Wire, -1);
Servo bandeja;
HX711 balanza;

struct EventoPendiente {
  String id;
  String tipo;
  int valor;
  float peso;
  String fecha;
};

EventoPendiente cola[TAMANO_COLA];
int eventosEnCola = 0;
unsigned long numeroEvento = 0;
unsigned long ultimaSincronizacion = 0;
unsigned long esperaSincronizacion = SINCRONIZAR_MS;
uint32_t idArranque = 0;  // Distingue los eventos entre reinicios
volatile bool monedaDetectada = false;

void IRAM_ATTR alDetectarMoneda() {
  monedaDetectada = true;
}

// Devuelve el índice de la moneda, o -1 si no coincide con ninguna
int clasificar(float peso) {
  for (int i = 0; i < TOTAL_DENOMINACIONES; i++) {
    if (fabs(peso - monedas[i].pesoGramos) <= TOLERANCIA_GRAMOS) {
      return i;
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

// Número aleatorio con distribución normal (Box-Muller)
float ruidoNormal(float desviacion) {
  float u1 = (random(1, 10000)) / 10000.0;
  float u2 = (random(1, 10000)) / 10000.0;
  return desviacion * sqrt(-2.0 * log(u1)) * cos(2.0 * PI * u2);
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
  pantalla.print("ALCANCIA  colones");
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

void inclinarBandeja(int angulo) {
  bandeja.write(angulo);
  delay(500);
  bandeja.write(ANGULO_REPOSO);
  delay(300);
}

bool nubeConfigurada() {
  return strlen(SUPABASE_URL) > 0;
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

void enviarEvento(const char *tipo, int valor, float peso) {
  numeroEvento++;
  EventoPendiente evento = {
    String(idArranque, HEX) + "-" + String(numeroEvento), tipo, valor, peso, fechaActual()
  };
  Serial.printf("{\"id\":\"%s\",\"tipo\":\"%s\",\"denominacion\":%d,\"peso_g\":%.2f,\"total\":%ld}\n",
                evento.id.c_str(), tipo, valor, peso, totalColones());

  if (nubeConfigurada()) {
    cola[eventosEnCola++] = evento;
    if (esperaSincronizacion == SINCRONIZAR_MS) {
      ultimaSincronizacion = millis() - SINCRONIZAR_MS;  // Envía en la próxima vuelta
    }
  }
}

void quitarDeCola(int cantidad) {
  for (int i = cantidad; i < eventosEnCola; i++) {
    cola[i - cantidad] = cola[i];
  }
  eventosEnCola -= cantidad;
}

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
    if (cola[i].peso > 0) {
      evento["peso_g"] = cola[i].peso;
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

void aceptarMoneda(int indice, float peso) {
  monedas[indice].cantidad++;
  digitalWrite(PIN_LED_OK, HIGH);
  mostrarMensaje("+" + String(monedas[indice].valor), "Total: " + conMiles(totalColones()));
  pitido(1200, 80);
  pitido(1800, 120);
  inclinarBandeja(ANGULO_ALCANCIA);
  digitalWrite(PIN_LED_OK, LOW);
  enviarEvento("deposito", monedas[indice].valor, peso);
}

void rechazarObjeto(float peso) {
  digitalWrite(PIN_LED_ERROR, HIGH);
  mostrarMensaje("Rechazada", "Peso: " + String(peso, 2) + " g");
  pitido(300, 300);
  inclinarBandeja(ANGULO_DEVOLVER);
  delay(700);
  digitalWrite(PIN_LED_ERROR, LOW);
  enviarEvento("rechazo", 0, peso);
}

void procesarPeso(float peso) {
  Serial.printf("Peso medido: %.2f g\n", peso);
  if (eventosEnCola >= TAMANO_COLA) {
    // Sin espacio para registrarla, la moneda se devuelve para no perder el conteo
    mostrarMensaje("Sin nube", "Intenta en un momento");
    inclinarBandeja(ANGULO_DEVOLVER);
    mostrarReposo();
    return;
  }

  int indice = clasificar(peso);
  if (indice >= 0) {
    aceptarMoneda(indice, peso);
  } else {
    rechazarObjeto(peso);
  }
  mostrarReposo();
}

float leerPesoReal() {
  delay(400);  // Espera a que la moneda deje de vibrar en la bandeja
  return balanza.get_units(10);
}

void abrirCerradura() {
  mostrarMensaje("Abierta", "Retira y registra en la app");
  digitalWrite(PIN_RELE, HIGH);
  delay(APERTURA_MS);
  digitalWrite(PIN_RELE, LOW);
  enviarEvento("apertura", 0, 0);
  mostrarReposo();
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

  for (int pin : PINES_MONEDA) {
    pinMode(pin, INPUT_PULLUP);
  }
  pinMode(PIN_OBJETO_RARO, INPUT_PULLUP);
  pinMode(PIN_ABRIR, INPUT_PULLUP);
  pinMode(PIN_IR, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_RELE, OUTPUT);
  pinMode(PIN_LED_OK, OUTPUT);
  pinMode(PIN_LED_ERROR, OUTPUT);

  pantalla.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  pantalla.setTextColor(SSD1306_WHITE);

  bandeja.attach(PIN_SERVO, 500, 2400);
  bandeja.write(ANGULO_REPOSO);

  balanza.begin(PIN_HX711_DT, PIN_HX711_SCK);
  if (!MODO_SIMULACION) {
    balanza.set_scale(FACTOR_CALIBRACION);
    balanza.tare();
    attachInterrupt(digitalPinToInterrupt(PIN_IR), alDetectarMoneda, FALLING);
  }

  idArranque = esp_random();
  randomSeed(idArranque);
  mostrarReposo();
  conectarWifi();
  Serial.println("Lista. Presiona un boton de moneda.");
}

void loop() {
  if (MODO_SIMULACION) {
    for (int i = 0; i < TOTAL_DENOMINACIONES; i++) {
      if (botonPresionado(PINES_MONEDA[i])) {
        procesarPeso(monedas[i].pesoGramos + ruidoNormal(RUIDO_SIMULADO_GRAMOS));
      }
    }
    if (botonPresionado(PIN_OBJETO_RARO)) {
      procesarPeso(PESO_OBJETO_RARO + ruidoNormal(RUIDO_SIMULADO_GRAMOS));
    }
  } else if (monedaDetectada) {
    procesarPeso(leerPesoReal());
    monedaDetectada = false;
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
