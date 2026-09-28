# Simulador de sensor en Node-RED

> Genera telemetría **aleatoria pero realista** sin necesidad de hardware.

## Qué problema resuelve

Sin ESP32 conectado no hay datos, y sin datos no se pueden probar los charts,
las alertas ni la ingesta. Este nodo rellena ese hueco.

## ⚠️ EL ERROR MÁS COMÚN: pegar el simulador en el nodo del ESP32

Si pegas este código en la **misma función** que reenvía la telemetría del
ESP32 (la que se alimenta de un `mqtt in`), **no verás nada**: ni el debug, ni
datos en la web.

**Por qué:** esa función solo se ejecuta cuando **llega un mensaje MQTT**. Si el
ESP32 está apagado o Wokwi no está publicando, la función nunca corre. No es
que falle: es que **nadie la llama**.

```
❌ MAL — un solo nodo para dos trabajos:

   mqtt in ──► función (simulador + reenvío) ──► http
                   ▲
                   └─ si no hay MQTT, no se ejecuta NUNCA

✅ BIEN — flujos separados:

   mqtt in ──► f1 (reenvía el ESP32) ──► http      ← flujo real
   inject ───► función (simulador)  ──► http      ← flujo de simulación
```

Son **dos responsabilidades distintas**: reenviar datos reales y fabricar datos
falsos. Mézclalas y ninguna de las dos funciona bien.

## Instalación automática (recomendada)

Hay un script que monta el flujo correctamente y **deja intacto** el del ESP32:

```bash
# 1. Detén Node-RED (si está corriendo reescribirá flows.json)
#    Ctrl+C en su terminal

# 2. Instala el flujo del simulador
cd api && node scripts/instalar-flujo-simulador.mjs

# 3. Arranca Node-RED
node-red
```

El script:

1. **Restaura** el nodo `f1` a su función original (reenviar el ESP32).
2. **Añade** una pestaña nueva *"Simulador (sensor falso)"* con
   `inject (cada 15 s) → función → http request`.
3. **Reutiliza** tu nodo `http request` existente, sin duplicar la URL.
4. Guarda una copia de seguridad en `flows.json.bak`.
5. **Avisa si Node-RED está corriendo** (ver siguiente sección).

> El script es idempotente: si lo ejecutas dos veces, solo actualiza el código
> del simulador, no duplica nodos.

## ⚠️ "Ejecuté el script pero no veo el flujo nuevo"

Es el fallo más confuso de Node-RED, y no tiene nada que ver con el script.

**Node-RED carga `flows.json` en memoria al arrancar.** Si está corriendo
cuando el script modifica el archivo:

- La interfaz sigue mostrando la versión **antigua** (la de memoria).
- El archivo en disco **sí está actualizado**… pero no se usa todavía.
- Peor: si guardas algo desde la interfaz, Node-RED **sobrescribe** tu archivo
  con su versión antigua y pierdes el cambio.

```
21:15  Node-RED arranca        → carga flows.json en memoria
21:47  el script modifica      → disco actualizado, memoria NO
21:47  miras la interfaz       → ves la versión vieja ❌
```

### Solución

**Reinicia Node-RED.** El script ahora detecta este caso y te avisa:

```
⚠️  Node-RED ESTÁ CORRIENDO.
   El archivo ya está actualizado en disco, pero Node-RED sigue
   usando la versión que cargó en memoria al arrancar:
   NO verás el flujo nuevo hasta que reinicies.
   → Reinicia Node-RED (Ctrl+C en su terminal y `node-red`).
```

### Cómo comprobar que el archivo SÍ se actualizó

Si dudas de si el cambio llegó al disco, compruébalo sin abrir Node-RED:

```bash
# ¿Existe la pestaña del simulador?
jq -r '.[] | select(.type=="tab") | .label' ~/.node-red/flows.json

# ¿Qué perfil tiene el nodo (y cuántas líneas de código)?
jq -r '.[] | select(.type=="function" and (.name // "" | test("SIMULADOR")))
       | "lineas: \(.func | split("\n") | length)"' ~/.node-red/flows.json
jq -r '.[] | select(.type=="function" and (.name // "" | test("SIMULADOR")))
       | .func' ~/.node-red/flows.json | grep "const PERFIL"
```

Salida esperada (el perfil nuevo tiene ~235 líneas):

```
lineas: 235
const PERFIL = "electrico";
```

Si esto sale bien, **el script funcionó**: solo falta reiniciar Node-RED.

## Instalación manual (equivalente)

### 1. Crear un nodo `inject`

| Campo | Valor |
|---|---|
| `msg.payload` | *(string vacío)* |
| Repeat | intervalo |
| Every | **15** (segundos) — ver aviso de rate limit |

### 2. Crear un nodo `function` **nuevo**

Pega `docs/node-red/simulador-sensor.js`. **No lo pegues en la función del
ESP32.**

### 3. Configurar el nodo `http request`

| Campo | Valor |
|---|---|
| Method | `POST` |
| URL | `http://localhost:4000/api/v1/iot/mediciones` |
| Headers | *(los pone el propio código en `msg.headers`)* |

### 4. Configurar la API Key

En `settings.js`:

```js
process.env.NODE_RED_API_KEY = "flx_...";
```

La clave debe tener el permiso **`mediciones:crear`**.

## Perfiles disponibles

El simulador trae **dos perfiles**. Se elige cambiando **una línea**:

```js
const PERFIL = "dht";        // o "electrico"
```

### Perfil `dht` — sensor ambiental

| Canal | Rango | Unidad |
|---|---|---|
| `DHT1W-TEMPERATURA` | 15–35 | °C |
| `DHT1W-HUMEDAD_RELATIVA` | 20–90 | % |

Temperatura y humedad se mueven **en oposición**, como un DHT22 real.

### Perfil `electrico` — analizador de red (230 V / 50 Hz)

| Canal | Rango | Unidad |
|---|---|---|
| `MEDIDOR-01-VOLTAJE` | 195–253 | V |
| `MEDIDOR-01-CORRIENTE` | 0–16 | A |
| `MEDIDOR-01-FRECUENCIA` | 49,5–50,5 | Hz |
| `MEDIDOR-01-POTENCIA` | *(calculada)* | W |

Salida típica:

```
      VOLTAJE   CORRIENTE  FRECUENCIA    POTENCIA
        227.9        3.55       49.98       768.6
        231.3        5.43       50.03      1193.2
        233.1        6.36       50.04      1408.4
```

#### La potencia NO es aleatoria (detalle importante)

En corriente alterna las magnitudes están ligadas por la física:

```
P = V · I · cos(φ)          (potencia activa)
```

Si se generaran voltaje, corriente y potencia por separado, la gráfica
mostraría **combinaciones imposibles** (230 V, 5 A y 300 W cuando deberían
ser ~1090 W) y cualquier análisis de consumo sería basura.

Por eso el simulador genera **V, I y f**, y **calcula la potencia** con un
factor de potencia de 0,95. En las pruebas la potencia cuadra con un error
máximo de **0,04 W** (solo por redondeo).

## Configuración del nodo

Cada perfil define sus magnitudes en el objeto `PERFILES`:

```js
const PERFIL = "electrico";   // ← cambia aquí

const PERFILES = {
  dht:       { dispositivo: "ESP32W",     lecturasPorCiclo: 40, magnitudes: [...] },
  electrico: { dispositivo: "MEDIDOR-01", lecturasPorCiclo: 30, magnitudes: [...] },
};
```

Cada magnitud acepta:

```js
{
  canal: "MEDIDOR-01-VOLTAJE",  // debe coincidir con canales.codigo
  tipo: "voltaje",
  base: 230,        // valor central
  amplitud: 4,      // cuánto se aleja en el ciclo
  ruido: 0.8,       // temblor de cada lectura
  min: 195, max: 253,
  decimales: 1,
}
```

> ⚠️ **Los códigos de canal deben coincidir exactamente** con
> `canales.codigo` en la base de datos. Si no, la API responde
> `fallidas: N` y la medición no se guarda (no da error visible).

## ⚠️ Rate limit: no uses 5 segundos

**Esto rompía la simulación sin dar ningún error visible.**

La API limita a **100 peticiones cada 15 minutos** por IP:

| Intervalo | Peticiones / 15 min | Resultado |
|---|---|---|
| cada 5 s | 180 | ❌ **HTTP 429** a partir del minuto 8 |
| cada 10 s | 90 | ⚠️ justo al límite |
| **cada 15 s** | 60 | ✅ recomendado |
| cada 20 s | 45 | ✅ |

El síntoma es engañoso: **el debug sigue mostrando la petición**, pero la
respuesta es `429` y **no se guarda nada**. Parece que el simulador funciona
cuando en realidad lleva minutos sin escribir.

Configura el `inject` con `Every = 15` para dejar margen y poder navegar por
la web (que consume del mismo límite). Si ves `429`, espera 15 minutos.

## Por qué los datos son creíbles

Un `Math.random()` plano produce **ruido blanco**: la gráfica sale como un
serrucho sin forma, sin tendencia. Este simulador combina tres componentes:

| Componente | Efecto en la gráfica |
|---|---|
| **Ciclo** (onda senoidal) | La forma: subidas y bajadas suaves |
| **Ruido** (pequeño) | El temblor propio del sensor |
| **Deriva** (acotada) | Variación lenta que se autocorrige |

Además, **humedad y temperatura se mueven en oposición** (correlación
negativa), como ocurre en un DHT22 real: cuando sube la temperatura, baja la
humedad relativa.

### Ejemplo de salida real

```
  #   Temperatura   Humedad
  1     26.7 C      58.1 %
  4     25.9 C      57.6 %
  7     25.1 C      54.8 %
 10     23.8 C      53.7 %
 12     22.7 C      52.2 %
```

Se ve la tendencia descendente en ambas magnitudes, con temblor de décimas.

## Qué se valida

El nodo garantiza:

- La clave **`valor` siempre existe** y es un número finito (el error
  `mediciones.0.valor: Invalid input` viene justo de omitirla).
- Los valores **nunca salen del rango físico** del sensor (15-35 °C, 20-90 %).
- El payload es **JSON serializable** (nunca produce `NaN`).
- Los valores **varían** entre lecturas (no repite el mismo número).

## Verificar que funciona

```bash
# Ejecuta el nodo fuera de Node-RED y envía a la API real
cd api && npx tsx scripts/smoke-simulador.mjs
```

Salida esperada:

```
  1) HTTP 201 |  21.2 C |  52.3 % | procesadas=2 fallidas=0
  ...
Total: 12 procesadas, 0 fallidas
Mediciones del simulador en BD (últimos 5 min): 12
```

Si aparece `fallidas > 0`, casi siempre es porque el **código de canal no
existe**: compruébalo con

```sql
SELECT d.identificador, c.codigo, c.unidad
FROM canales c
JOIN sensores s ON s.id = c.sensor_id
JOIN dispositivos d ON d.id = s.dispositivo_id;
```

## Ver los datos en la web

Con el simulador en marcha:

1. Abre `/sensores/<id-del-sensor>` y elige **Por minuto**.
2. El chart **En vivo** avanza cada 10 s.
3. Para una magnitud concreta, abre `/canales/<id-del-canal>`.

### Aviso importante sobre la media

Si miras el **sensor** sin filtrar por canal, la media **mezcla temperatura y
humedad** (p. ej. `(21 + 52) / 2 = 36.5`), que no significa nada físico.

Eso es correcto: el sensor agrupa las mediciones de todos sus canales. Para
analizar una magnitud, usa **el detalle del canal** o el chart de comparación,
donde cada canal va por separado.

## Detener el simulador

Desactiva el nodo `inject` (botón en la barra lateral de Node-RED) o cambia
`Repeat` a *none*.

## Diagnóstico rápido: "no me da simulación"

Sigue estos pasos **en orden**. El primero que falle es el problema.

### 1. ¿Llega algo al debug?

- **No llega nada** → el `inject` no dispara o el nodo no está conectado.
  Revisa que `Repeat` sea *interval* y `Every` tenga valor, y que exista un
  cable `inject → función → http request → debug`.
- **Llega el payload pero no hay respuesta HTTP** → red o URL (paso 3).

### 2. Un nodo sin cable de entrada NUNCA se ejecuta

Este fue el error real que costó más tiempo: la función del simulador estaba
colgada de un `mqtt in` que no recibía mensajes. El código era correcto, pero
**nadie la llamaba**.

Comprobación rápida en la terminal:

```bash
# ¿Llegan mensajes al tópico del ESP32?
# (si no llega nada, la función alimentada por MQTT jamás se ejecutará)
```

O en Node-RED: pasa el ratón por encima del nodo; debe tener una entrada
conectada y un `inject` que lo dispare.

### 3. ¿Aparece `fallidas` mayor que 0?

```bash
cd api && npx tsx scripts/smoke-simulador.mjs
```

Si sale `fallidas > 0`, el **código de canal no existe**:

```sql
SELECT d.identificador, c.codigo, c.unidad
FROM canales c
JOIN sensores s ON s.id = c.sensor_id
JOIN dispositivos d ON d.id = s.dispositivo_id;
```

### 4. ¿Hay datos en la base de datos?

```sql
SELECT count(*), max(registrado_en) AS ultima
FROM mediciones
WHERE metadatos->>'fuente' = 'simulador-node-red';
```

Si el contador crece, **el simulador funciona** aunque el chart todavía no lo
muestre (revisa que el rango de fechas incluya "hoy").

### 5. ¿El debug está filtrado por pestaña?

La barra de depuración puede estar mostrando solo los mensajes de una pestaña.
Cambia el filtro a **"all"** o a la pestaña del simulador.
