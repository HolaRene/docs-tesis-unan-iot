# Formulario de reglas de alerta

> Cómo se eligen las condiciones de una alerta y por qué cambiaron.

## El problema anterior

Las condiciones se elegían en un `<select>` nativo, con la etiqueta generada
por un ternario anidado:

```tsx
<option key={op} value={op}>
  {op === ">" ? "mayor que"
   : op === ">=" ? "mayor o igual"
   : op === "<" ? "menor que"
   : op === "<=" ? "menor o igual"
   : op === "=" ? "igual"
   : op === "entre" ? "entre"
   : "fuera de rango"}
</option>
```

Siete ramas en una línea. Y el usuario solo veía texto suelto en un
desplegable: había que abrirlo para saber qué opciones existían.

## El diseño nuevo

### 1. Catálogo de operadores

Cada operador es un objeto con **símbolo**, **etiqueta** y **descripción**:

```ts
{
  valor: ">",
  simbolo: ">",
  etiqueta: "Mayor que",
  descripcion: "Avisar cuando supere el límite",
  Icono: ArrowUp,
}
```

Con eso se puede pintar mejor, explicar cada opción y reutilizarlo.

### 2. Selector visual de condición

Botones en rejilla en lugar de un desplegable: **se ven todas las opciones a
la vez**, con su símbolo grande, y se elige en un clic.

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ [>] Mayor que│ │ [≥] Mayor o  │ │ [<] Menor que│
│  Avisar si   │ │    igual     │ │  Avisar si   │
│  supera      │ │  Avisar al   │ │  baja        │
└──────────────┘ └──────────────┘ └──────────────┘
```

El símbolo se muestra en su propia caja porque es lo que se lee de un vistazo
al repasar las reglas de un canal.

### 3. Vista previa en lenguaje natural

```
Regla:  Temperatura alta  se activará cuando el valor esté
        por encima de 30 °C   ·   [⚠ Aviso]
```

Sirve para detectar el error más común al configurar umbrales: **confundir el
sentido de la comparación**. «Mayor que 30» y «Menor que 30» se diferencian
en una letra y disparan en situaciones opuestas.

### 4. Severidad visual

Tres botones con color propio en lugar de un desplegable:

| | Severidad | Detalle | Color |
|---|---|---|---|
| ℹ | Informativa | Solo registra el aviso | Azul |
| ⚠ | Aviso | Requiere atención pronto | Ámbar |
| 🚨 | Crítica | Actúa de inmediato | Rojo |

### 5. Validación antes de enviar

- El botón de crear se desactiva hasta que hay nombre y referencia.
- Un aviso explica **qué falta**, en lugar de un error genérico al guardar.
- Un rango con el mínimo mayor que el máximo se marca en el momento.

## El fallo que apareció al revisar

Probando el formulario descubrí que el backend **aceptaba rangos invertidos**:

```json
{ "operador": "entre", "valor_min": 60, "valor_max": 40 }
```

Se guardaba sin error y aparecía como configurada en la interfaz. Pero la
evaluación es `v >= min && v <= max`:

| Valor | ¿Avisa? |
|---|---|
| 0, 20, 40, 50, 60, 80, 100 | **No. Nunca.** |

Ningún número puede ser a la vez `>= 60` y `<= 40`. **La regla no dispara
jamás**, y no hay ningún aviso de ello.

Es de los peores fallos posibles: el usuario cree estar protegido y no lo
está.

### La corrección

Validación en el esquema de creación y de actualización:

```
El valor mínimo no puede ser mayor que el máximo: la regla nunca se cumpliría
```

Y un hueco más que apareció al escribir los tests: una actualización con
`{ valor_min: 60, valor_max: 40 }` **sin operador** también se colaba. Ahora,
si llegan los dos extremos, el rango se valida siempre.

## Verificación

| Prueba | Resultado |
|---|---|
| Vista previa vs. evaluación real del backend | 10/10 coinciden |
| Rango invertido en la API | **Rechazado** con mensaje claro |
| Rango correcto | Se crea con normalidad |
| Rango sin un extremo | Rechazado |
| Actualización parcial de un extremo | Permitida (se valida en el servicio) |
| Tests | **140/140** (8 nuevos) |
| `tsc` · `lint` · `build` | Correcto |

## Archivos

| Archivo | Cambio |
|---|---|
| `frontend/.../reglas-alerta/formulario-regla.tsx` | Reescrito |
| `api/.../reglas-alerta/regla-alerta.schema.ts` | `validarRango` en creación y actualización |
| `api/.../reglas-alerta/regla-alerta.schema.test.ts` | **Nuevo**: 8 tests de regresión |

---

# Detalle de la lista de reglas

## El problema

La lista de reglas de un canal mostraba el operador **crudo**:

```
Temperatura alta · >
Humedad baja · <
Rango seguro · entre
```

Falta lo único que distingue una regla de otra: **el valor al que dispara**.
Dos reglas «Temperatura alta», una con `>` y otra con `>=`, se veían casi
iguales y ninguna decía si el umbral era 30 o 35.

## La solución

Cada regla muestra ahora el símbolo, la expresión completa y una frase:

```
┌──┐ Temperatura alta   > 30 °C                    [⚠ Aviso]
│> │ Se activa cuando el valor esté por encima de 30 °C
└──┘

┌──┐ Rango seguro   18 – 24 °C                    [🚨 Crítica]
│↔ │ Se activa cuando el valor esté entre 18 °C y 24 °C
└──┘
```

Se añade además:

- Badge con la severidad y su color.
- Badge «Inactiva» cuando la regla está desactivada.
- El retardo, si lo tiene (`tras 30s`).
- El mensaje configurado, entre comillas.

## Una sola fuente de verdad

`src/utilidades/reglas-alerta.ts` concentra:

| Función | Devuelve | Para qué |
|---|---|---|
| `operadoresDe(tipo)` | catálogo según el tipo de dato | Selector y búsqueda |
| `buscarOperador(tipo, op)` | definición del operador | Símbolo y etiqueta |
| `expresionCondicion(regla, u)` | `> 30 °C` | Columna compacta |
| `resumenCondicion(regla, u)` | `esté por encima de 30 °C` | Frase explicativa |

**Por qué importa**: antes el formulario tenía su propio catálogo y su propia
función de vista previa, y la lista solo pintaba el operador crudo. Tres
lugares que podían desincronizarse. Ahora hay uno solo, y tanto el formulario
como la lista leen de ahí.

## Cómo se describe cada operador

| Operador | Expresión | Frase |
|---|---|---|
| `>` | `> 30 °C` | esté por encima de 30 °C |
| `>=` | `≥ 35 °C` | llegue o supere 35 °C |
| `<` | `< 40 %` | esté por debajo de 40 % |
| `<=` | `≤ 18 °C` | llegue o baje de 18 °C |
| `=` | `= 25 °C` | sea exactamente 25 °C |
| `entre` | `18 – 24 °C` | esté entre 18 °C y 24 °C |
| `fuera_de_rango` | `fuera de 20 – 60 %` | quede fuera del rango 20 % – 60 % |
| `es_true` | `activo` | esté activo |
| `es_false` | `inactivo` | esté inactivo |
| `contiene` | `contiene «error»` | contenga «error» |

## Archivos

| Archivo | Cambio |
|---|---|
| `frontend/src/utilidades/reglas-alerta.ts` | **Nuevo**: catálogo y descripción |
| `frontend/src/components/reglas-alerta/lista-reglas-canal.tsx` | **Nuevo**: lista detallada |
| `frontend/src/components/canales/detalle-canal.tsx` | Usa la lista nueva; se elimina la antigua |
| `frontend/src/components/reglas-alerta/formulario-regla.tsx` | Usa la utilidad compartida |
