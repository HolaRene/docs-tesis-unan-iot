# Realtime por WebSocket

Resumen de la capa de tiempo real. El detalle de implementación está en los
README de cada parte:

- `api/src/realtime/README.md` — infraestructura (Parte 1)
- `api/src/realtime/README.dispositivos-eventos.md` — emisores (Parte 2)
- `api/src/realtime/README.ingesta.md` — ingesta (Parte 3)
- `api/src/realtime/README.heartbeat.md` — heartbeat (Parte 4)
- `api/src/realtime/README.watchdog.md` — watchdog (Parte 5)
- `frontend/src/hooks/README.realtime.md` — cliente (Parte 6)
- `api/src/realtime/README.mediciones.md` — 2.ª entrega: mediciones/canales
- `api/src/realtime/README.alertas.md` — 3.ª entrega: alertas

## Regla fundamental

**PostgreSQL es la fuente de verdad.** Nunca se emite un evento antes de
confirmar el `INSERT/UPDATE`:

```
cambio → PostgreSQL → COMMIT → WebSocket → frontend
```

## Conexión

Mismo puerto que la API, ruta `/api/v1/realtime`, autenticado con el JWT:

```
ws://localhost:4000/api/v1/realtime?token=<JWT>
```

Token inválido o ausente → cierre `4401`.

## Eventos

| Evento | Cuándo | Estado |
|---|---|---|
| `dispositivo:online` | Transición *distinta de online* → online | ✅ |
| `dispositivo:offline` | Transición online → offline (watchdog) | ✅ |
| `dispositivo:actualizado` | Cambió IP/metadatos/estado (heartbeat) | ✅ |
| `medicion:nueva` | Tras guardar un lote de mediciones (uno por lote) | ✅ |
| `canal:actualizado` | Tras guardar mediciones (uno por canal) | ✅ |
| `alerta:creada` | Se inserta una alerta (evaluación de reglas o alta manual) | ✅ |
| `alerta:actualizada` | Se reconoce o cambia una alerta sin resolverla | ✅ |
| `alerta:resuelta` | La alerta pasa a `resolved` | ✅ |

**El catálogo está completo**: los 8 eventos están implementados.

Formato:

```json
{ "tipo": "dispositivo:offline", "datos": { "...": "..." }, "emitido_en": "ISO-8601" }
```

## Reglas anti-ruido

| Situación | ¿Emite? |
|---|---|
| 100 sensores enviando mediciones, dispositivo ya online | **No** emite nada de dispositivo |
| Solo cambia `ultima_conexion` | **No** emite `dispositivo:actualizado` |
| Watchdog reejecutado con el equipo ya `offline` | **No** emite `dispositivo:offline` |
| Heartbeat con el mismo RSSI/estado | **No** emite nada |

`ultima_conexion` se actualiza siempre en PostgreSQL, pero **no** genera evento:
la actividad continua se comunica con `medicion:nueva` (2.ª entrega) y el estado
solo cuando cambia de verdad.

## Frontend

- Carga inicial por REST (`GET /dispositivos`).
- Actualizaciones por WS aplicadas con `queryClient.setQueryData()` (parchea el
  elemento de la lista y el detalle, sin refetch).
- **Polling**: de 15 s → **90 s** como respaldo (`POLLING_RESPALDO_MS`).
- **Reconexión**: reintenta cada 3 s; al reconectar invalida una vez
  `["dispositivos"]` para recuperar lo perdido.
- En **modo demo** no abre WS (no hay backend real).
