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
// SALIDA
// ─────────────────────────────────────────────────────────────
/**
 * Aplica un valor a un pin concreto.
 *
 * Antes esta función era `aplicarRele(bool)` y escribía siempre en
 * `PIN_RELE`, con la lógica del nivel activo cableada en el código (LOW para
 * encender). Eso tenía dos problemas:
 *
 *   1. Cambiar de pin obligaba a recompilar y flashear.
 *   2. Si el relé no era invertido, había que editar el firmware.
 *
 * Ahora el pin y el valor llegan calculados desde la plataforma, así que el
 * mismo firmware sirve para cualquier salida.
 *
 * @param pin    Pin físico a escribir.
 * @param valor  0 o 1, ya ajustado al nivel activo configurado en la web.
 */
void aplicarSalida(int pin, int valor) {
  releEncendido = (valor != 0);

  pinMode(pin, OUTPUT);
  digitalWrite(pin, valor == 0 ? LOW : HIGH);

  Serial.printf("[SALIDA] pin %d -> %d (%s)\n",
                pin, valor, releEncendido ? "ACTIVO" : "INACTIVO");
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

  /*
   * ────────────────────────────────────────────────────────────────
   * DIRECCIONAMIENTO: el pin ya no está fijo en el firmware
   * ────────────────────────────────────────────────────────────────
   * Antes este sketch tenía `PIN_RELE` como constante, así que cambiar el
   * pin obligaba a recompilar y flashear. Ahora el pin y el nivel activo
   * llegan en el comando, configurados desde la web:
   *
   *   "direccionamiento": {
   *     "protocolo": "gpio", "pin": 2, "nivel_activo": 0,
   *     "valor_on": 0, "valor_off": 1
   *   }
   *
   * El ESP32 sigue siendo libre de ignorarlo y usar su pin por defecto si el
   * comando no lo trae, para no romper instalaciones ya desplegadas.
   */
  JsonObject dir = doc["direccionamiento"];

  int pin = dir["pin"] | PIN_RELE;
  int nivelActivo = dir["nivel_activo"] | 1;

  // El valor CONCRETO a escribir lo calcula la API según el nivel activo:
  // un relé invertido se activa escribiendo 0.
  int valor = doc["valor"] | 0;

  Serial.printf("[MQTT] Direccionamiento: pin=%d nivel_activo=%d valor=%d\n",
                pin, nivelActivo, valor);

  aplicarSalida(pin, valor);

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
  aplicarSalida(PIN_RELE, 0);

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
