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
| `camara-player.tsx` | **WebRTC puro**. Negocia WHEP; carga/error/sin-stream/reconectar; pantalla completa. **No conoce la API.** |
| `preview-camara.tsx` | Preview en la tarjeta: conecta solo al pasar el ratón |
| `estado-camara.tsx` | Badge de estado |
| `camara-card.tsx` | Tarjeta del listado, con acciones opcionales |
| `camara-grid.tsx` | Grilla con estados vacío/cargando/error |
| `gestion-camaras.tsx` | Listado + alta, edición y borrado (TanStack Query) |
| `formulario-camara.tsx` | Formulario de alta/edición con asistente de canal |
| `detalle-camara.tsx` | Detalle y composición |
| `camara-detalles.tsx` | Ficha técnica |

## Cámaras multi-canal

Una cámara con varios canales (una **HikVision de 2**, un NVR de 8) expone
**cada canal en una ruta RTSP distinta**. En la plataforma se registra como
**una cámara por canal**:

```
Quirófano 1 - Canal 1  →  /Streaming/Channels/101   →  /quirofano-1-canal-1
Quirófano 1 - Canal 2  →  /Streaming/Channels/201   →  /quirofano-1-canal-2
```

Misma IP, mismo puerto, **distinta ruta**. No hace falta nada especial en la
base de datos: el modelo ya lo soporta.

### El asistente de rutas

El formulario incluye un catálogo por fabricante
(`src/configuracion/camaras.ts`) que rellena la ruta al elegir marca y canal:

| Fabricante | Canales | Ruta del canal 1 | Ruta del canal 2 |
|---|---|---|---|
| HikVision | 4 | `/Streaming/Channels/101` | `/Streaming/Channels/201` |
| Dahua | 4 | `/cam/realmonitor?channel=1&subtype=0` | `/cam/realmonitor?channel=2&subtype=0` |
| Axis | 2 | `/axis-media/media.amp?streamprofile=1` | `/axis-media/media.amp?streamprofile=2` |
| Reolink | 2 | `/h264Preview_01_main` | `/h264Preview_02_main` |
| Genérica | 1 | *(manual)* | — |

**Numeración de HikVision**: `<canal>01` es el stream **principal** y `<canal>02`
el **secundario** (menos resolución y ancho de banda):

```
Canal 1 principal → 101      Canal 1 secundario → 102
Canal 2 principal → 201      Canal 2 secundario → 202
```

### Rutas WebRTC únicas

La `ruta_webrtc` es el identificador del stream en MediaMTX y **debe ser
única**: si se repite, la API rechaza el alta con un mensaje claro. El
formulario la sugiere automáticamente a partir del nombre y el canal
(minúsculas, sin acentos, con guiones).

## Frontend

### Hooks (`src/hooks/useCamaras.ts`)

`useCamaras()` · `useCamara(id)` · `useCrearCamara()` ·
`useActualizarCamara()` · `useActualizarEstadoCamara()` · `useEliminarCamara()`

## Preview en las tarjetas

La tarjeta del listado muestra el vídeo **solo cuando el ratón entra en ella**;
al salir, se desconecta.

### Por qué no reproduce siempre

Cada reproductor abre su **propia conexión WebRTC** contra MediaMTX. Con 8
cámaras en pantalla serían 8 conexiones simultáneas consumiendo ancho de banda,
CPU y recursos del servidor de vídeo… aunque nadie esté mirando.

| Estrategia | Conexiones con 8 cámaras |
|---|---|
| Reproducir siempre | **8** simultáneas |
| Reproducir al pasar el ratón | Las que estés mirando (normalmente 1-2) |

### Detalles de implementación

- El hueco en reposo tiene el **mismo `aspect-video`** que el reproductor. Si no,
  la grilla daría un salto de altura al pasar el ratón.
- Se usa `onFocus`/`onBlur` además de `onMouseEnter`/`onMouseLeave`, para que
  funcione navegando con el teclado.
- La `key` del reproductor es la `ruta_webrtc`: si la tarjeta cambia de cámara,
  se remonta y **cierra la conexión anterior** en vez de reutilizarla.
- Sin `ruta_webrtc` no se conecta nunca: se muestra el hueco con un aviso.

> En pantallas táctiles no existe el «hover». El preview se activa al tocar.

## Pantalla completa

El reproductor del detalle tiene un **botón de pantalla completa** que aparece
cuando el vídeo está en marcha.

### Se pide sobre el contenedor, no sobre el `<video>`

```ts
await contenedorRef.current.requestFullscreen();
```

No es un capricho: **Safari de iOS no permite pantalla completa en un `<video>`
que recibe un `MediaStream`** (solo en vídeos con archivo). Pidiéndola sobre el
contenedor funciona en todos los navegadores, y además se siguen viendo los
controles y la etiqueta «En directo».

### El estado se sincroniza con el evento

```ts
document.addEventListener("fullscreenchange", alCambiar);
```

No basta con alternar un booleano: el usuario puede salir con **Esc** o con el
gesto del sistema, y entonces el botón mostraría el icono equivocado.

Si el navegador rechaza la petición (por ejemplo dentro de un iframe sin
`allowfullscreen`), se avisa y el vídeo sigue viéndose en su tamaño normal.

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
