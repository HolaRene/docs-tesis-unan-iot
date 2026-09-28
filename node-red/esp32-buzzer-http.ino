/**
 * ESP32 — BUZZER / LED CONTROLADO POR LA WEB (sin Node-RED, sin MQTT)
 * ===================================================================
 *
 * El ESP32 pregunta directamente a la API si hay órdenes para él, las ejecuta
 * y confirma el resultado. **No hace falta Node-RED ni broker MQTT.**
 *
 * ────────────────────────────────────────────────────────────────────
 * CÓMO FUNCIONA (y por qué pregunta en bucle)
 * ────────────────────────────────────────────────────────────────────
 * HTTP es petición→respuesta: el servidor NO puede avisar al ESP32 por su
 * cuenta. Por eso el ESP32 pregunta cada 2 segundos:
 *
 *     ESP32                          API
 *       │                             │
 *       │ 1. GET pendientes ...       │
 *       ├────────────────────────────►│
 *       │◄────────────────────────────┤  [ {comando: "ON"} ]
 *       │                             │
 *       │ 2. enciende el buzzer       │
 *       │                             │
 *       │ 3. PATCH ejecutado          │
 *       ├────────────────────────────►│  (la web lo ve al instante)
 *
 * La orden tarda como máximo `INTERVALO_CONSULTA_MS` en llegar. Para un LED o
 * un buzzer es de sobra.
 *
 * ────────────────────────────────────────────────────────────────────
 * IMPORTANTE: usa SU PROPIO filtro
 * ────────────────────────────────────────────────────────────────────
 * La petición incluye `?identificador=ESP32-BUZZER`, así que este ESP32 solo
 * recibe las órdenes dirigidas a sus actuadores. Si no se filtrara, recibiría
 * (y ejecutaría) comandos destinados a otros equipos de la instalación.
 *
 * ────────────────────────────────────────────────────────────────────
 * CONEXIONES
 * ────────────────────────────────────────────────────────────────────
 *   Buzzer activo  → GPIO 25 (y GND)
 *   LED            → GPIO 26 + resistencia de 220 Ω a GND
 *
 *   ⚠️ Un buzzer activo suena solo con darle tensión. Uno PASIVO necesita una
 *      señal PWM; este sketch asume un buzzer ACTIVO.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN — AJUSTA ESTO
// ─────────────────────────────────────────────────────────────

// WiFi
const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASS = "TU_PASSWORD";

/**
 * URL de la API.
 *
 * ⚠️ NO uses `localhost`: dentro del ESP32 eso apunta al propio ESP32.
 *    Pon la IP local del ordenador donde corre la API.
 *
 *    En Linux/macOS:  hostname -I   |   En Windows: ipconfig
 *
 *    El ESP32 y el PC deben estar en la MISMA red WiFi.
 */
const char* API_URL = "http://192.168.1.100:4000/api/v1";

/** API Key con permiso `comandos:enviar` (la creas en la web). */
const char* API_KEY = "flx_TU_CLAVE_AQUI";

/**
 * Identificador de ESTE dispositivo (columna `identificador` en la BD).
 *
 * Es lo que hace que solo recibas tus propios comandos.
 */
const char* DISPOSITIVO = "ESP32-BUZZER";

/** Código del actuador que controla este sketch. */
const char* ACTUADOR = "BUZZER-1";

// Pines
const int PIN_BUZZER = 25;
const int PIN_LED    = 26;

/** Cada cuánto se pregunta a la API (ms). Menos = más reactivo. */
const unsigned long INTERVALO_CONSULTA_MS = 2000;

// ─────────────────────────────────────────────────────────────
// ESTADO
// ─────────────────────────────────────────────────────────────
bool buzzerEncendido = false;
bool ledEncendido = false;

unsigned long ultimaConsulta = 0;
unsigned long ultimoIntentoWifi = 0;
unsigned long ultimaPublicacionEstado = 0;

// ─────────────────────────────────────────────────────────────
// ACTUADORES
// ─────────────────────────────────────────────────────────────

/**
 * Aplica una orden a la salida correspondiente.
 *
 * Se comparan los comandos en mayúsculas para aceptar variantes (on, ON, On…).
 */
void aplicarComando(const String& comando) {
  String c = comando;
  c.toUpperCase();

  bool encender = (c == "ON" || c == "1" || c == "TRUE" || c == "ENCENDER");

  // Cada actuador se controla con su propio pin.
  if (String(ACTUADOR) == "BUZZER-1") {
    buzzerEncendido = encender;
    digitalWrite(PIN_BUZZER, encender ? HIGH : LOW);
    Serial.printf("[ACTUADOR] Buzzer %s\n", encender ? "ENCENDIDO" : "APAGADO");
  } else if (String(ACTUADOR) == "LED-1") {
    ledEncendido = encender;
    digitalWrite(PIN_LED, encender ? HIGH : LOW);
    Serial.printf("[ACTUADOR] LED %s\n", encender ? "ENCENDIDO" : "APAGADO");
  } else {
    Serial.printf("[ACTUADOR] Codigo desconocido: %s\n", ACTUADOR);
  }
}

/** Estado actual como texto ('on'/'off'), para informar a la API. */
const char* estadoActual() {
  if (String(ACTUADOR) == "BUZZER-1") return buzzerEncendido ? "on" : "off";
  if (String(ACTUADOR) == "LED-1") return ledEncendido ? "on" : "off";
  return "off";
}

// ─────────────────────────────────────────────────────────────
// COMUNICACIÓN CON LA API
// ─────────────────────────────────────────────────────────────

/**
 * Pregunta a la API si hay órdenes pendientes para este dispositivo.
 *
 * Devuelve el array de comandos (vacío si no hay o si falla la petición).
 */
void consultarComandos() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(API_URL) + "/iot/comandos/pendientes?identificador=" + DISPOSITIVO;

  http.begin(url);
  http.addHeader("X-API-Key", API_KEY);
  // Sin esto, si el servidor no responde el ESP32 se queda colgado.
  http.setTimeout(5000);

  int codigo = http.GET();

  if (codigo != 200) {
    Serial.printf("[API] GET pendientes -> HTTP %d\n", codigo);
    if (codigo == 401) Serial.println("      API Key incorrecta o sin permiso comandos:enviar");
    http.end();
    return;
  }

  String cuerpo = http.getString();
  http.end();

  // El JSON puede ser grande si hay varios comandos; se filtra al parsear.
  DynamicJsonDocument filtro(2048);
  DynamicJsonDocument doc(8192);

  DeserializationError error = deserializeJson(
    doc, cuerpo,
    DeserializationOption::Filter(filtro)
  );

  if (error) {
    Serial.printf("[API] JSON invalido: %s\n", error.c_str());
    return;
  }

  JsonArray comandos = doc["datos"].as<JsonArray>();

  if (comandos.size() == 0) return;  // lo normal: no hay nada

  Serial.printf("[API] %d comando(s) pendiente(s)\n", comandos.size());

  for (JsonVariant cmd : comandos) {
    const char* comando = cmd["comando"] | "";
    const char* id      = cmd["id"] | "";
    const char* codigo  = cmd["actuador_codigo"] | "";

    // Comprobación de seguridad: aunque la API ya filtra, se verifica que la
    // orden sea para este actuador antes de actuar.
    if (String(codigo) != String(ACTUADOR)) {
      Serial.printf("[API] Ignorado: es para '%s'\n", codigo);
      continue;
    }

    aplicarComando(String(comando));

    // Confirmar la ejecución. A partir de aquí la web muestra "ejecutado".
    confirmarEjecucion(String(id), true);
  }
}

/**
 * Informa a la API del resultado de la orden.
 *
 * `estado_actuador` refleja el estado REAL, que es lo que verá la web.
 */
void confirmarEjecucion(const String& comandoId, bool exito) {
  if (comandoId.length() == 0) return;
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(API_URL) + "/iot/comandos/" + comandoId;

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.setTimeout(5000);

  StaticJsonDocument<256> doc;
  doc["estado"] = exito ? "ejecutado" : "fallido";
  doc["estado_actuador"] = estadoActual();

  JsonObject resp = doc.createNestedObject("respuesta");
  resp["origen"] = "esp32";
  resp["rssi"] = WiFi.RSSI();
  resp["uptime"] = millis() / 1000;

  String cuerpo;
  serializeJson(doc, cuerpo);

  int codigo = http.PATCH(cuerpo);
  Serial.printf("[API] Confirmacion -> HTTP %d\n", codigo);

  http.end();
}

/**
 * Heartbeat: avisa de que este dispositivo sigue vivo.
 *
 * Sin esto, el watchdog de la plataforma lo marcaría como `offline` al cabo de
 * unos minutos y la web lo mostraría desconectado.
 */
void publicarEstado() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(API_URL) + "/iot/dispositivos/" + DISPOSITIVO + "/estado";

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.setTimeout(5000);

  StaticJsonDocument<256> doc;
  doc["estado"] = "online";

  JsonObject meta = doc.createNestedObject("metadatos");
  meta["rssi"] = WiFi.RSSI();
  meta["uptime_s"] = millis() / 1000;
  meta["actuador"] = ACTUADOR;
  meta["estado_actuador"] = estadoActual();

  String cuerpo;
  serializeJson(doc, cuerpo);

  int codigo = http.POST(cuerpo);
  Serial.printf("[API] Heartbeat -> HTTP %d\n", codigo);

  http.end();
}

// ─────────────────────────────────────────────────────────────
// WIFI
// ─────────────────────────────────────────────────────────────
void conectarWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("[WiFi] Conectando a %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ─────────────────────────────────────────────────────────────
// SETUP / LOOP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println("\n=== ESP32: buzzer/LED por HTTP (sin Node-RED) ===");
  Serial.printf("Dispositivo : %s\n", DISPOSITIVO);
  Serial.printf("Actuador    : %s\n", ACTUADOR);
  Serial.printf("API         : %s\n", API_URL);
  Serial.printf("Consulta    : cada %lu ms\n", INTERVALO_CONSULTA_MS);

  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED, OUTPUT);

  // Arrancar apagado evita que el buzzer suene al reiniciar.
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED, LOW);

  conectarWifi();
}

void loop() {
  // Reconexión de WiFi, como máximo cada 10 s para no bloquear el loop.
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - ultimoIntentoWifi > 10000) {
      ultimoIntentoWifi = millis();
      conectarWifi();
    }
    return;
  }

  // 1) Preguntar por comandos.
  if (millis() - ultimaConsulta > INTERVALO_CONSULTA_MS) {
    ultimaConsulta = millis();
    consultarComandos();
  }

  // 2) Heartbeat cada 60 s (por debajo del watchdog de 5 min).
  if (millis() - ultimaPublicacionEstado > 60000) {
    ultimaPublicacionEstado = millis();
    publicarEstado();
  }
}
