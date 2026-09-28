# Módulo de cámaras IP (MediaMTX + WebRTC)

> Estado: ✅ implementado (backend + frontend), **pendiente de cámara física**.

## Arquitectura

```
CÁMARA IP ──RTSP──► MEDIAMTX ──WebRTC──► NAVEGADOR (Next.js)
                        ▲
                        │ configuración
                   API Express (solo metadatos)
```

**Principio clave:** la API Express **NO transporta vídeo**. Solo administra
la información y la configuración de las cámaras. El vídeo lo sirve MediaMTX.

| Canal | Transporte | Contenido |
|---|---|---|
| Administración | REST (`/api/v1/cameras`) | Metadatos de la cámara |
| Vídeo | RTSP → MediaMTX → WebRTC | Stream |
| Estado (futuro) | WebSocket de la app | `camara:conectada`, `camara:desconectada`… |

> El vídeo **nunca** pasa por el WebSocket de la aplicación: son canales
> distintos.

## Seguridad

Reglas aplicadas:

- **No se almacenan credenciales RTSP.** El modelo no tiene columnas para
  usuario/contraseña.
- `ruta_stream` es un **PATH** (`/stream1`), **no** una URL completa.
  El schema **rechaza** valores con `://` o `@`.
- La API **rechaza campos desconocidos** (`.strict()`), por lo que un
  `{"usuario_rtsp": "..."}` devuelve error de validación.
- **No existe** `NEXT_PUBLIC_RTSP_URL` ni nada que exponga la cámara al
  navegador.
- Las credenciales, si la cámara las exige, viven **en la configuración de
  MediaMTX** (servidor).

## Base de datos

Migración `0014_camaras_ip.sql` (idempotente). La tabla `camaras` original era
un anexo de `dispositivos`; se amplió a entidad independiente:

| Cambio | Motivo |
|---|---|
| + `nombre`, `descripcion`, `area_id`, `direccion_ip`, `puerto_rtsp`, `ruta_webrtc`, `estado`, `activa`, `ultima_conexion`, `creado_en`, `actualizado_en`, `metadatos` | Campos del módulo |
| + `propietario_id` | Aislamiento por usuario (igual que el resto) |
| `dispositivo_id` → **opcional**, FK `ON DELETE SET NULL` | Una cámara puede existir sin dispositivo |
| Se elimina el `UNIQUE` de `dispositivo_id` | Permitir varias cámaras por dispositivo |
| `CHECK estado IN (activa, inactiva, conectada, desconectada, error)` | Estados válidos |
| Índice único parcial en `ruta_webrtc` | Dos cámaras no pueden colisionar en MediaMTX |

## Endpoints

Todos requieren **JWT**. Escritura: roles `usuario`/`admin`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/cameras` | Listado (filtros: `area_id`, `dispositivo_id`, `estado`, `activa`, `buscar`) |
| GET | `/api/v1/cameras/:id` | Detalle con área y dispositivo resueltos |
| POST | `/api/v1/cameras` | Crear |
| PATCH | `/api/v1/cameras/:id` | Actualizar (parcial) |
| PATCH | `/api/v1/cameras/:id/estado` | Cambiar solo el estado |
| DELETE | `/api/v1/cameras/:id` | Eliminar |

> **Nota de nomenclatura:** el prefijo es `/cameras` (inglés) para mantener la
> convención del proyecto (`/devices`, `/sensors`, `/measurements`).

**Aislamiento:** un `usuario` solo ve/edita lo suyo; `admin` ve todo. Leer un
recurso ajeno → `404`; editarlo → `403`.

### Ejemplo de creación

```json
POST /api/v1/cameras
{
  "nombre": "Cámara Quirófano 1",
  "descripcion": "Cámara de supervisión visual",
  "direccion_ip": "192.168.1.50",
  "puerto_rtsp": 554,
  "ruta_stream": "/stream1",
  "ruta_webrtc": "/camara-qui-1",
  "activa": true
}
```

## Frontend

| Ruta | Contenido |
|---|---|
| `/camaras` | Grilla de tarjetas (nombre, área, estado, IP, última conexión) |
| `/camaras/[id]` | Reproductor WebRTC grande + ficha técnica + cambio de estado |

### Componentes (`src/components/camaras/`)

| Componente | Responsabilidad |
|---|---|
| `camara-player.tsx` | **WebRTC puro**. Negocia WHEP; carga/error/sin-stream/reconectar. **No conoce la API.** |
| `estado-camara.tsx` | Badge de estado |
| `camara-card.tsx` | Tarjeta del listado |
| `camara-grid.tsx` | Grilla con estados vacío/cargando/error |
| `gestion-camaras.tsx` | Listado (TanStack Query) |
| `detalle-camara.tsx` | Detalle y composición |
| `camara-detalles.tsx` | Ficha técnica |

### Hooks (`src/hooks/useCamaras.ts`)

`useCamaras()` · `useCamara(id)` · `useCrearCamara()` ·
`useActualizarCamara()` · `useActualizarEstadoCamara()` · `useEliminarCamara()`

## Configuración de vídeo

Centralizada en **`src/configuracion/video.ts`** (no se hardcodean URLs ni
puertos en los componentes):

```env
NEXT_PUBLIC_MEDIAMTX_WEBRTC_URL=http://localhost:8889
```

Es pública **a propósito**: el navegador necesita la URL para negociar WebRTC.
No contiene credenciales. Se expone `urlWhep(ruta)` que construye
`{base}{ruta}/whep` — **el único punto a tocar** si cambia la configuración de
MediaMTX.

## Cómo conectar MediaMTX (cuando llegue la cámara)

1. **Configurar el path en MediaMTX** (`mediamtx.yml`), con el mismo nombre que
   `ruta_webrtc` de la cámara:

   ```yaml
   paths:
     camara-qui-1:
       source: rtsp://USUARIO:CLAVE@192.168.1.50:554/stream1
       # ↑ las credenciales viven AQUÍ, no en la plataforma
   ```

2. **Habilitar WebRTC/WHEP** en MediaMTX (puerto 8889).

3. **Verificar** que el endpoint responde:
   `http://localhost:8889/camara-qui-1/whep`

4. **Ajustar** `NEXT_PUBLIC_MEDIAMTX_WEBRTC_URL` si MediaMTX no está en
   `localhost`.

5. El reproductor debería pasar de "Stream no disponible" a reproducir.

> El componente ya está preparado: en cuanto el endpoint WHEP exista, funciona
> sin tocar código.

## Estados

| Estado | Significado |
|---|---|
| `activa` | Registrada y habilitada |
| `inactiva` | Registrada pero deshabilitada |
| `conectada` | El stream está activo |
| `desconectada` | Sin stream (valor por defecto) |
| `error` | Fallo detectado |

Una cámara **no** se marca `conectada` solo por existir en PostgreSQL. El
estado se cambia con el endpoint dedicado o, en el futuro, desde MediaMTX.

## Datos de prueba

`pnpm seed` crea (idempotente):

| Campo | Valor |
|---|---|
| Nombre | Cámara Quirófano 1 |
| IP | 192.168.1.50 (**de ejemplo, nunca se contacta**) |
| RTSP | `/stream1` |
| WebRTC | `/camara-qui-1` |
| Estado | `desconectada` |

## Preparado para el futuro

- **WebSocket de estado**: cuando MediaMTX reporte el estado, se emitirán
  `camara:conectada` / `camara:desconectada` / `camara:error` /
  `camara:actualizada` por el WS existente (canal separado del vídeo).
- **Sondeo de MediaMTX**: `buscarPorRutaWebrtc()` ya existe para mapear un
  path de MediaMTX con su cámara.
- **No hay acoplamiento a fabricante**: la entidad es `Camara` y funciona con
  cualquier fuente compatible con RTSP.
