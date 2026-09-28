# Estado real y telemetría de dispositivos

Cómo se mantiene actualizado el **estado real** de un dispositivo (PLC, ESP32,
Raspberry Pi, gateway…) en la web: `estado`, `direccion_ip` y
`ultima_conexion`, además de metadatos libres.

## 1. Campos del dispositivo

Tabla `dispositivos`:

| Campo | Tipo | Descripción |
|---|---|---|
| `identificador` | texto | **Clave lógica** que usa la integración (ej. `ESP32-Q2`, `PLC-01`). |
| `estado` | texto | `online` \| `offline` \| `mantenimiento` \| `error`. |
| `direccion_ip` | inet | IP del equipo. Se puede reportar; no se deduce del request. |
| `ultima_conexion` | timestamptz | Último contacto registrado. |
| `metadatos` | jsonb | Datos libres: `firmware`, `rssi`, `uptime_s`, `mac`… |

## 2. Cómo se actualiza (dos vías automáticas + una manual)

### a) Ingesta de mediciones (implícita)
`POST /api/v1/iot/mediciones` (API Key, permiso `mediciones:crear`) ya recibe el
`dispositivo` por su identificador. Si el lote tiene **al menos una medición
procesada**, el backend marca el dispositivo como vivo:

```
estado = 'online'
ultima_conexion = NOW()
```

Así, "si está enviando datos, está en línea", sin que el equipo haga nada extra.

### b) Heartbeat explícito (recomendado para IP/firmware)
`POST /api/v1/iot/dispositivos/:identificador/estado`
(API Key, permiso **`estado:actualizar`**)

```json
{
  "estado": "online",
  "direccion_ip": "192.168.1.42",
  "metadatos": { "firmware": "1.4.2", "rssi": -58, "uptime_s": 86400 }
}
```

- `estado` es opcional (por defecto `online`). Valores: `online`, `offline`,
  `mantenimiento`, `error`.
- `direccion_ip` es opcional; si se omite se conserva la anterior.
- `metadatos` se **fusionan** con los existentes (no se reemplazan), así se
  puede enviar solo lo que cambió.
- Actualiza `ultima_conexion = NOW()`.

Respuesta: el dispositivo actualizado (`200`).

### c) Edición manual
La web (`PATCH /api/v1/devices/:id`, JWT rol `usuario`/`admin`) sigue
permitiendo corregir el estado o la IP a mano.

## 3. Detección de caídas (watchdog)

Un job interno revisa periódicamente los dispositivos y marca `offline` a los
que llevan demasiado tiempo sin contacto:

| Variable de entorno | Defecto | Descripción |
|---|---|---|
| `DEVICE_OFFLINE_MINUTOS` | `5` | Minutos sin contacto para considerar un dispositivo caído. |
| `DEVICE_WATCHDOG_INTERVALO_SEG` | `60` | Cada cuántos segundos corre el job. `0` lo desactiva. |

Solo afecta a dispositivos que **alguna vez** registraron contacto
(`ultima_conexion IS NOT NULL`) y que no estén ya `offline` (no pisa un
`mantenimiento` marcado a mano si tiene contacto reciente… pero si no hay
contacto en el umbral, pasa a `offline`).

Arranque: `src/server.ts` → `iniciarWatchdogDispositivos()`; se detiene en el
apagado controlado. Lógica en `src/jobs/device-watchdog.ts`.

## 4. Flujo completo (ejemplo ESP32)

```
ESP32                              API                        PostgreSQL
  │  POST /iot/mediciones ───────► │ marca online + NOW()  ──► dispositivos
  │  (X-API-Key)                   │
  │                                │
  │  POST /iot/dispositivos/       │ actualiza estado, IP,
  │       ESP32-Q2/estado ───────► │ metadatos y NOW()     ──► dispositivos
  │                                │
  │  … deja de enviar …            │
  │                                │ watchdog: sin contacto
  │                                │ > DEVICE_OFFLINE_MINUTOS ► offline
```

## 5. Que se ve en la web

| Pantalla | Ruta | Muestra |
|---|---|---|
| Listado de dispositivos | `/dispositivos` | Estado (badge) y **"hace X"** de la última conexión. Se refresca cada 15 s. |
| Detalle del dispositivo | `/dispositivos/[id]` | Tarjeta **"Estado y telemetría"**: estado, última conexión relativa, IP y metadatos (firmware, RSSI…). Se refresca cada 15 s. |

## 6. Ejemplos con `curl`

```bash
# Heartbeat con estado, IP y metadatos
curl -X POST http://localhost:4000/api/v1/iot/dispositivos/ESP32-Q2/estado \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"estado":"online","direccion_ip":"192.168.1.42","metadatos":{"firmware":"1.4.2","rssi":-58}}'

# Reportar mantenimiento (sin dejar de enviar mediciones)
curl -X POST http://localhost:4000/api/v1/iot/dispositivos/PLC-01/estado \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"estado":"mantenimiento","metadatos":{"tecnico":"jaime"}}'
```

## 7. Notas y buenas prácticas

- **La IP no se deduce del request**: si el equipo está detrás de NAT/DHCP,
  conviene que la reporte él mismo en el heartbeat.
- **La API Key necesita el permiso `estado:actualizar`** (además de
  `mediciones:crear` para la ingesta). Se configuran al crear la clave.
- El watchdog **no inventa** dispositivos: si nunca reportaron contacto, no se
  marcan como offline (evita falsos positivos en equipos recién creados).
- Para equipos que solo reportan estado (sin mediciones), usar el heartbeat
  como "ping" periódico (p. ej. cada 60 s).
