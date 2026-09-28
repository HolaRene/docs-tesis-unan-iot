# Prueba ESP32 + Wokwi → MQTT → Node-RED → API → WebSocket

Guía paso a paso para probar la capa realtime de extremo a extremo con un
ESP32 simulado en **Wokwi**.

## Arquitectura de la prueba

```
ESP32 (Wokwi)  --MQTT-->  broker.emqx.io  -->  Node-RED  --HTTP-->  API  -->  PostgreSQL
                                                                              |
                                                                          COMMIT
                                                                              |
                                                                         WebSocket
                                                                              |
                                                                          navegador
```

Puntos clave:

- El **ESP32 no habla con la API**: solo publica por MQTT.
- **Node-RED** es quien traduce MQTT → HTTP (es el único que conoce tu API Key).
- La **API** guarda en PostgreSQL y, tras el COMMIT, emite el evento realtime.
- El **navegador** recibe los eventos WS y parchea la caché (sin polling de 15 s).

---

## 0. Requisitos previos

| Cosa | Detalle |
|---|---|
| API en marcha | `cd api && pnpm dev` → `http://localhost:4000/api/v1` |
| Frontend en marcha | `cd frontend && pnpm dev` → `http://localhost:3000` |
| Node-RED | En marcha (con el nodo `node-red-dashboard` no es necesario) |
| IP de tu PC | La necesitará Node-RED; **no uses `localhost`** si algo corre fuera de tu máquina |

---

## 1. Crear el dispositivo en la plataforma

En `/dispositivos` crea un dispositivo con:

| Campo | Valor |
|---|---|
| Nombre | `ESP32 Quirófano 2` |
| Tipo | `esp32` |
| **Identificador** | `ESP32-Q2` ← **debe coincidir exactamente** con el del ESP32 |
| Protocolo | `mqtt` |

> El `identificador` es la clave lógica que usan los endpoints IoT. Si no
> coincide, el backend responde `Dispositivo no encontrado por identificador`.

---

## 2. Crear el sensor y sus canales (códigos que usará el ESP32)

En `/sensores` crea un sensor:

| Campo | Valor |
|---|---|
| Nombre | `DHT22 Quirófano 2` |
| Código | `DHT22-01` |
| Dispositivo | `ESP32 Quirófano 2` |
| Dispositivo asociado | el del paso 1 |

Y en la sección **Magnitudes del sensor** añade dos:

| Tipo de variable | Unidad | Código del canal (se muestra en `/canales`) |
|---|---|---|
| Temperatura | °C | `DHT22-01-TEMPERATURA` |
| Humedad relativa | % | `DHT22-01-HUMEDAD_RELATIVA` |

Después verifica en `/canales` que existen y que el **código** es exactamente
ese (el backend lo genera como `<código-sensor>-<código-tipo>`).

> Si prefieres crearlos a mano: `POST /api/v1/canales` con `codigo`, `nombre`,
> `unidad` y `sensor_id`.

---

## 3. Crear la API Key (con los DOS permisos)

En `/configuracion` (o `POST /api/v1/claves-api` desde la web con tu JWT):

```bash
curl -X POST http://localhost:4000/api/v1/claves-api \
  -H "Authorization: Bearer <TU_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
        "nombre": "wokwi-esp32-q2",
        "permisos": { "mediciones:crear": true, "estado:actualizar": true }
      }'
```

La respuesta incluye `claveCompleta` **una sola vez**: cópiala y guárdala en
Node-RED (nunca en el ESP32).

> Permisos necesarios:
> - `mediciones:crear` → ingesta de mediciones.
> - `estado:actualizar` → heartbeat (estado, IP, RSSI, uptime).

---

## 4. Sketch del ESP32 (corregido)

Cambios respecto a la versión original:
1. Se usa `DEVICE_ID` = `ESP32-Q2` como identificador (y como clientId MQTT).
2. `publicar()` ahora emite el **formato de la API**: `dispositivo` + `mediciones[]` con **código de canal**.
3. Nuevo `publicarEstado()`: publica `estado`, `direccion_ip`, `firmware`, `rssi`, `uptime_s`, `mac`.
4. Se llama a `publicarEstado()` al conectar y en cada ciclo (mantiene viva la última conexión).

```cpp
#include "WiFi.h"
#include <PubSubClient.h>
#include "DHTesp.h"
#include <ArduinoJson.h>

// --- WiFi simulada (Wokwi) ---
const char* ssid     = "Wokwi-GUEST";
const char* password = "";

// --- Broker MQTT (el mismo que lee Node-RED) ---
const char* mqttServer = "broker.emqx.io";
const int   mqttPort   = 1883;

// --- Tópicos ---
const char* topicTele = "hospital/quirofano/telemetry";
const char* topicStat = "hospital/quirofano/status";
const char* topicCmd  = "hospital/quirofano/cmd";

// --- Identificador lógico: DEBE coincidir con dispositivos.identificador ---
const char* DEVICE_ID = "ESP32-Q2";

// --- Pines ---
#define DHTPIN     15
#define LED1_PIN    2
#define LED2_PIN    4
#define LED3_PIN    5
#define LED4_PIN   18
#define BUZZER_PIN 19

DHTesp dht;
WiFiClient client;
PubSubClient mqtt(client);

unsigned long last = 0;
unsigned long inicio = 0;                    // uptime
const unsigned long INTERVAL_MS = 5000;

bool led[4] = {false, false, false, false};
bool buz = false, autoMode = true;

void setup() {
  Serial.begin(115200);
  pinMode(LED1_PIN, OUTPUT); pinMode(LED2_PIN, OUTPUT);
  pinMode(LED3_PIN, OUTPUT); pinMode(LED4_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(200); }

  dht.setup(DHTPIN, DHTesp::DHT22);
  mqtt.setServer(mqttServer, mqttPort);
  mqtt.setCallback(onMessage);
  inicio = millis();
}

void loop() {
  if (!mqtt.connected()) reconnect();
  mqtt.loop();

  if (millis() - last >= INTERVAL_MS) { last = millis(); publicar(); }
  if (autoMode) controlAutomatico();
}

void controlAutomatico() {
  auto d = dht.getTempAndHumidity();
  if (isnan(d.temperature)) return;
  led[0] = d.temperature > 25;
  led[1] = d.temperature > 28;
  led[2] = d.temperature > 30;
  led[3] = d.temperature > 32;
  for (int i = 0; i < 4; i++) aplicar(i);
  aplicar(4);
}

void reconnect() {
  while (!mqtt.connected()) {
    if (mqtt.connect(DEVICE_ID)) {
      mqtt.subscribe(topicCmd);
      publicarEstado();                      // heartbeat inicial
    } else {
      delay(2000);
    }
  }
}

// Telemetría del EQUIPO: estado, IP, firmware, RSSI, uptime
void publicarEstado() {
  StaticJsonDocument<256> doc;
  doc["dispositivo"]  = DEVICE_ID;
  doc["estado"]       = "online";
  doc["direccion_ip"] = WiFi.localIP().toString();
  JsonObject meta = doc.createNestedObject("metadatos");
  meta["firmware"] = "1.0.0";
  meta["rssi"]     = WiFi.RSSI();
  meta["uptime_s"] = (millis() - inicio) / 1000;
  meta["mac"]      = WiFi.macAddress();

  char buf[320];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicStat, buf);
}

// Mediciones: formato que espera la API (canal por código)
void publicar() {
  auto d = dht.getTempAndHumidity();
  if (isnan(d.temperature)) { Serial.println("err dht"); return; }

  StaticJsonDocument<384> doc;
  doc["dispositivo"] = DEVICE_ID;
  JsonArray ms = doc.createNestedArray("mediciones");

  JsonObject m1 = ms.createNestedObject();
  m1["canal"] = "DHT22-01-TEMPERATURA";
  m1["valor"] = d.temperature;

  JsonObject m2 = ms.createNestedObject();
  m2["canal"] = "DHT22-01-HUMEDAD_RELATIVA";
  m2["valor"] = d.humidity;

  char buf[384];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicTele, buf);
  Serial.println(buf);

  publicarEstado();   // mantiene fresca la última conexión + IP/RSSI
}

void onMessage(char* t, byte* payload, unsigned int length) {
  char s[128];
  int n = length < 127 ? length : 127;
  memcpy(s, payload, n); s[n] = 0;

  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, s) == DeserializationError::Ok) {
    if (doc["auto"].is<bool>()) autoMode = doc["auto"];
    const char* names[] = {"led1", "led2", "led3", "led4", "buzzer"};
    bool* fn[] = {&led[0], &led[1], &led[2], &led[3], &buz};
    for (int i = 0; i < 5; i++) {
      if (doc[names[i]].is<bool>()) { *fn[i] = doc[names[i]]; aplicar(i); }
    }
  }
}

void aplicar(int i) {
  const int pins[] = {LED1_PIN, LED2_PIN, LED3_PIN, LED4_PIN, BUZZER_PIN};
  const bool* vals[] = {&led[0], &led[1], &led[2], &led[3], &buz};
  digitalWrite(pins[i], *(vals[i]) ? HIGH : LOW);
}
```

> Los LEDs/buzzer se envían como estado interno del ESP32 (por MQTT). Si quieres
> verlos como canales en la web, crea canales booleanos (p. ej. `LED1-Q2`) y
> añádelos al array `mediciones`.

---

## 5. Flujos de Node-RED

### Flujo A — Telemetría → mediciones

```
[MQTT in: hospital/quirofano/telemetry]
        ↓
[function: adaptar]
        ↓
[http request → POST /api/v1/iot/mediciones]
```

**Function:**
```javascript
const p = JSON.parse(msg.payload);
msg.payload = { dispositivo: p.dispositivo, mediciones: p.mediciones };
msg.headers = {
  "Content-Type": "application/json",
  "X-API-Key": env.get("API_KEY")
};
return msg;
```

**http request:**
- Method: `POST`
- URL: `http://localhost:4000/api/v1/iot/mediciones` (o la IP de tu PC)
- Return: `a parsed JSON object`

### Flujo B — Estado → heartbeat

```
[MQTT in: hospital/quirofano/status]
        ↓
[function: adaptar]
        ↓
[http request → POST /api/v1/iot/dispositivos/ESP32-Q2/estado]
```

**Function:**
```javascript
const p = JSON.parse(msg.payload);
msg.url = "http://localhost:4000/api/v1/iot/dispositivos/"
        + encodeURIComponent(p.dispositivo) + "/estado";
msg.payload = {
  estado: p.estado,
  direccion_ip: p.direccion_ip,
  metadatos: p.metadatos
};
msg.headers = {
  "Content-Type": "application/json",
  "X-API-Key": env.get("API_KEY")
};
return msg;
```

> Configura la variable de entorno `API_KEY` en Node-RED
> (`settings.js` → `functionGlobalContext`, o el nodo `env`).

---

## 6. Verificación paso a paso

### 6.1 Que la API key funciona (sin ESP32)

```bash
API_KEY="<tu clave>"

# Heartbeat
curl -X POST http://localhost:4000/api/v1/iot/dispositivos/ESP32-Q2/estado \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"estado":"online","direccion_ip":"192.168.1.42",
       "metadatos":{"firmware":"1.0.0","rssi":-58,"uptime_s":120}}'

# Ingesta de mediciones
curl -X POST http://localhost:4000/api/v1/iot/mediciones \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"dispositivo":"ESP32-Q2","mediciones":[
        {"canal":"DHT22-01-TEMPERATURA","valor":24.5},
        {"canal":"DHT22-01-HUMEDAD_RELATIVA","valor":48.2}]}'
```

Respuestas esperadas: `{ "exito": true, ... }`.

### 6.2 Que llega al frontend en tiempo real

1. Abre `/dispositivos` en el navegador (pestaña de red → WS → `/api/v1/realtime`).
2. Ejecuta el `curl` de heartbeat con un RSSI distinto (`-70`).
3. En la lista y en `/dispositivos/[id]` debe actualizarse **al instante**:
   - tarjeta **Estado y telemetría** → `firmware`, `rssi`, `uptime_s`;
   - **Última conexión** → "ahora mismo".

### 6.3 Probar el watchdog (offline)

1. Detén el ESP32 en Wokwi (o para Node-RED).
2. Espera `DEVICE_OFFLINE_MINUTOS` (5 por defecto) + el intervalo del watchdog.
3. El dispositivo pasa a **Offline** en la web, en vivo, sin recargar.

---

## 7. Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `Dispositivo no encontrado por identificador` | El `identificador` del dispositivo y `DEVICE_ID` no coinciden. |
| `Canal 'X' no pertenece al dispositivo` | El canal no existe o cuelga de un sensor de **otro** dispositivo. |
| `401 Falta el encabezado X-API-Key` | Falta el header en Node-RED. |
| `403 La API Key no tiene permiso` | Falta `mediciones:crear` o `estado:actualizar` en los permisos. |
| El dispositivo queda `offline` aunque el ESP32 vive | El ESP32 solo envía mediciones cada >5 min; añade `publicarEstado()` en cada ciclo. |
| La web no se actualiza "al instante" | El WS no conectó: revisa en DevTools → Network → WS, y que el token sea válido. |
| Node-RED no alcanza la API | Si la API corre en tu PC y Node-RED en otro sitio, usa la IP de tu PC, no `localhost`. |

---

## 8. Qué se ve en la web

| Pantalla | Qué muestra |
|---|---|
| `/dispositivos` | Estado (Online/Offline) y "hace X" de la última conexión, en vivo. |
| `/dispositivos/[id]` | Tarjeta **Estado y telemetría**: estado, última conexión, IP y metadatos (firmware, RSSI, uptime, MAC). |
| `/canales` | Los canales `DHT22-01-TEMPERATURA` y `DHT22-01-HUMEDAD_RELATIVA`. |
| `/mediciones` | Las lecturas recibidas, con sus gráficas. |
