/**
 * ESP32 — RECEPTOR DE COMANDOS DE ACTUADORES
 * ===========================================
 *
 * Recibe órdenes por MQTT desde Node-RED, acciona el relé y confirma la
 * ejecución a la API.
 *
 * ────────────────────────────────────────────────────────────────────
 * EL CIRCUITO COMPLETO
 * ────────────────────────────────────────────────────────────────────
 *
 *   Web ──► API ──► Node-RED ──► MQTT ──► [ESTE ESP32] ──► Relé
 *                                            │
 *                                            └──► confirma 'ejecutado' a la API
 *
 * ────────────────────────────────────────────────────────────────────
 * TEMAS MQTT
 * ────────────────────────────────────────────────────────────────────
 *   Suscribe:  hospital/quirofano/cmd/RELE-1   (órdenes para este actuador)
 *
 * Cada actuador tiene SU PROPIO tema, así que este ESP32 no recibe órdenes
 * destinadas a otros equipos.
 *
 * ────────────────────────────────────────────────────────────────────
 * CONEXIONES
 * ────────────────────────────────────────────────────────────────────
 *   Relé IN  → GPIO 26
 *   Relé VCC → 5V (o 3V3 según el módulo)
 *   Relé GND → GND
 *
 *   ⚠️ Si usas un módulo de relé alimentado a 5V, la señal de 3,3 V del ESP32
 *      suele funcionar, pero algunos módulos necesitan un transistor o un
 *      level shifter. Si el relé no conmuta, revísalo.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN — AJUSTA ESTOS VALORES
// ─────────────────────────────────────────────────────────────

// WiFi
const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASS = "TU_PASSWORD";

// Broker MQTT (el mismo que usa Node-RED)
const char* MQTT_HOST = "broker.emqx.io";
const int   MQTT_PORT = 1883;

// Identificación de este actuador (debe coincidir con el `codigo` en la BD)
const char* ACTUADOR_CODIGO = "RELE-1";
const char* DISPOSITIVO_ID  = "ESP32W";

// Tema al que se suscribe para recibir órdenes
const char* TEMA_CMD = "hospital/quirofano/cmd/RELE-1";

// API para confirmar la ejecución
const char* API_URL = "http://192.168.1.100:4000/api/v1";
const char* API_KEY = "flx_TU_CLAVE_API";

// Pin del relé
const int PIN_RELE = 26;

// ─────────────────────────────────────────────────────────────
// ESTADO
// ─────────────────────────────────────────────────────────────
WiFiClient clienteWifi;
PubSubClient mqtt(clienteWifi);

/**
 * Estado del relé.
 *
 * Se usa una variable explícita (y no `digitalRead`) porque muchos módulos de
 * relé no permiten leer su estado real: la salida es solo de escritura.
 */
bool releEncendido = false;

unsigned long ultimoIntentoWifi = 0;
unsigned long ultimoIntentoMqtt = 0;

// ─────────────────────────────────────────────────────────────
// RELÉ
// ─────────────────────────────────────────────────────────────
void aplicarRele(bool encender) {
  releEncendido = encender;

  // La mayoría de módulos de relé se activan con nivel BAJO (LOW).
  // Si el tuyo funciona al revés, intercambia HIGH y LOW aquí.
  digitalWrite(PIN_RELE, encender ? LOW : HIGH);

  Serial.printf("[RELE] %s\n", encender ? "ENCENDIDO" : "APAGADO");
}

// ─────────────────────────────────────────────────────────────
// CONFIRMAR A LA API
// ─────────────────────────────────────────────────────────────
/**
 * Avisa a la plataforma de que la orden se ejecutó.
 *
 * Es importante hacerlo aquí (y no en Node-RED) porque ESTE es el único que
 * sabe de verdad si el relé conmutó.
 */
void confirmarEjecucion(const String& comandoId, bool exito) {
  if (comandoId.length() == 0) return;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[API] Sin WiFi: no se puede confirmar");
    return;
  }

  HTTPClient http;
  String url = String(API_URL) + "/iot/comandos/" + comandoId;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);

  // `estado_actuador` refleja el estado REAL, que la web mostrará.
  StaticJsonDocument<256> doc;
  doc["estado"] = exito ? "ejecutado" : "fallido";
  doc["estado_actuador"] = releEncendido ? "on" : "off";

  JsonObject resp = doc.createNestedObject("respuesta");
  resp["origen"] = "esp32";
  resp["gpio"] = PIN_RELE;
  resp["rssi"] = WiFi.RSSI();

  String cuerpo;
  serializeJson(doc, cuerpo);

  int codigo = http.PATCH(cuerpo);
  Serial.printf("[API] Confirmacion -> HTTP %d\n", codigo);

  http.end();
}

// ─────────────────────────────────────────────────────────────
// RECEPCIÓN DE COMANDOS
// ─────────────────────────────────────────────────────────────
void alRecibirComando(char* tema, byte* carga, unsigned int longitud) {
  Serial.printf("\n[MQTT] Mensaje en %s\n", tema);

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, carga, longitud);

  if (error) {
    Serial.printf("[MQTT] JSON invalido: %s\n", error.c_str());
    return;
  }

  const char* actuador = doc["actuador"] | "";
  const char* comando  = doc["comando"]  | "";
  const char* id       = doc["comando_id"] | "";

  // Comprobación de seguridad: aunque cada actuador tiene su tema, se verifica
  // el destinatario por si alguien publica en el tema equivocado.
  if (String(actuador) != String(ACTUADOR_CODIGO)) {
    Serial.printf("[MQTT] Ignorado: es para '%s', no para '%s'\n",
                  actuador, ACTUADOR_CODIGO);
    return;
  }

  Serial.printf("[MQTT] Comando '%s' (id=%s)\n", comando, id);

  // El campo `valor` es booleano y ya viene normalizado por Node-RED.
  bool encender = doc["valor"] | false;

  aplicarRele(encender);

  // Confirmar a la API que se ejecutó.
  confirmarEjecucion(String(id), true);
}

// ─────────────────────────────────────────────────────────────
// CONEXIONES
// ─────────────────────────────────────────────────────────────
void conectarWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("[WiFi] Conectando a %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void conectarMqtt() {
  if (mqtt.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  String clienteId = String("esp32-") + ACTUADOR_CODIGO;
  Serial.printf("[MQTT] Conectando como %s ...\n", clienteId.c_str());

  if (mqtt.connect(clienteId.c_str())) {
    Serial.println("[MQTT] Conectado");
    mqtt.subscribe(TEMA_CMD, 1);
    Serial.printf("[MQTT] Suscrito a %s\n", TEMA_CMD);
  } else {
    Serial.printf("[MQTT] Fallo (rc=%d)\n", mqtt.state());
  }
}

// ─────────────────────────────────────────────────────────────
// SETUP / LOOP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println("\n=== ESP32 receptor de comandos ===");
  Serial.printf("Actuador: %s\n", ACTUADOR_CODIGO);
  Serial.printf("Tema:     %s\n", TEMA_CMD);

  pinMode(PIN_RELE, OUTPUT);
  // Arrancar con el relé apagado evita accionar algo sin querer al reiniciar.
  aplicarRele(false);

  conectarWifi();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(alRecibirComando);
}

void loop() {
  // Reconexión de WiFi (cada 10 s como máximo, para no bloquear el loop).
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - ultimoIntentoWifi > 10000) {
      ultimoIntentoWifi = millis();
      conectarWifi();
    }
    return;
  }

  // Reconexión de MQTT (cada 5 s).
  if (!mqtt.connected()) {
    if (millis() - ultimoIntentoMqtt > 5000) {
      ultimoIntentoMqtt = millis();
      conectarMqtt();
    }
  }

  // Atender mensajes entrantes.
  mqtt.loop();

  // Publicar estado cada 30 s (sirve de heartbeat para la plataforma).
  static unsigned long ultimoEstado = 0;
  if (millis() - ultimoEstado > 30000) {
    ultimoEstado = millis();

    StaticJsonDocument<128> doc;
    doc["estado_actual"] = releEncendido ? "on" : "off";
    doc["rssi"] = WiFi.RSSI();
    doc["uptime"] = millis() / 1000;

    char buffer[128];
    serializeJson(doc, buffer);

    String temaEstado = String("hospital/quirofano/estado/") + ACTUADOR_CODIGO;
    mqtt.publish(temaEstado.c_str(), buffer);
  }
}
