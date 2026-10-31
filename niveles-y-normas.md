# Niveles y normas

> Por qué una medición se guarda «cruda» y el nivel se calcula al leer.

## 1. La idea central

La plataforma es **genérica**: no sabe qué significa un valor hasta que
alguien le dice «esta magnitud, en este recinto, se rige por esta norma».

```
   MEDICIÓN CRUDA            REGLAS DEL CANAL            NIVEL
 ┌────────────────┐        ┌──────────────────┐      ┌───────────┐
 │ valor  24,3 °C │───────▶│ > 24  advertencia│─────▶│advertencia│
 │ calidad good   │        │ > 26  crítica    │      │           │
 │ hora           │        │ (reglas_alerta)  │      │           │
 └────────────────┘        └──────────────────┘      └───────────┘
   se guarda así            se leen al consultar         se pinta
```

**La medición guardada no cambia.** Solo tiene valor, unidad, hora y
`calidad`.

## 2. `calidad` no es `nivel`

Es la confusión más fácil de cometer, y la que motivó todo esto:

| | `calidad` | `nivel` |
|---|---|---|
| Pregunta | ¿el sensor entrega señal válida? | ¿el valor cumple las reglas? |
| Valores | `good` / `bad` | bueno / advertencia / crítico / falla |
| Ejemplo | lazo roto → `bad` | 25 °C con banda 20–24 → advertencia |
| ¿Se guarda? | **Sí**, en la tabla | **No**, se calcula al leer |

Por eso en la pantalla de Mediciones siempre salía `good`: el sensor
funcionaba bien aunque el valor estuviera fuera de norma.

> Un valor puede tener `calidad: good` y `nivel: critico`: el sensor mide
> correctamente, pero lo que mide es peligroso.

## 3. Los seis niveles

| Nivel | Significado |
|---|---|
| **bueno** | Ninguna regla se dispara |
| **advertencia** | Se dispara una regla `warning` |
| **crítico** | Se dispara una regla `critical` |
| **falla** | La calidad es `bad`: sensor averiado |
| **sin_datos** | No hay valor |
| **sin_regla** | El canal no tiene reglas activas |

### Por qué `falla` es distinto de `crítico`

Un sensor averiado envía `-32768` o una corriente por debajo de 3,6 mA.
Si se comparara con «temperatura < 18 °C» saldría **crítico**, y el
operario leería «hace mucho frío» cuando el problema es un cable roto.

### Bordes

El valor justo en el límite cuenta como **bueno**: con banda 20–24,
24,0 es bueno y 24,1 no. Si el límite contara como fuera, todos los
equipos en condiciones normales estarían en advertencia.

## 4. Una sola implementación

El nivel se calcula en **un único sitio**: `api/src/modules/reglas-alerta/nivel.ts`.

Lo usan:

- El cumplimiento del área
- La lista de mediciones
- Las tarjetas de canal
- Los eventos en tiempo real
- La vista previa del formulario de reglas (`POST /plantillas-alerta/evaluar`)

**La web nunca recalcula.** Si lo hiciera, el formulario podría mostrar
«Advertencia» y el panel «Bueno» para el mismo valor.

> El formulario de reglas consulta al backend con *debounce* de 400 ms
> precisamente por esto.

## 5. Qué regla manda

Cuando un canal tiene reglas propias, **mandan sobre la norma del área**:

```
TEMPERATURA 28,4 °C   banda 18–28   origen: "canal"
```

Alguien ajustó ese canal a propósito. Solo los canales sin reglas recurren
a la plantilla del área (`origen_reglas: "area"`).

## 6. Las normas son configurables

Viven en la tabla `plantillas_alerta`:

| Origen | Se crea desde | Se puede editar | Se puede borrar |
|---|---|---|---|
| `sistema` | JSON del repositorio | Sí | **No** |
| `usuario` | La web (`/normas`) | Sí | Sí |

Las de sistema no se borran porque el siguiente arranque las sembraría de
nuevo y reaparecerían sin explicación.

Al aplicar una norma a un área sus reglas se **copian** a `reglas_alerta`:
a partir de ahí son reglas normales, editables una a una.

Aplicar dos veces la misma norma no duplica: las reglas existentes se
informan como *repetidas*.

## 7. Accesibilidad

El nivel **siempre** se muestra con icono + texto, nunca solo color:

- Hay usuarios daltónicos (rojo y verde es el par más común).
- El panel puede estar en una pantalla de pared, visto de lejos.
- En una captura impresa el color puede perderse.

## 8. Archivos

| Archivo | Qué hace |
|---|---|
| `api/.../reglas-alerta/nivel.ts` | Clasificación + caché de reglas |
| `api/.../areas/cumplimiento.ts` | Cumplimiento por magnitud |
| `api/.../migrations/0020_plantillas_alerta.sql` | Tabla de normas |
| `api/.../plantillas-alerta/*` | CRUD, aplicar-área, evaluar |
| `web/.../utilidades/nivel.ts` | Estilos de los niveles |
| `web/.../components/nivel/badge-nivel.tsx` | Badge reutilizable |
| `web/.../components/normas/*` | Página de normas propias |

## 9. Comprobar que funciona

```bash
# 1. Aplicar la norma de quirófano a un área
POST /api/v1/plantillas-alerta/quirofano-ashrae-170/aplicar-area

# 2. Consultar el cumplimiento
GET /api/v1/areas/:id/cumplimiento
```

Debe devolver `nivel` y `origen_reglas` por magnitud, y `resumen` con
`bueno`, `advertencia`, `critico`, `falla`.

| Prueba | Nivel esperado |
|---|---|
| Valor dentro de la banda | bueno |
| 25 °C (banda 20–24) | advertencia |
| 27 °C | crítico |
| `-32768` | **falla**, no crítico |
