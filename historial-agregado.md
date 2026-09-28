# Historial agregado por sensor (charts de media)

> Estado: ✅ implementado en backend y frontend.

## Los cuatro charts

La vista de sensor y de canal muestra **cuatro paneles apilados**, cada uno con
un propósito distinto:

| # | Chart | Qué responde | Dónde se agrega |
|---|---|---|---|
| 1 | **Promedio por intervalo** | ¿cómo ha evolucionado históricamente? | SQL |
| 2 | **En vivo (por minuto)** | ¿qué está pasando ahora? | SQL (refresco 10 s) |
| 3 | **Mín / media / máx** | ¿cuánta dispersión hay? | SQL |
| 4 | **Comparación de canales** | ¿cómo se relacionan las magnitudes? | SQL (una consulta por canal) |

### 1 y 3 se refrescan con el WebSocket; el 2 además cada 10 s

Los charts históricos no necesitan refresco periódico (el eje es de horas o
días). El chart **en vivo** sí: se actualiza cada 10 s y se recalcula en el
con una consulta ligera (60 puntos máx./hora), no trayendo filas crudas.

## El eje temporal se ancla a "ahora" (importante)

Las versiones anteriores usaban directamente los cubos que devolvía SQL. Eso
tenía un problema real: **SQL solo devuelve cubos con datos**. Si las últimas
mediciones eran de hace horas o días, el gráfico terminaba ahí y parecía
congelado, aunque el sistema siguiera funcionando.

Ahora se construye una **malla temporal completa** con `rellenarMalla()`
(`src/utilidades/series-temporales.ts`):

```
Datos SQL:      [10:00] ──────────────── [14:00]        (2 puntos)
                        ↓ rellenarMalla
Malla:          [10:00][11:00][12:00][13:00][14:00]      (5 puntos)
                                     ↑ huecos como null
Último punto:   siempre el intervalo que contiene AHORA
```

Consecuencias visibles:

- El gráfico **avanza solo**: el eje siempre llega al instante actual.
- Los huecos sin mediciones se ven **como huecos**, no como dos puntos
  pegados que simulan continuidad.
- Hay una **línea de referencia "ahora"** marcando el presente.

Como leer el reloj en render hace impuro el componente (React lo prohíbe), el
instante actual llega por el hook `useAhora()`, que lo refresca por estado.

## El problema original: agregación y escala

El historial devolvía **filas crudas** con un `limite`. Con 333 mediciones va
bien, pero con datos reales es inviable:

| Escenario | Filas crudas | Agregado por hora |
|---|---|---|
| 1 mes a 1 medición / 5 s | ~518.000 | **720** |
| 1 año a 1 medición / 5 s | ~6.300.000 | **8.760** |

Traer cientos de miles de filas al navegador para calcular una media no solo
es lento: hace que la vista deje de responder.

## La decisión: agregar en SQL

`GET /sensors/:id/series` agrupa con `date_trunc` y devuelve estadísticas por
cubo temporal. El navegador recibe **pocos puntos ya calculados**.

```
PostgreSQL (GROUP BY date_trunc)  →  API  →  Frontend (Recharts)
        media, mín, máx,                    solo pinta
        desviación, muestras
```

## Intervalos soportados

| Intervalo | `date_trunc` | Uso típico |
|---|---|---|
| `minuto` | `minute` | Vista en vivo |
| `hora` | `hour` | Últimas 24 h / 7 días |
| `dia` | `day` | 30 / 90 días |
| `semana` | `week` | Tendencias largas |
| `mes` | `month` | Año completo |

**Seguridad:** el intervalo **se valida contra una lista blanca** antes de
entrar al SQL. Nunca se interpola un valor libre en la consulta:

```ts
const TRUNCS = { hora: 'hour', dia: 'day', semana: 'week', mes: 'month' };
const trunc = TRUNCS[intervalo]; // valor resuelto en el servidor
```

Probado con un intento de inyección (`intervalo=hora');DROP TABLE...`) →
rechazado por el schema con error de validación, tabla intacta.

## La media es ponderada (detalle importante)

El resumen **no es la media de las medias**. Cuando los cubos tienen distinto
número de muestras, ambas difieren:

```
Cubo A: 9 muestras, media 10  →  90
Cubo B: 1 muestra,  media 20  →  20
────────────────────────────────────
Media real        = 110 / 10 = 11   ✅ correcto
Media de medias   = (10+20)/2 = 15  ❌ incorrecto
```

El servicio pondera por `muestras`. Hay 7 tests que cubren este caso.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/sensors/:id/series` | Series de un sensor (opcional `canal_id`) |
| GET | `/api/v1/measurements/series` | Series con filtros globales |

Parámetros: `intervalo`, `desde`, `hasta`, `canal_id`, `limite` (máx. 2000).

### Respuesta

```json
{
  "intervalo": "hora",
  "desde": "2026-09-13T00:00:00.000Z",
  "hasta": "2026-09-20T00:00:00.000Z",
  "resumen": { "media": 48.76, "minimo": -9.1, "maximo": 94.5, "muestras": 302 },
  "series": [
    {
      "cubo": "2026-09-11T06:00:00.000Z",
      "media": 48.7589,
      "minimo": -9.1,
      "maximo": 94.5,
      "desviacion": 23.816,
      "muestras": 302
    }
  ]
}
```

Solo se agregan valores **numéricos**: las magnitudes booleanas o de texto se
siguen mostrando como lista de lecturas.

## Frontend

### Componentes (`src/components/graficos/`)

| Componente | Responsabilidad |
|---|---|
| `panel-historial.tsx` | Controles, resumen y composición de los 4 charts |
| `grafica-historial.tsx` | Media (línea) + banda mín–máx (área), con eje anclado a ahora |
| `grafica-min-media-max.tsx` | Tres líneas independientes: mín, media y máx |
| `grafica-comparacion.tsx` | Varias magnitudes del mismo sensor |
| `tarjetas-resumen.tsx` | Media, mín, máx y nº de muestras |

### Utilidades y hooks

| Archivo | Responsabilidad |
|---|---|
| `src/utilidades/series-temporales.ts` | `rellenarMalla`, `agregarMediciones`, truncado por intervalo (funciones puras) |
| `src/hooks/useAhora.ts` | Instante actual como estado (evita `Date.now()` en render) |
| `src/hooks/useSeries.ts` | `useSeriesSensor`, `useSeriesEnVivo` |

### Configuración (`src/configuracion/graficos.ts`)

Periodos (24 h, 7 d, 30 d, 90 d, todo), intervalos, formato del eje X por
intervalo, paleta de colores y `REFRESCO_EN_VIVO_MS` (10 s). Al cambiar el
periodo se sugiere un intervalo coherente (7 días → por hora; 90 días → por
día), pero el usuario manda.

### Dónde aparece

- **`/sensores/[id]`**: los cuatro charts, con comparación de magnitudes
  (un DHT22 muestra temperatura y humedad en el mismo gráfico).
- **`/canales/[id]`**: histórico, en vivo y mín/media/máx de esa magnitud
  concreta (`canalId`); sin comparación, porque sería redundante.

### Por qué la comparación usa un solo eje Y

Superponer magnitudes con unidades distintas (°C y %) en ejes separados hace
que las líneas se crucen y se lean mal. Con un eje compartido la comparación
es honesta y cada canal lleva su unidad en el tooltip.

### `useQueries` en la comparación

La comparación necesita **una consulta por canal**, y el número de canales es
dinámico. Se usa `useQueries` de TanStack Query en lugar de hooks repetidos:
respeta la regla de los hooks y se adapta a cualquier sensor.

## Cómo probarlo

```bash
# Series por hora de un sensor
curl "http://localhost:4000/api/v1/sensors/<ID>/series?intervalo=hora" \
  -H "Authorization: Bearer <TOKEN>"

# Solo una magnitud
curl ".../series?intervalo=dia&canal_id=<CANAL_ID>" -H "..."

# Intervalo inválido -> error de validación (no toca el SQL)
curl ".../series?intervalo=anual" -H "..."
```

En la web: `/sensores/<id>` y elige periodo e intervalo.

## Limitaciones conocidas

- **`limite` de 2000 cubos**: protege la respuesta. Con `intervalo=hora` y más
  de ~83 días, se recortan. Si se necesita un rango mayor, usar un intervalo
  más grueso (día/semana/mes).
- Los huecos **se dibujan como huecos** (`null`), no como ceros. Un tramo sin
  línea significa "sin mediciones", no "valor cero".
- La malla temporal tiene un tope de 2000 puntos: con un rango muy grande y un
  intervalo muy fino (`90 días` + `minuto`) se degrada a mostrar solo los cubos
  con datos, en lugar de colgar el navegador.
- La agregación SQL usa la **zona horaria del servidor** para `date_trunc`; la
  malla del navegador usa la **zona local del usuario**. Con el servidor y el
  navegador en zonas distintas, los bordes de cubo pueden diferir en horas.
- El chart en vivo pide la **agregación por minuto de la última hora** (máx.
  60 puntos). Antes traía 500 mediciones crudas y las agrupaba en el navegador:
  no escalaba, y el `limite` recortaba las mediciones más antiguas sin avisar.
  Ahora usa el mismo endpoint agregado que el histórico.
- Si un sensor tiene **varias magnitudes**, el chart del *sensor* sin filtrar
  por canal **mezcla sus valores en la misma media** (p. ej. `(21 °C + 52 %) / 2`),
  que no tiene significado físico. Para analizar una magnitud concreta, usar el
  detalle del canal o el chart de comparación.
