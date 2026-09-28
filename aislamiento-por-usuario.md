# Aislamiento de datos por usuario (propiedad de recursos)

> Estado: ✅ implementado, migrado y verificado end-to-end.

## El problema

Todos los usuarios autenticados veían **los mismos datos**: el modelo no tenía
ningún concepto de dueño. Cualquier usuario con rol `usuario` podía listar, leer,
editar y borrar áreas, dispositivos, sensores, canales, mediciones y alertas de
los demás.

## Modelo elegido: propiedad por usuario

- Cada recurso tiene un **dueño** (`propietario_id`).
- `admin` **ve y edita todo**.
- El resto **solo ve lo suyo** (+ lo global, ver abajo).
- Lo existente se asignó al **admin más antiguo**; los usuarios nuevos empiezan
  de cero.

## Decisión clave: el dueño solo vive en las RAÍCES

No se puso `propietario_id` en todas las tablas, sino solo en **`areas`** y
**`dispositivos`**. El resto **hereda** por su padre:

```
areas.propietario_id            ← raíz
dispositivos.area_id            → areas
dispositivos.propietario_id     ← raíz
sensores.dispositivo_id         → dispositivos
canales.sensor_id               → sensores → dispositivos
reglas_alerta.canal_id          → canales  → dispositivos
mediciones.canal_id             → canales  → dispositivos
alertas.canal_id / sensor_id    → canales  → dispositivos
camaras / integraciones         → dispositivos
```

**Por qué:** evita estados inconsistentes (un sensor con dueño distinto al de su
dispositivo) y permite cambiar de dueño un árbol entero con un solo `UPDATE`.

## Regla de visibilidad

| Rol | Listar / ver | Editar / borrar |
|---|---|---|
| `admin` | **todo** | **todo** |
| `usuario` / `viewer` | lo suyo + lo global | **solo lo suyo** |

- **Global** = `propietario_id IS NULL`. Visible por todos, **editable solo por
  admin**. Sirve para recursos compartidos (p. ej. un catálogo común).

### `undefined` vs `null` (importante)

El helper distingue tres casos, y es fácil equivocarse:

| Valor de `usuario` | SQL resultante | Uso |
|---|---|---|
| `undefined` | sin filtro (ve todo) | **uso interno**: IoT, watchdog, ingesta |
| `null` | `FALSE` (nada) | defensivo |
| objeto | `propietario_id = $n OR IS NULL` | petición de usuario |

> ⚠️ Para "sin filtro" se usa **`undefined`**, nunca `null`. Durante la
> implementación se usó `null` con la intención de "sin filtro" y provocaba un
> error 500 (bind de parámetros). Está corregido y cubierto por tests.

## Respuestas ante acceso denegado

| Operación | Respuesta |
|---|---|
| Leer un recurso ajeno | **404** (no revela que existe) |
| Editar/borrar un recurso ajeno | **403** "No tiene permisos para…" |
| Crear colgando de un padre ajeno | **400** "…no existe o no tiene acceso" |

El 404 en lectura es deliberado: informar 403 permitiría enumerar qué recursos
existen.

## Defensa contra el "salto de padre"

No basta con filtrar los listados. Si un usuario pudiera hacer
`PATCH /devices/:id { area_id: <área ajena> }`, se colgaría de un árbol ajeno y
lo vería indirectamente. Por eso **también se valida el padre**:

- `deviceService.verificarArea(areaId, usuario)`
- `sensorService.validarExistencias(dispositivoId, ..., usuario)`

## Archivos

### Creados

| Archivo | Descripción |
|---|---|
| `src/database/migrations/0013_propietario_recursos.sql` | Columnas, índices y backfill (idempotente). |
| `src/utils/alcance.ts` | Helpers de visibilidad y propiedad. |
| `src/utils/alcance.test.ts` | 13 tests de las reglas de alcance. |

### Modificados

| Archivo | Cambio |
|---|---|
| `areas/area.{repository,service,controller}.ts` | Filtran y asignan dueño. |
| `devices/device.{repository,service,controller}.ts` | Filtran, asignan dueño y validan el área. |
| `sensors/sensor.{repository,service,controller}.ts` | Heredan del dispositivo; validan el padre. |
| `canales/canal.{repository,service,controller}.ts` | Heredan; el historial valida el canal. |
| `measurements/measurement.{repository,service,controller}.ts` | Heredan por canal/sensor. |
| `alerts/alert.{repository,service,controller}.ts` | Heredan por canal/sensor. |
| `dashboard/dashboard.{repository,service,controller}.ts` | Totales y listas filtrados por usuario. |
| `areas/area.types.ts`, `devices/device.types.ts` | `propietario_id`. |

## Verificación realizada

### 1. Tests automáticos

```
pnpm test  →  38/38 pasan   (13 nuevos de alcance)
```

### 2. Prueba real contra la API (dos usuarios)

| Prueba | Resultado |
|---|---|
| Admin lista áreas | ve **todas** |
| Usuario lista áreas | ve **solo la suya** |
| Usuario lee área del admin | `404 Área no encontrada` |
| Usuario modifica área del admin | `403 No tiene permisos…` |
| Usuario borra área/dispositivo del admin | `403 No tiene permisos…` |
| Usuario crea dispositivo en área ajena | `400 …no tiene acceso a ella` |
| Usuario crea dispositivo en su área | ✅ y queda con su `propietario_id` |
| Usuario modifica su propia área | ✅ |
| Dashboard del usuario | totales **solo** de lo suyo |
| Petición sin token | `401` |

### 3. Aplicación de la migración

Aplicada contra PostgreSQL real, **reejecutada** para confirmar idempotencia, y
con backfill correcto (los recursos existentes quedaron en el admin).

## Notas de despliegue

- Aplicar con `pnpm migrate`. La migración es **idempotente**.
- Si aún no existe ningún admin, la migración **no falla**: avisa por `NOTICE` y
  deja los recursos como globales.
- El backend **debe reiniciarse** tras aplicar la migración para que las
  consultas nuevas encuentren la columna.

## Pendiente / siguientes pasos

- **Módulos sin aislar todavía**: `camaras`, `integraciones`, `actuadores`,
  `umbrales`, `reglas-alerta` (los tres últimos cuelgan de sensores/canales y se
  pueden filtrar con el mismo patrón). Hoy siguen siendo globales.
- **Frontend**: no requiere cambios (los filtros son del backend). Conviene
  mejorar el mensaje cuando llega un 403.
