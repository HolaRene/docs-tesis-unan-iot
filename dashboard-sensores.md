# Dashboard: estado de los sensores

> Cómo se muestra el valor actual de cada magnitud, con icono, semáforo de
> frescura y mini-gráfico.

## Qué hay en el dashboard

| Bloque | Contenido |
|---|---|
| Métricas | Áreas, dispositivos conectados, sensores, alertas activas |
| **Estado de los sensores** | Una tarjeta por magnitud |
| **Actuadores** | Control según el tipo de actuador |
| **Actividad de mediciones** | Barras por hora o por día |
| Últimas mediciones | Tabla de registros recientes |
| Dispositivos recientes | Lista con estado |
| Alertas recientes | Lista con severidad |

## Actividad de mediciones

### El fallo que tenía

La gráfica se calculaba con `ultimas_mediciones` del resumen, que son **solo
10 filas**. Con datos dispersos, esas 10 mediciones suelen caer en la **misma
hora**, así que el gráfico dibujaba **una única barra** y parecía vacío.

Además, las mediciones más antiguas ni siquiera se pedían, así que no había
forma de ver la actividad real.

| | Antes | Ahora |
|---|---|---|
| Fuente | 10 mediciones en el navegador | Agregación en SQL |
| Barras | **1** | **23** |
| Mediciones contadas | 10 | **5.473** |

### Cómo funciona ahora

Se pide la agregación a `GET /measurements/series`, que cuenta **todas** las
mediciones del periodo. Hay un selector **Por hora** (24 h) y **Por día**
(14 días).

### Barras en lugar de línea

La actividad es un **recuento** por intervalo, no una magnitud continua:

- Una línea entre dos horas sugiere valores intermedios que no existen.
- Con cubos vacíos, la línea los "atraviesa" y **disimula el parón**.

Con barras, la ausencia de barra **es** el dato.

### Los huecos se ven

El backend solo devuelve cubos **con** datos. Si se pintaran tal cual, dos
horas separadas por un día aparecerían pegadas y el eje mentiría.

Se genera la malla temporal completa, y los cubos vacíos se dibujan con una
**barra mínima translúcida**: así se distingue «esta hora no hubo datos» de
«el gráfico termina aquí».

## Actuadores

Cada actuador se dibuja con **el control que le corresponde**, no con una
tarjeta uniforme.

| Forma | Tipos | Control |
|---|---|---|
| **Interruptor** | relé, LED, motor, ventilador | Un botón que alterna |
| **Pulsador** | buzzer, sirena, baliza | «Hacer sonar» / «Silenciar» |
| **Multi** | válvula, puerta, cerradura | Abrir / Cerrar |

### Por qué no todos igual

Un **buzzer** no se «enciende y se queda encendido»: se hace sonar. Un
interruptor no representa esa acción. Una **válvula** puede tener más de dos
posiciones. Y un actuador de solo lectura no debe mostrar un botón que no hace
nada.

### El widget se elige por palabra clave

El campo `tipo` es **texto libre** en la base de datos (no hay catálogo
cerrado). Si se comparara por lista exacta, cualquier tipo nuevo caería en el
genérico.

Emparejando por palabra clave, funciona sin tocar código:

```
zumbador        → pulsador     "Hacer sonar"
electrovalvula  → multi        "Abrir"
ventilador      → interruptor  "Arrancar"
desconocido_xyz → interruptor  "Activar"   (genérico, nunca vacío)
```

### El estado activo tiene sinónimos

`estado_actual` también es texto libre, así que cada tipo reconoce sus propias
palabras: `on`, `encendido`, `abierto`, `running`…

Un estado **vacío NO se considera activo**: es más seguro mostrar «apagado»
que dar por hecho que algo está en marcha.

> **El comando es asíncrono.** Pulsar un botón no acciona el equipo: el comando
> se encola y lo entrega Node-RED o el propio equipo. Por eso la tarjeta
> muestra el **último estado confirmado**, no el que se acaba de pedir.


## Las tarjetas de magnitud

```
┌─────────────────────────────────────┐
│ 🌡  Temperatura            ● Al día │
│    ESP32-W                          │
│                                     │
│    26.1 C              [ C ]        │
│    ╱╲╱‾╲╱╲                           │
│    Última hora                      │
│                                     │
│    Medido hace 2 min    Ver sensor  │
└─────────────────────────────────────┘
```

Cada tarjeta muestra:

| Elemento | Para qué |
|---|---|
| **Icono** | Reconocer la magnitud sin leer |
| **Valor + unidad** | El dato que interesa |
| **Semáforo** | Si el dato es reciente o el sensor dejó de enviar |
| **Mini-gráfico** | Contexto de la última hora |
| **Antigüedad** | "hace 2 min", "hace 9 días" |

### De dónde salen los datos

De **`/canales`**, que ya devuelve en cada fila el último valor
(`ultimo_valor_numerico`) y su fecha (`ultimo_registrado_en`). No hace falta
una consulta por canal.

> **Alternativa descartada**: derivar las magnitudes de `ultimas_mediciones`.
> Ese endpoint devuelve solo las N mediciones más recientes, así que un canal
> sin actividad aparecería **desaparecido** del panel… justo cuando más
> interesa verlo, para notar que dejó de enviar.

## El semáforo de frescura

Es lo que distingue «el sensor está bien» de «el sensor dejó de enviar hace
tres días». Sin él, un panel lleno de números parece correcto aunque los datos
sean de la semana pasada.

| Color | Estado | Umbral | Significa |
|---|---|---|---|
| 🟢 Verde | Al día | < 2 min | El equipo envía con normalidad |
| 🟡 Ámbar | Con retraso | < 15 min | Puede ser normal si el envío es lento |
| 🔴 Rojo | Sin datos recientes | > 15 min | El equipo casi seguro dejó de enviar |

Los umbrales están en `UMBRAL_FRESCO_MS` y `UMBRAL_RETRASADO_MS`
(`src/utilidades/magnitudes-visual.ts`).

### Detalles de la implementación

- **Reloj compartido**: todas las tarjetas reciben el MISMO instante de
  referencia. Si cada una usara su propio `Date.now()`, dos tarjetas con el
  mismo dato podrían mostrar antigüedades distintas.
- **Fecha futura**: si el equipo tiene el reloj adelantado, el dato se trata
  como fresco. Es más razonable que marcarlo como error.
- **Sin fecha**: se muestra "Sin datos", nunca un error.

## Los iconos

Se eligen por **palabra clave**, no por lista cerrada. Una magnitud nueva
("PM2.5", "CAUDAL"…) encuentra icono sin tocar el código.

| Palabra en el código o nombre | Icono |
|---|---|
| temperatura, temp | 🌡 Thermometer |
| humedad, humidity | 💧 Droplets |
| co2, voc, aire, gas | 🌬 Wind |
| presion, hpa | ⏱ Gauge |
| voltaje, tension | ⚡ Zap |
| corriente, amperaje | 📈 Activity |
| potencia, watt | 🔋 BatteryCharging |
| frecuencia, hz | 📻 Radio |
| nivel, llenado | 📏 Ruler |
| caudal, flujo | 🌊 Waves |
| motor, bomba | ⏻ Power |
| enchufado, rele | 🔌 Plug |

Sin coincidencia → icono genérico. **Nunca queda vacío.**

## Formato de los valores

Los decimales se ajustan por unidad, porque mostrar siempre uno produce dos
problemas opuestos:

| Unidad | Decimales | Motivo |
|---|---|---|
| Hz, A | 2 | 50,05 y 50,94 Hz se verían **iguales** con uno |
| V, W, °C, % | 1 | Más precisión no aporta: el sensor no la tiene |
| ppm | 0 | Los enteros son suficientes |

Los valores grandes se abrevian: `1491.5 W → 1.49 kW`.

## Bug corregido: el dashboard devolvía error 500

El resumen fallaba con:

```
could not determine data type of parameter $1
```

**Causa**: las consultas de mediciones y alertas filtran por dueño con `$1`
solo cuando el usuario **no** es admin, pero el `LIMIT` estaba fijo como `$2`.
Como admin, el SQL no tenía ningún `$1` y **se le seguía pasando un `null`**
como primer parámetro. Postgres no podía deducir el tipo de un parámetro que
la consulta no usaba.

**Solución**: numerar el `LIMIT` según haya filtro o no:

```ts
const nLimite = total ? 1 : 2;   // 1 = admin (sin filtro), 2 = usuario
// ...
LIMIT $${nLimite}
```

Así la cantidad de parámetros coincide **siempre** con los que usa el SQL.

Hay **5 tests de regresión** en
`api/src/modules/dashboard/dashboard.params.test.ts` que cuentan los
marcadores `$n` del SQL y los comparan con los parámetros enviados.

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `src/components/dashboard/panel-magnitudes.tsx` | Panel con filtros y rejilla |
| `src/components/dashboard/tarjeta-magnitud.tsx` | Tarjeta individual |
| `src/utilidades/magnitudes-visual.ts` | Iconos, frescura y formato |

### Endpoints usados

| Endpoint | Para qué |
|---|---|
| `GET /dashboard/resumen` | Métricas y listas |
| `GET /canales` | Valor actual de cada magnitud |
| `GET /sensors/:id/series?intervalo=minuto&canal_id=…` | Mini-gráfico de la última hora (en el dashboard) |

> `/canales` devuelve un **array directo** en `datos`, no un objeto con clave
> `canales`. Confundirlo hace que el panel salga vacío **sin dar error**.
