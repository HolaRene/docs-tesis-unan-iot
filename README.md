# Documentación del proyecto

Documentación técnica transversal de la plataforma de monitorización IoT.

## Índice

| Documento | Descripción |
|---|---|
| [modelo-multivariable.md](./modelo-multivariable.md) | Modelo de datos sensor → canal (magnitud) → medición, creación automática de canales y ejemplos de API (DHT22). |
| [estado-dispositivos.md](./estado-dispositivos.md) | Estado real y telemetría de dispositivos: heartbeats desde PLC/ESP32/Raspberry, IP, última conexión y watchdog de caídas. |
| [realtime-websocket.md](./realtime-websocket.md) | Capa realtime: servidor WebSocket, eventos `dispositivo:*`, reglas anti-ruido y cómo lo consume el frontend. |
| [prueba-esp32-wokwi.md](./prueba-esp32-wokwi.md) | Prueba de extremo a extremo: ESP32 en Wokwi → MQTT → Node-RED → API → WebSocket → web. |
| [aislamiento-por-usuario.md](./aislamiento-por-usuario.md) | Propiedad de recursos: cada usuario ve solo lo suyo, el admin ve todo. Migración, reglas y verificación. |
| [camaras-ip.md](./camaras-ip.md) | Módulo de cámaras IP: arquitectura RTSP → MediaMTX → WebRTC, API de administración, reproductor y conexión futura. |
| [historial-agregado.md](./historial-agregado.md) | Charts de historial por sensor: agregación SQL por hora/día/semana/mes, media ponderada y comparación de magnitudes. |
| [node-red/simulador.md](./node-red/simulador.md) | Simulador de sensor en Node-RED: telemetría aleatoria realista sin hardware. |

> Los README de `api/` y `frontend/` describen cada aplicación por separado.
> Esta carpeta reúne la documentación de **conceptos y modelos compartidos**.
