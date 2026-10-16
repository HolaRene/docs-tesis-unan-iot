# Qué se envía a Node-RED

> Contrato exacto entre la API y Node-RED, capturado de una instalación real.

## El flujo completo

```
┌──────────┐  ①  POST /actuadores/:id/comandos
│   WEB    │──────────────────────────────────►┌─────────┐
│ (usuario │                                   │   API   │
│  pulsa)  │◄──────────────────────────────────│ Express │
└──────────┘  202: comando encolado (pendiente)└────┬────┘
                                                   │ guarda en PostgreSQL
                                                   ▼
                                              ┌─────────┐
                                              │   BD    │  estado: pendiente
                                              └────┬────┘
                                                   │
        ②  GET /iot/comandos/pendientes            │
┌──────────┐  (X-API-Key: flx_…)                   │
│ NODE-RED │◄──────────────────────────────────────┘
│          │   ← incluye el DIRECCIONAMIENTO resuelto
│          │
│          │  ③  publica en MQTT
│          │──────────────────►┌──────────┐
└──────────┘  hospital/…/cmd/… │  ESP32   │
     │                         │  o PLC   │
     │                         └────┬─────┘
     │  ④  PATCH /iot/comandos/:id   │ acciona y confirma
     │      estado: "ejecutado"      │
     └───────────────────────────────┘
```

## ① Lo que manda la web

```http
POST /api/v1/actuadores/<uuid>/comandos
Authorization: Bearer <jwt>

{ "comando": "ON" }
```

La respuesta es inmediata; **el comando NO se ha ejecutado todavía**, solo se ha
encolado:

```json
{ "exito": true, "datos": { "estado": "pendiente", "comando": "ON" } }
```

## ② Lo que recibe Node-RED

```http
GET /api/v1/iot/comandos/pendientes?limite=50
X-API-Key: flx_...
```

Respuesta real (recortada a lo relevante):

```json
{
  "id": "ae4f65f2-be39-4ef0-b1bf-90eb89a13824",
  "comando": "ON",
  "actuador_codigo": "MOTOR-EXTRACTOR-2",
  "actuador_nombre": "Extractor",
  "actuador_tipo": "motor",
  "actuador_protocolo": "modbus",
  "dispositivo_identificador": "PLC-QUIROFANO",
  "area_nombre": "Quirófano 1",

  "direccionamiento": {
    "protocolo": "modbus",
    "configuracion": { "tipo": "coil", "direccion": 100, "unidad_id": 1 },
    "tipo": "coil",
    "direccion": 100,
    "unidad_id": 1,
    "valor_on": 1,
    "valor_off": 0
  }
}
```

### El bloque `direccionamiento`

Es lo que permite **accionar** sin que Node-RED sepa nada del PLC. Se envía
**aplanado** (los campos al nivel de arriba) para que se lea directamente:

```js
const dir = cmd.direccionamiento;
dir.direccion   // 100
dir.tipo        // 'coil'
```

| Campo | Para qué |
|---|---|
| `protocolo` | `modbus` \| `gpio` \| `mqtt` \| `http` |
| `tipo` | `coil` (FC5) o `holding` (FC6) |
| `direccion` | El número que entiende el PLC (0-65535) |
| `unidad_id` | Esclavo Modbus (0-255), para varios PLC |
| `pin` | Número de pin, en GPIO |
| `nivel_activo` | `1` normal, `0` relé invertido |
| `url` / `metodo` | En HTTP |
| `valor_on` / `valor_off` | **Qué escribir** para encender y apagar |

> **`valor_on` no siempre es 1.** Con un relé invertido
> (`nivel_activo: 0`), `valor_on` es `0` y `valor_off` es `1`. Usar un 1 y un 0
> fijos haría lo contrario de lo pedido.

## ③ Lo que Node-RED publica por MQTT

Código en `docs/node-red/recoger-comandos.js`:

```js
const dir = cmd.direccionamiento || {};
const encender = ["ON", "1", "TRUE"].includes(String(cmd.comando).toUpperCase());
const valor = encender ? dir.valor_on : dir.valor_off;

msg.topic = dir.topico || `hospital/quirofano/cmd/${cmd.actuador_codigo}`;
msg.payload = {
  actuador: cmd.actuador_codigo,
  dispositivo: cmd.dispositivo_identificador,
  comando: encender ? "ON" : "OFF",
  valor: valor,
  direccionamiento: {
    protocolo: dir.protocolo,
    tipo: dir.tipo,
    direccion: dir.direccion,
    unidad_id: dir.unidad_id,
    pin: dir.pin,
    nivel_activo: dir.nivel_activo,
    url: dir.url,
    metodo: dir.metodo,
  },
  comando_id: cmd.id,
  enviado_en: new Date().toISOString(),
};
```

Tema MQTT resultante:

```
hospital/quirofano/cmd/MOTOR-EXTRACTOR-2
└──────┬──────┘ └──┬──┘ └───────┬───────┘
     zona        tipo de     código del
                 equipo      actuador
```

## ④ La confirmación

```http
PATCH /api/v1/iot/comandos/ae4f65f2-…
X-API-Key: flx_...

{ "estado": "ejecutado", "estado_actuador": "on" }
```

- `estado`: `ejecutado` o `fallido`
- `estado_actuador`: el estado **real** tras accionar, que es lo que muestra la
  web

Si el comando se queda en `pendiente`, **Node-RED no está recogiendo
comandos**: revisar su API Key y el permiso `comandos:enviar`.

## Ejemplos por protocolo

### PLC Modbus

```json
{
  "protocolo": "modbus",
  "tipo": "coil",
  "direccion": 100,
  "unidad_id": 1,
  "valor_on": 1,
  "valor_off": 0
}
```
→ `modbus write` FC5, dirección 100, valor 1.

### ESP32 con relé invertido

```json
{
  "protocolo": "gpio",
  "pin": 2,
  "nivel_activo": 0,
  "valor_on": 0,
  "valor_off": 1
}
```
→ `digitalWrite(2, LOW)` para **encender** (el relé es activo por nivel bajo).

### ESP32 sin direccionamiento

```json
{ "protocolo": "mqtt" }
```
→ Publica en `…/cmd/<código>` y el firmware decide el pin según el código.

### Equipo con API propia

```json
{
  "protocolo": "http",
  "url": "http://192.168.1.50/rele",
  "metodo": "POST",
  "valor_on": 1,
  "valor_off": 0
}
```
→ Node-RED hace `POST http://192.168.1.50/rele` con `{"valor": 1}`.

## Probar el circuito sin hardware

```bash
# 1. Encolar un comando (desde la web o con curl)
curl -X POST "http://localhost:4000/api/v1/actuadores/$ID/comandos" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comando":"ON"}'

# 2. Ver lo que recibiría Node-RED
curl "http://localhost:4000/api/v1/iot/comandos/pendientes?limite=5" \
  -H "X-API-Key: $API_KEY" | jq '.datos[0].direccionamiento'
```

## Errores frecuentes

| Síntoma | Causa |
|---|---|
| El comando se queda en `pendiente` | Node-RED no corre, o su API Key no tiene `comandos:enviar` |
| `direccionamiento` sin `direccion` | El actuador no tiene dirección configurada (la API lo impide al guardar) |
| Se acciona la salida equivocada | `unidad_id` incorrecto, o el actuador apunta a otro PLC |
| El relé hace lo contrario | Falta `nivel_activo: 0` en la configuración del actuador |
| `fallidas: 1` al enviar mediciones | El `canal` del payload no coincide **exactamente** con el código del canal |
