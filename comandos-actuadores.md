# Comandos de actuadores: de la web al PLC/ESP32

> Cómo enviar una orden desde la interfaz y que llegue al equipo físico.

## El circuito completo

```
   WEB              API              NODE-RED          MQTT         ESP32/PLC
    │                │                  │               │              │
    │ 1. POST comandos│                  │               │              │
    ├───────────────►│                  │               │              │
    │                │ guarda           │               │              │
    │                │ 'pendiente'      │               │              │
    │                │                  │               │              │
    │                │ 2. GET pendientes│               │              │
    │                │◄─────────────────┤  (cada 2-3 s) │              │
    │                │                  │               │              │
    │                │                  │ 3. publica    │              │
    │                │                  ├──────────────►│              │
    │                │                  │               │ 4. entrega   │
    │                │                  │               ├─────────────►│
    │                │                  │               │              │ relé
    │                │ 5. PATCH 'enviado'               │              │
    │                │◄─────────────────┤               │              │
    │                │                  │               │              │
    │                │ 6. PATCH 'ejecutado' (lo manda el propio ESP32) │
    │                │◄───────────────────────────────────────────────┤
    │ 7. la web muestra el estado real  │               │              │
    │◄───────────────┤                  │               │              │
```

**Lo más importante que debes entender**: pulsar un botón **no enciende nada inmediatamente**. El comando se **encola** y Node-RED lo recoge en 2-3 segundos. Por eso la interfaz muestra el estado de cada comando.

---

## 1. Desde la web

Ve a **Actuadores** en el menú del panel. Cada actuador tiene botones **Encender** / **Apagar** y un historial de comandos con su estado.

| Estado | Significado |
|---|---|
| `pendiente` | Encolado. Node-RED todavía no lo ha recogido. |
| `enviado` | Publicado en MQTT. El equipo aún no confirma. |
| `ejecutado` | El equipo confirmó que aplicó la orden. |
| `fallido` | No se pudo entregar. |

> Si un comando se queda en **`pendiente`** más de unos segundos, Node-RED no está recogiendo comandos. Revisa su API Key y el permiso `comandos:enviar`.

---

## 2. Crear el actuador

Desde la API o la web, el actuador necesita:

| Campo | Ejemplo | Para qué |
|---|---|---|
| `dispositivo_id` | UUID del ESP32/PLC | A qué equipo pertenece |
| `codigo` | `RELE-1` | Identificador que usa Node-RED y el equipo |
| `tipo` | `rele` | Tipo de salida |
| `topico_mqtt` | `hospital/quirofano/cmd/RELE-1` | Tema MQTT. Si se omite, Node-RED lo deriva del código |

```bash
curl -X POST http://localhost:4000/api/v1/actuadores \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dispositivo_id": "UUID-DEL-DISPOSITIVO",
    "nombre": "Relé Quirófano",
    "codigo": "RELE-1",
    "tipo": "rele",
    "topico_mqtt": "hospital/quirofano/cmd/RELE-1"
  }'
```

---

## 3. API Key para Node-RED

Node-RED necesita una clave con el permiso **`comandos:enviar`**. Créala desde la web (**Configuración → Claves API**) o directamente:

```sql
-- El hash se genera con bcrypt; usa el endpoint de la web para crearla.
```

Guárdala en `settings.js` de Node-RED:

```js
process.env.NODE_RED_API_KEY = "flx_tu_clave_aqui";
```

---

## 4. Montar el flujo en Node-RED

El código está en **`docs/node-red/recoger-comandos.js`**.

### Estructura

```
[inject 2s] ──► [function: recoger-comandos] ──┬─► [mqtt out]      (salida 1)
                                               └─► [http request]  (salida 2)
```

### Pasos

1. **Nodo `inject`**: `Repeat = interval`, `Every = 2` segundos.
2. **Nodo `function`**: pega el código de `recoger-comandos.js`.
   - En la pestaña **Setup**, indica **2 salidas**.
3. **Salida 1 → `mqtt out`**: configúralo con tu broker. El tema lo pone el
   propio código (`msg.topic`), así que déjalo vacío en el nodo.
   - **No** marques "Use topic from msg" si tu versión lo pide: el código ya
     asigna `msg.topic`.
4. **Salida 2 → `http request`**:
   - Method: `PATCH`
   - URL: la pone el código en `msg.url` si la construyes así; si no, deja que
     el propio nodo `function` haga las llamadas (ya las hace con `fetch`).

> **Nota**: el código hace las llamadas HTTP él mismo con `fetch`, así que la
> salida 2 es solo para ver las confirmaciones en un `debug`. Puedes dejarla
> sin conectar.

### Alternativa sin MQTT

La salida 1 se puede conectar a cualquier cosa: un `http request` al PLC, un
`modbus write`, un `tcp out`… El payload ya viene listo.

---

## 5. El equipo físico (ESP32)

El sketch está en **`docs/node-red/esp32-receptor-comandos.ino`**.

### Qué hace

1. Se suscribe a **su** tema: `hospital/quirofano/cmd/RELE-1`
2. Al recibir una orden, acciona el relé (GPIO 26)
3. **Confirma la ejecución a la API** con `estado: "ejecutado"`

Ese último paso es clave: es el único que sabe de verdad si el relé conmutó.

### Librerías necesarias

- `PubSubClient` (MQTT)
- `ArduinoJson`
- `WiFi` y `HTTPClient` (vienen con el core del ESP32)

### Conexiones

| Relé | ESP32 |
|---|---|
| IN | GPIO 26 |
| VCC | 5V (o 3V3 según el módulo) |
| GND | GND |

> ⚠️ Algunos módulos de relé de 5 V no conmutan bien con la señal de 3,3 V del
> ESP32. Si el relé no hace clic, usa un transistor o un level shifter.

### Comandos enviados al equipo

El payload que llega por MQTT es:

```json
{
  "actuador": "RELE-1",
  "dispositivo": "ESP32W",
  "comando": "ON",
  "valor": true,
  "comando_id": "49c80599-...",
  "enviado_en": "2026-09-28T16:04:06.389Z",
  "parametros": null
}
```

- `valor` es **booleano** y ya viene normalizado por Node-RED: acepta `ON`,
  `1`, `true`… y lo convierte a `true`.
- `comando_id` permite al equipo **confirmar la ejecución** después.

---

## 6. Endpoints implicados

| Método | Ruta | Quién lo usa | Permiso |
|---|---|---|---|
| `POST` | `/actuadores/:id/comandos` | La web (JWT) | rol `usuario`/`admin` |
| `GET` | `/iot/comandos/pendientes` | Node-RED | API Key `comandos:enviar` |
| `PATCH` | `/iot/comandos/:id` | Node-RED y el ESP32 | API Key `comandos:enviar` |

---

## 7. Probar sin hardware

Puedes verificar todo el circuito sin PLC ni ESP32:

```bash
# 1. Envía un comando desde la web (o con curl)
# 2. Comprueba que queda pendiente
psql "$DATABASE_URL" -c \
  "SELECT comando, estado FROM comandos_actuador ORDER BY creado_en DESC LIMIT 1;"

# 3. Simula a Node-RED recogiendo el comando
curl "http://localhost:4000/api/v1/iot/comandos/pendientes" \
  -H "X-API-Key: $API_KEY"

# 4. Confirma la entrega
curl -X PATCH "http://localhost:4000/api/v1/iot/comandos/$ID" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"estado":"ejecutado","estado_actuador":"on"}'
```

Tras el paso 4, el actuador pasa a `on` y la web lo refleja.

---

## 8. Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| El comando se queda en `pendiente` | Node-RED no consulta, o su API Key no tiene `comandos:enviar` |
| El comando pasa a `enviado` pero nunca a `ejecutado` | El ESP32 no recibe el MQTT, o no puede llamar a la API (revisa `API_URL`: debe ser la IP de tu PC, no `localhost`) |
| El relé no conmuta | Módulo de 5 V con señal de 3,3 V, o lógica invertida (cambia `HIGH`/`LOW` en `aplicarRele`) |
| El actuador se queda en `off` tras ejecutar | Node-RED no envía `estado_actuador`, o el ESP32 no confirma |

> **Ojo con `API_URL` en el ESP32**: `localhost` apunta al propio ESP32, no a
> tu PC. Usa la IP de la máquina donde corre la API (`http://192.168.1.x:4000`).
