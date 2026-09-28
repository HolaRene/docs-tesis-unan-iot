# Integración con Node-RED y MQTT: el circuito completo

> Referencia de **contratos reales** de la API, la estructura del flujo de
> Node-RED, los temas MQTT y el código del ESP32.
>
> Si solo quieres un LED o un buzzer **sin** Node-RED ni MQTT, usa
> [`esp32-http-buzzer.md`](./esp32-http-buzzer.md). Este documento es para el
> circuito completo con Node-RED.

## Índice

1. [Vista general](#1-vista-general)
2. [Qué espera la API](#2-qué-espera-la-api)
3. [Node-RED: los tres flujos](#3-node-red-los-tres-flujos)
4. [MQTT: temas y payloads](#4-mqtt-temas-y-payloads)
5. [El ESP32](#5-el-esp32)
6. [Puesta en marcha paso a paso](#6-puesta-en-marcha-paso-a-paso)
7. [Problemas frecuentes](#7-problemas-frecuentes)

---

## 1. Vista general

Hay **dos direcciones** que no deben confundirse:

```
   ┌─────────────────────── IDA (el equipo informa) ──────────────────────┐
   │                                                                      │
   ESP32/PLC ──MQTT──► Node-RED ──HTTP POST──► API ──► PostgreSQL ──► Web
   │  mediciones         transforma            /iot/mediciones            │
   │  estado             y reenvía             /iot/dispositivos/.../estado│
   └──────────────────────────────────────────────────────────────────────┘

   ┌─────────────────── VUELTA (la web manda) ────────────────────────────┐
   │                                                                      │
   Web ──► API ──► Node-RED ──MQTT──► ESP32/PLC ──► relé/buzzer           │
   │   POST comandos   GET pendientes   publica      acciona              │
   │                   PATCH enviado     en el tema                        │
   │                                                                      │
   │   ◄──── confirmación de ejecución (vuelve por la ida) ────┘           │
   └──────────────────────────────────────────────────────────────────────┘
```

**Node-RED es el traductor**: habla MQTT con los equipos y HTTP con la API.

### Por qué Node-RED en medio y no el ESP32 directo

| Sin Node-RED | Con Node-RED |
|---|---|
| El ESP32 pregunta cada 2 s (polling) | El ESP32 recibe al instante (push) |
| El ESP32 guarda lógica de negocio | El ESP32 solo acciona su pin |
| Cada equipo nuevo repite el código | Se añade un nodo y listo |

---

## 2. Qué espera la API

Todas las rutas `/iot/*` se autentican con el header **`X-API-Key`** (no JWT) y
exigen un permiso concreto.

### 2.1 Permisos disponibles

| Permiso | Para qué |
|---|---|
| `mediciones:crear` | Enviar mediciones |
| `comandos:enviar` | Consultar y confirmar comandos |
| `estado:actualizar` | Reportar estado del dispositivo |

Se configuran al crear la API Key, como un mapa booleano:

```json
{ "mediciones:crear": true, "comandos:enviar": true, "estado:actualizar": true }
```

### 2.2 Enviar mediciones

```http
POST /api/v1/iot/mediciones
X-API-Key: flx_...
Content-Type: application/json
```

```json
{
  "dispositivo": "ESP32-Q2",
  "mediciones": [
    { "canal": "DHT1W-TEMPERATURA", "valor": 24.8 },
    { "canal": "DHT1W-HUMEDAD_RELATIVA", "valor": 68 }
  ],
  "metadatos": { "fuente": "esp32", "rssi": -58 }
}
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `dispositivo` | ✅ | `dispositivos.identificador` |
| `mediciones[]` | ✅ | Al menos una |
| `mediciones[].canal` | ✅ * | `canales.codigo`. Alternativa: `sensor` |
| `mediciones[].valor` | ✅ | number, string, boolean, objeto o null |
| `metadatos` | ❌ | Se guarda tal cual |

> ⚠️ **`valor` debe estar SIEMPRE presente y ser válido.** Si falta o es `NaN`,
> la API responde `{"campo":"mediciones.0.valor","mensaje":"Invalid input"}`.
> Un `NaN` en JavaScript (por ejemplo al calcular con campos inexistentes) no
> es JSON válido y rompe la petición entera.

**Respuesta:**

```json
{
  "exito": true,
  "mensaje": "Mediciones procesadas",
  "datos": { "procesadas": 2, "fallidas": 0 }
}
```

> `fallidas > 0` significa que algún `canal` **no existe** en la base de datos.
> No da error HTTP: la revisión hay que hacerla mirando ese contador.

### 2.3 Reportar estado del dispositivo

```http
POST /api/v1/iot/dispositivos/{identificador}/estado
X-API-Key: flx_...
```

```json
{
  "estado": "online",
  "direccion_ip": "192.168.1.50",
  "metadatos": { "rssi": -58, "uptime_s": 3600, "firmware": "1.2.0" }
}
```

| Campo | Valores |
|---|---|
| `estado` | `online`, `offline`, `mantenimiento`, `error` |
| `direccion_ip` | IPv4 (`192.168.1.50`) o `null` |
| `metadatos` | Objeto libre (se **fusiona** con el anterior, no lo reemplaza) |

> **Heartbeat.** Un job del servidor marca `offline` los dispositivos sin
> contacto (por defecto 5 min). Si tu equipo no envía esto periódicamente,
> aparecerá desconectado en la web aunque esté funcionando.

### 2.4 Enviar un comando (integración → API)

```http
POST /api/v1/iot/comandos
X-API-Key: flx_...
```

```json
{
  "actuador": "RELE-1",
  "comando": "ON",
  "valor": true,
  "metadatos": { "origen": "regla-automatica" }
}
```

> Esta ruta es para que una **integración** (Node-RED, un script) encole un
> comando. Es opcional: la web puede enviarlos sola.

### 2.5 Recoger comandos pendientes (Node-RED → API)

```http
GET /api/v1/iot/comandos/pendientes?limite=50
X-API-Key: flx_...
```

**Sin filtros** devuelve **todas** las órdenes de la instalación: es lo que usa
Node-RED, que las reparte él mismo.

**Respuesta real:**

```json
{
  "exito": true,
  "datos": [
    {
      "id": "bb1b4650-bcd9-4ae9-86f8-2476c3924b31",
      "comando": "ON",
      "valor": null,
      "estado": "pendiente",
      "creado_en": "2026-09-28T18:43:05.709Z",
      "actuador_codigo": "BUZZER-1",
      "actuador_nombre": "Buzzer",
      "actuador_topico_mqtt": null,
      "actuador_tipo": "buzzer",
      "actuador_estado_actual": "off",
      "dispositivo_identificador": "ESP32-BUZZER",
      "dispositivo_nombre": "ESP32 Buzzer",
      "area_nombre": "Área 1"
    }
  ]
}
```

Campos que necesita Node-RED:

| Campo | Uso |
|---|---|
| `id` | Para confirmar la entrega después |
| `comando` | La orden en sí (`ON`, `OFF`…) |
| `valor` | Parámetro extra opcional |
| `actuador_codigo` | A qué actuador va |
| `actuador_topico_mqtt` | **Tema MQTT de destino.** Si es `null`, se deriva del código |
| `dispositivo_identificador` | A qué equipo pertenece |

### 2.6 Confirmar un comando (Node-RED / equipo → API)

```http
PATCH /api/v1/iot/comandos/{id}
X-API-Key: flx_...
```

```json
{
  "estado": "enviado",
  "respuesta": { "origen": "node-red", "via": "mqtt" }
}
```

| `estado` | Cuándo |
|---|---|
| `enviado` | Se publicó en MQTT; el equipo aún no confirma |
| `ejecutado` | El equipo confirmó que aplicó la orden |
| `fallido` | No se pudo entregar |

Campo opcional **`estado_actuador`**: si se envía junto a `ejecutado`, actualiza
el estado real del actuador (`on`/`off`), que es lo que muestra la web.

---

## 3. Node-RED: los tres flujos

**Flujo 1 — Mediciones (ida)**

```
[inject] ─► [function] ─► [http request] ─► [debug]
             o bien
[mqtt in] ─► [function] ─► [http request] ─► [debug]
```

**Flujo 2 — Comandos (vuelta)**

```
[inject 2s] ─► [function] ─┬─► [mqtt out]   (salida 1: publica la orden)
                           └─► [debug]      (salida 2: confirmaciones)
```

**Flujo 3 — Estado (ida)**

```
[mqtt in: .../status] ─► [function] ─► [http request] ─► [debug]
```

### 3.1 Flujo 1: mediciones

El código de este nodo está en **`docs/node-red/simulador-sensor.js`** para el
simulador, y en el propio sketches para el equipo real.

**Nodo `function`:**

```javascript
const API = "http://localhost:4000/api/v1";
const API_KEY = env.get("NODE_RED_API_KEY");

msg.headers = {
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
};

// El payload ya viene con la forma que espera la API.
msg.payload = {
  dispositivo: msg.payload.dispositivo,
  mediciones: msg.payload.mediciones,
  metadatos: { fuente: "node-red" },
};

// NO reconstruir el payload: si se recalcula mal, `valor` acaba en NaN y la
// API rechaza la petición entera con "mediciones.0.valor: Invalid input".
return msg;
```

**Nodo `http request`:**

| Campo | Valor |
|---|---|
| Method | `POST` |
| URL | `http://localhost:4000/api/v1/iot/mediciones` |
| Return | a parsed JSON object |

### 3.2 Flujo 2: comandos (el importante)

El código completo está en **`docs/node-red/recoger-comandos.js`**.

**Estructura del nodo `function`:** se configuran **dos salidas**.

```
                 ┌─ salida 1 ──► [mqtt out]   publica la orden
[function] ──────┤
                 └─ salida 2 ──► [debug]      confirmaciones
```

**Qué hace, en orden:**

1. `GET /iot/comandos/pendientes` con la API Key.
2. Por cada comando, construye el mensaje MQTT y lo emite por la salida 1.
3. Confirma cada uno con `PATCH /iot/comandos/{id}` → estado `enviado`.

**Nodo `mqtt out`:**

| Campo | Valor |
|---|---|
| Server | tu broker (p. ej. `broker.emqx.io:1883`) |
| Topic | **vacío** (lo pone el código en `msg.topic`) |
| QoS | `1` (al menos una vez) |

> Como cada actuador tiene su tema, **no se configura un tema fijo**: el nodo
> `function` asigna `msg.topic` por comando.

### 3.3 Flujo 3: estado

```javascript
const API = "http://localhost:4000/api/v1";
const API_KEY = env.get("NODE_RED_API_KEY");
const d = msg.payload; // { dispositivo, estado, ip, rssi }

msg.headers = { "X-API-Key": API_KEY, "Content-Type": "application/json" };
msg.url = `${API}/iot/dispositivos/${d.dispositivo}/estado`;
msg.payload = {
  estado: d.estado,
  direccion_ip: d.ip ?? null,
  metadatos: { rssi: d.rssi },
};
return msg;
```

**Nodo `http request`:** Method `POST`, URL **desde `msg.url`**.

### 3.4 El nodo `mqtt in` (escuchar a los equipos)

| Campo | Valor |
|---|---|
| Server | tu broker |
| Topic | `hospital/quirofano/telemetry` (o `#` para todo) |
| Output | a parsed JSON object |
| QoS | `1` |

> Suscribirse a `#` recibe **todo** el tráfico del broker. En un broker público
> (como `broker.emqx.io`) eso incluye mensajes de desconocidos: usa temas
> específicos o un broker propio.

---

## 4. MQTT: temas y payloads

### 4.1 Convención de temas

```
hospital/{zona}/{tipo}/{equipo}
```

| Dirección | Tema | Quién publica | Quién escucha |
|---|---|---|---|
| **Ida** (mediciones) | `hospital/quirofano/telemetry` | ESP32 | Node-RED |
| **Ida** (estado) | `hospital/quirofano/status` | ESP32 | Node-RED |
| **Vuelta** (órdenes) | `hospital/quirofano/cmd/{CODIGO}` | Node-RED | ESP32 |

> **Un tema por actuador** (`.../cmd/BUZZER-1`, `.../cmd/RELE-2`): así cada
> equipo se suscribe solo al suyo y no recibe órdenes ajenas.

Si el actuador tiene `topico_mqtt` configurado en la base de datos, se usa ese.
Si no, Node-RED lo construye como `{PREFIJO}/{actuador_codigo}`.

### 4.2 Payload de mediciones (ESP32 → Node-RED)

```json
{
  "dispositivo": "ESP32-Q2",
  "mediciones": [
    { "canal": "DHT1W-TEMPERATURA", "valor": 24.8 },
    { "canal": "DHT1W-HUMEDAD_RELATIVA", "valor": 68 }
  ],
  "ip": "192.168.1.50",
  "rssi": -58
}
```

Es **el mismo formato que espera la API**, a propósito: así Node-RED reenvía
`dispositivo` y `mediciones` tal cual, sin transformar nada.

### 4.3 Payload de órdenes (Node-RED → ESP32)

```json
{
  "actuador": "BUZZER-1",
  "dispositivo": "ESP32-BUZZER",
  "comando": "ON",
  "valor": true,
  "comando_id": "bb1b4650-bcd9-4ae9-86f8-2476c3924b31",
  "enviado_en": "2026-09-28T18:43:05.709Z",
  "parametros": null
}
```

| Campo | Uso en el ESP32 |
|---|---|
| `actuador` | **Comprobar que la orden es suya** antes de actuar |
| `valor` | Booleano ya normalizado por Node-RED |
| `comando_id` | Para confirmar la ejecución después |

Node-RED normaliza el comando: acepta `ON`, `1`, `true`, `ENCENDER`… y lo
convierte a `valor: true`.

### 4.4 Payload de estado (ESP32 → Node-RED)

```json
{
  "dispositivo": "ESP32-Q2",
  "estado": "online",
  "ip": "192.168.1.50",
  "rssi": -58,
  "uptime_s": 3600
}
```

### 4.5 Payload de confirmación (ESP32 → Node-RED → API)

El ESP32 publica en `hospital/quirofano/status/{CODIGO}`:

```json
{
  "comando_id": "bb1b4650-bcd9-4ae9-86f8-2476c3924b31",
  "estado": "ejecutado",
  "estado_actuador": "on",
  "rssi": -58
}
```

Y Node-RED lo reenvía a la API con un `PATCH`.

> **Alternativa más simple**: que el propio ESP32 haga el `PATCH` por HTTP
> (como hace `esp32-buzzer-http.ino`). Así la confirmación no depende de que
> Node-RED esté vivo.

---

## 5. El ESP32

### 5.1 Variante A: solo MQTT (push real)

Sketch de referencia: **`docs/node-red/esp32-receptor-comandos.ino`**.

| Tarea | Cómo |
|---|---|
| Recibir órdenes | Suscrito a `hospital/quirofano/cmd/BUZZER-1` |
| Accionar | `digitalWrite(pin, LOW/HIGH)` |
| Confirmar | `PATCH /iot/comandos/{id}` por HTTP |

### 5.2 Variante B: solo HTTP (sin Node-RED ni MQTT)

Sketch: **`docs/node-red/esp32-buzzer-http.ino`**.
Documentación: [`esp32-http-buzzer.md`](./esp32-http-buzzer.md).

Pregunta cada 2 s a `/iot/comandos/pendientes?identificador=...`.

### 5.3 Cuál elegir

| | MQTT | HTTP |
|---|---|---|
| Latencia | Milisegundos | Hasta 2 s |
| Depende de Node-RED | Sí | No |
| Depende del broker | Sí | No |
| Lógica en el equipo | Mínima | Mínima |
| Ideal para | Alarmas, tiempo real | LED, buzzer, riego |

---

## 6. Puesta en marcha paso a paso

### Paso 1 — Crear el actuador

```bash
curl -X POST http://localhost:4000/api/v1/actuadores \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dispositivo_id": "UUID-DEL-DISPOSITIVO",
    "nombre": "Buzzer Quirófano",
    "codigo": "BUZZER-1",
    "tipo": "buzzer",
    "topico_mqtt": "hospital/quirofano/cmd/BUZZER-1"
  }'
```

### Paso 2 — Crear la API Key

Desde **Configuración → Claves API**, marcando:
`mediciones:crear`, `comandos:enviar`, `estado:actualizar`.

### Paso 3 — Guardarla en Node-RED

En `settings.js`:

```js
process.env.NODE_RED_API_KEY = "flx_tu_clave_aqui";
```

### Paso 4 — Montar los flujos

- Flujo 1 (mediciones): `docs/node-red/simulador-sensor.js` como base.
- Flujo 2 (comandos): `docs/node-red/recoger-comandos.js`.
- Flujo 3 (estado): el fragmento de la sección 3.3.

### Paso 5 — Flashear el ESP32

Pega `esp32-receptor-comandos.ino` y ajusta WiFi, broker y tema.

### Paso 6 — Probar

**Sin hardware ni Node-RED** puedes comprobar la API:

```bash
# 1. Encola un comando desde la web (o con curl)
# 2. Compruébalo
curl "http://localhost:4000/api/v1/iot/comandos/pendientes" \
  -H "X-API-Key: $API_KEY" | jq

# 3. Simula a Node-RED confirmando
curl -X PATCH "http://localhost:4000/api/v1/iot/comandos/$ID" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"estado":"ejecutado","estado_actuador":"on"}'
```

Tras el paso 3, el actuador pasa a `on` en la web.

---

## 7. Problemas frecuentes

| Síntoma | Causa |
|---|---|
| El comando se queda en `pendiente` | Node-RED no consulta, o su API Key no tiene `comandos:enviar` |
| `{"campo":"mediciones.0.valor","mensaje":"Invalid input"}` | Falta `valor`, o es `NaN` (no es JSON válido) |
| `procesadas: N, fallidas: M` con M > 0 | Algún `canal` no existe en la base de datos |
| El comando pasa a `enviado` pero nunca a `ejecutado` | El ESP32 no recibe MQTT, o no puede confirmar |
| El actuador se queda en `off` | No se envía `estado_actuador` en el `PATCH` |
| El dispositivo aparece `offline` | No llega el heartbeat de estado (watchdog de 5 min) |
| `HTTP 401` | Falta el header `X-API-Key` o el permiso no está activo |
| El ESP32 no conecta a la API | `localhost` apunta al propio ESP32: usa la IP del PC |

### Comprobar el ciclo de vida de un comando

```sql
SELECT comando, estado, creado_en, enviado_en, ejecutado_en
FROM comandos_actuador
ORDER BY creado_en DESC
LIMIT 5;
```

| `estado` | `enviado_en` | `ejecutado_en` | Significa |
|---|---|---|---|
| `pendiente` | — | — | Node-RED no lo ha cogido |
| `enviado` | ✅ | — | Publicado en MQTT, sin confirmar |
| `ejecutado` | ✅ | ✅ | El equipo confirmó |
| `fallido` | ✅ | — | No se pudo entregar |

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`esp32-http-buzzer.md`](./esp32-http-buzzer.md) | Variante sin Node-RED ni MQTT |
| [`comandos-actuadores.md`](./comandos-actuadores.md) | Arquitectura de comandos |
| [`estado-dispositivos.md`](./estado-dispositivos.md) | Heartbeat y watchdog |
| [`node-red/simulador-sensor.js`](./node-red/simulador-sensor.js) | Simulador de sensores |
| [`node-red/recoger-comandos.js`](./node-red/recoger-comandos.js) | Nodo de comandos |
