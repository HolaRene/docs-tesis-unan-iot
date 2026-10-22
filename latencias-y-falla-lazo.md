# Latencias, falla de lazo y pruebas

> Todo lo necesario para medir y demostrar el comportamiento del sistema.

## 0. Resumen de lo corregido

| Punto | Estado previo | Ahora |
|---|---|---|
| Falla de sensor `-32768` | Entraba como `good` y **disparaba alarmas de umbral** | Detectada, calidad `bad`, alerta `falla_lazo` |
| Marcas de latencia | Solo inicio y fin | Cinco etapas medidas |
| Espera de confirmación | Fija de 300 ms | Sondeo con timeout configurable |
| Motivo del fallo | No se guardaba | `respuesta.motivo = 'timeout'` |
| Latencia por actuador | No existía | `configuracion.latencia_s` |

---

## 1. Falla de lazo

### El problema real

`iot.service.ts` guardaba **todas** las mediciones con `calidad: 'good'`. Y la
evaluación de alertas no miraba la calidad:

```ts
if (o === '<') return v < ref;   // -32768 < 18 → TRUE
```

Resultado: un sensor averiado generaba **«temperatura por debajo de 18 °C»**.
Un aviso que describe mal el problema y tapa el verdadero.

### La corrección

`api/src/modules/iot/falla-lazo.ts` clasifica el valor antes de guardarlo:

| Valor | Calidad | Alerta |
|---|---|---|
| `-32768` (centinela) | `bad` | `falla_lazo` |
| `< 3,6 mA` (NAMUR NE 43) | `bad` | `falla_lazo` |
| `3,6–4 mA` | `uncertain` | ninguna (aviso) |
| `4–20 mA` | `good` | umbral normal |
| `> 20,5 mA` | `uncertain` | umbral normal (es una medida real) |

Las mediciones con calidad `bad` **no se evalúan** contra umbrales.

### Verificado

| Caso | Resultado |
|---|---|
| 12 °C (normal) | Alerta `regla` de umbral ✅ |
| `-32768` | Alerta `falla_lazo` **critical**, sin umbral ✅ |
| 4 lecturas seguidas en falla | **1 sola** alerta (deduplica) ✅ |
| Vuelta a 22 °C | Alerta **resuelta** ✅ |

---

## 2. Marcas de tiempo

Migración `0019_latencias.sql`:

```
creado_en     (API)   orden registrada
recogido_en   (N-RED) obtenida de la cola
enviado_en    (N-RED) escrita en el PLC
confirmado_en (N-RED) lectura de vuelta correcta
ejecutado_en  (API)   estado final persistido
```

### Reloj: usar UTC siempre

Las columnas son `TIMESTAMPTZ`, que PostgreSQL guarda en UTC internamente.
**Node-RED debe enviar `new Date().toISOString()`**, que siempre acaba en `Z`.

Si usas `new Date().toLocaleString()` obtendrás hora local sin zona y las
latencias saldrán negativas o absurdas.

### Mediciones

Se acepta `origen_en` (opcional) en `POST /iot/mediciones`, que se guarda en
`metadatos`. Sin él, esa medición no entra en el cálculo de latencia
extremo a extremo.

---

## 3. Latencia simulada del actuador

### Dónde vive el parámetro

En la **configuración del actuador**, no en Node-RED:

```json
{ "tipo": "coil", "direccion": 100, "unidad_id": 1, "latencia_s": 6 }
```

Node-RED lo obtiene de `GET /iot/actuadores/configuracion`:

```json
[
  { "actuador_codigo": "MOTOR-EXTRACTOR-2", "latencia_s": 6, "timeout_s": 28 }
]
```

`timeout_s` por defecto = `3 × latencia + 10`, un margen amplio sobre el retardo.

### En el ST (PLC)

La latencia se implementa con un `TON` por actuador: la bobina escrita por
Node-RED arranca el temporizador, y la **salida real** cambia al vencer.

```iecst
(* Ejemplo para un extractor con latencia de 6 s *)
TON_Extractor(IN := %IX0.0, PT := T#6s);
%QX0.0 := TON_Extractor.Q;   (* salida real, tras el retardo *)
```

> **Importante**: Node-RED escribe la orden en `%IX0.0` y **lee de vuelta
> `%QX0.0`** (la salida real), no la orden. Si lee la orden, siempre
> coincidirá al instante y no medirá nada.

### Por qué sondeo y no espera fija

Con 300 ms fijos, un extractor de 6 s **siempre** daba «fallido»: la lectura
de vuelta devolvía el estado anterior.

Ahora el bloque 3 de `docs/node-red/comandos-plc-sondeo.js` lee cada 300 ms
hasta que coincide o vence el timeout.

---

## 4. Consultas SQL

`api/scripts/consultas-tesis.sql` contiene siete consultas. Las más relevantes:

### Latencia por estado (N, mín, media, p95, máx)

```sql
SELECT estado, count(*) AS n,
  round(avg(extract(epoch FROM (ejecutado_en - creado_en)))::numeric,3) AS promedio_s,
  round(percentile_cont(0.95) WITHIN GROUP (
    ORDER BY extract(epoch FROM (ejecutado_en - creado_en)))::numeric,3) AS p95_s
FROM comandos_actuador
WHERE creado_en >= :desde AND creado_en < :hasta
  AND ejecutado_en IS NOT NULL
GROUP BY estado;
```

### Desglose por etapa (lo que va a la tesis)

| Etapa | Qué mide | Valor esperado |
|---|---|---|
| `espera_recogida_s` | sondeo de Node-RED | ~1 s (consulta cada 2 s) |
| `escribir_plc_s` | latencia Modbus | < 0,05 s |
| `aplicacion_plc_s` | **retardo del actuador** | el valor de `latencia_s` |
| `ida_vuelta_api_s` | PATCH de confirmación | < 0,1 s |

### Otros

- Tasa de éxito y fallos por timeout
- Latencia de ingestión de mediciones
- **% de cobertura**: guardadas / esperadas (15 s por canal)
- Fallas de lazo vs alarmas de umbral
- Calidad de las mediciones

---

## 5. Pruebas repetibles

### a) Latencia de comandos

```bash
node api/scripts/prueba-comandos.mjs \
  --actuador MOTOR-EXTRACTOR-2 --n 10 --intervalo 3 \
  --salida latencias.csv
```

Salida: tabla con latencia total y desglose por comando, más un CSV.

Alterna ON/OFF a propósito: diez ON seguidos miden otra cosa (a partir del
segundo el equipo ya está en ON).

### b) Falla de sensor

```bash
# Activar la falla en el PLC (escritura Modbus o el propio OpenPLC)
# y medir cuánto tarda en aparecer en la web:

T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# ... activar %MW1 en el PLC ...
sleep 20
psql "$DB" -c "SELECT tipo, mensaje, iniciada_en - '$T0'::timestamptz AS retraso
               FROM alertas WHERE tipo='falla_lazo';"
```

### c) Verificar que NO hay duplicados

```sql
SELECT count(*) FROM alertas
WHERE tipo = 'falla_lazo' AND estado = 'active';
-- Debe ser 1, aunque lleguen 10 lecturas en falla
```

---

## 6. Evidencia para la tesis

> No puedo tomar capturas de tu pantalla. Esto es lo que conviene capturar y
> qué demuestra cada una.

| Captura | Qué demuestra |
|---|---|
| Node-RED con el flujo y los `node.status` | El sondeo y el timeout funcionan |
| Debug del `PATCH` con las marcas ISO | Las marcas se envían en UTC |
| Tabla de `prueba-comandos.mjs` | La latencia se mide y se desglosa |
| Web: alerta de tipo «Falla de lazo» | Se distingue de una alarma de umbral |
| Web: alerta resuelta al quitar la falla | El ciclo completo |
| Resultado de la consulta 2 | Dónde se va el tiempo |

---

## 7. Cómo aplicar los cambios

```bash
cd api

# Solo la migración nueva (NO pnpm migrate: re-ejecuta la 0009 con TRUNCATE)
psql "$DATABASE_URL" -f src/database/migrations/0019_latencias.sql

# Verificar
psql "$DATABASE_URL" -c "\d comandos_actuador" | grep -E "recogido_en|confirmado_en"
```

### Configurar la latencia de un actuador

```bash
curl -X PATCH "$API/actuadores/$ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"configuracion":{"tipo":"coil","direccion":100,"unidad_id":1,"latencia_s":6}}'
```

### Node-RED

1. Reemplaza los bloques del flujo con los de
   `docs/node-red/comandos-plc-sondeo.js`.
2. Variables de entorno: `API_URL` y `API_KEY`.
3. El `modbus read` del sondeo debe leer la **salida real**, no la orden.
