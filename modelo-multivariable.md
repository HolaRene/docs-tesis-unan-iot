# Modelo multivariable: sensores, canales y mediciones

Este documento explica cómo se modela un **sensor con varias magnitudes**
(ej. un DHT22 con temperatura y humedad relativa) y cómo se crean los canales
automáticamente.

## 1. Conceptos

| Concepto | Tabla | Descripción |
|---|---|---|
| **Área** | `areas` | Zona física (planta, pabellón, sala…). |
| **Dispositivo** | `dispositivos` | Equipo que agrupa sensores (PLC, gateway, ESP32…). |
| **Sensor** | `sensores` | Elemento físico que mide. Puede aportar **varias magnitudes**. |
| **Canal** | `canales` | Una **magnitud concreta** de un sensor (p. ej. temperatura). |
| **Medición** | `mediciones` | Un valor puntual; apunta al **canal** (`canal_id`). |
| **Regla de alerta** | `reglas_alerta` | Condición evaluada sobre un **canal**. |
| **Alerta** | `alertas` | Disparo de una regla (referencia a canal y regla). |

### Jerarquía

```
Área
 └─ Dispositivo
     └─ Sensor                 (ej. DHT22-01)
         ├─ Canal: Temperatura  (sensor_id, tipo_variable_id = TEMPERATURA, unidad °C)
         └─ Canal: Humedad      (sensor_id, tipo_variable_id = HUMEDAD_RELATIVA, unidad %)
             └─ Medición (valor_numerico, registrado_en)
             └─ Regla de alerta (operador, valor de referencia…)
```

**Regla clave:** las **mediciones y las reglas cuelgan del canal**, no del
sensor. Así un mismo sensor puede tener historiales y umbrales independientes
por magnitud.

## 2. Tipos de variable (magnitudes del catálogo)

El catálogo `tipos_variable` define las magnitudes disponibles
(`TEMPERATURA`, `HUMEDAD_RELATIVA`, `CO2`, `VOLTAJE`, `ESTADO_MOTOR`, …) con:

- `tipo_dato`: `numeric` | `boolean` | `text` | `json`
- `unidad_default`: unidad sugerida (`°C`, `%`…)
- `categoria`: `ambiental`, `electrica`, `industrial`, `estado`, `configuracion`
- `permite_reglas`: si se pueden crear reglas sobre ella

Un canal hereda la unidad por defecto del tipo si no se indica otra.

## 3. Creación automática de canales

El sensor declara sus magnitudes al crearse o editarse. El backend genera un
**canal por cada magnitud**.

### `POST /api/v1/sensors`

```json
{
  "nombre": "DHT22 Sala 1",
  "codigo": "DHT22-01",
  "dispositivo_id": "UUID-del-dispositivo",
  "canales": [
    { "tipo_variable_id": "UUID-TEMPERATURA", "rango_min": -10, "rango_max": 50 },
    { "tipo_variable_id": "UUID-HUMEDAD_RELATIVA", "rango_min": 0, "rango_max": 100 }
  ]
}
```

Resultado: se crean **dos canales** (`DHT22-01-TEMPERATURA` y
`DHT22-01-HUMEDAD_RELATIVA`) con nombre `DHT22 Sala 1 · Temperatura` y
`DHT22 Sala 1 · Humedad relativa`.

- Si **no** se envía `canales`, se crea un único canal a partir de
  `tipo_variable_id` (comportamiento de compatibilidad).
- El `codigo` del canal es único; si ya existe se le añade sufijo `-2`, `-3`…
- Cada magnitud acepta: `codigo`, `nombre`, `unidad`, `rango_min`,
  `rango_max`, `precision_valor`, `activo`.

### `PATCH /api/v1/sensors/:id`

Si se envía `canales`, se **sincronizan** las magnitudes:

- Las magnitudes cuyo `tipo_variable_id` ya existe se **actualizan**
  (unidad, rango, precisión, estado).
- Las magnitudes nuevas se **crean**.
- Los canales existentes que no aparecen **no se borran** (para no perder
  mediciones/reglas); se eliminan aparte con `DELETE /api/v1/canales/:id`.

## 4. Endpoints relacionados

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/tipos-variable` | Catálogo de magnitudes disponibles. |
| `GET` | `/api/v1/sensors` | Lista sensores. |
| `POST` | `/api/v1/sensors` | Crea sensor **con sus magnitudes** (`canales`). |
| `PATCH` | `/api/v1/sensors/:id` | Actualiza sensor y sincroniza magnitudes. |
| `GET` | `/api/v1/sensors/:id/canales` | **Magnitudes** (canales) de un sensor. |
| `GET` | `/api/v1/sensors/:id/mediciones` | Historial de todas las magnitudes del sensor. |
| `GET` | `/api/v1/canales` | Lista canales (filtros: `sensor_id`, `area_id`, `dispositivo_id`, `tipo_variable_id`, `buscar`). |
| `GET` | `/api/v1/canales/:id` | Detalle de un canal. |
| `POST` | `/api/v1/canales` | Crea un canal adicional manualmente. |
| `GET` | `/api/v1/canales/:id/mediciones` | Historial del canal (para gráficas). |
| `POST` | `/api/v1/measurements` | Ingesta de una medición (`canal_id`). |
| `GET` | `/api/v1/reglas-alerta?canal_id=` | Reglas de alerta de un canal. |

> `api/src/app.ts` monta todos estos routers bajo `VERSION` (`/api/v1`).

## 5. Ingesta de mediciones (IoT / Node-RED)

Endpoint IoT con API Key: `POST /api/v1/iot/...`. Cada lectura se identifica
por el **código del canal** (o del sensor, por compatibilidad):

```json
{
  "mediciones": [
    { "canal": "DHT22-01-TEMPERATURA", "valor": 23.4 },
    { "canal": "DHT22-01-HUMEDAD_RELATIVA", "valor": 48.1 }
  ]
}
```

El backend resuelve el canal por `codigo`, prepara el valor según el
`tipo_dato` (`numeric` → `valor_numerico`, `boolean` → `valor_booleano`, …) e
inserta la medición con su `canal_id`. Si el canal no existe, **no se crea
automáticamente**: se rechaza esa lectura (ver `iot.service.ts`).

## 6. Migraciones relevantes

| Migración | Contenido |
|---|---|
| `0009_canales.sql` | Crea la tabla `canales` y añade `canal_id` a `mediciones`. |
| `0010_tipos_variable_seed.sql` | Catálogo de magnitudes (temperatura, humedad, CO2, …). |
| `0011_reglas_y_alertas.sql` | `reglas_alerta` por canal; alertas con `canal_id`/`regla_id`. |
| `0012_canales_backfill.sql` | **Backfill**: crea un canal por cada sensor sin canal, heredando su magnitud principal. |

> ⚠️ **No ejecutes `pnpm migrate` completo sobre una base con datos**: cada
> archivo SQL se reaplica y `0009_canales.sql` contiene un `TRUNCATE` de las
> tablas operativas. Para una migración puntual, aplícala sola con `psql`:
>
> ```bash
> psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
>   -f src/database/migrations/0012_canales_backfill.sql
> ```

## 7. Frontend

| Pantalla | Ruta | Qué hace |
|---|---|---|
| Sensores | `/sensores` | CRUD con **editor de múltiples magnitudes**. Al crear/editar envía `canales`. |
| Detalle de sensor | `/sensores/[id]` | Muestra la lista de **magnitudes (canales)** del sensor. |
| Canales | `/canales` | Grilla de todos los canales con filtros. |
| Detalle de canal | `/canales/[id]` | Historial (gráfica) y reglas de alerta del canal. |

Servicios implicados:

- `frontend/src/servicios/sensores.servicio.ts` → `crearSensor`, `actualizarSensor`, `obtenerCanalesDeSensor`.
- `frontend/src/servicios/canales.servicio.ts` → `obtenerCanales`, `obtenerCanalPorId`, `obtenerMedicionesCanal`.

## 8. Ejemplo completo: DHT22

1. **Crear el sensor** con dos magnitudes (`POST /sensors`, ver §3).
2. **Verificar los canales**: `GET /sensors/:id/canales` → 2 canales.
3. **Enviar mediciones** por IoT usando el código del canal (§5).
4. **Crear reglas** por canal (`POST /reglas-alerta` con `canal_id`).
5. **Visualizar** cada magnitud en `/canales/[id]` (histórico) y el conjunto en
   `/sensores/[id]`.
