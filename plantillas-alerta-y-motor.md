# Plantillas de alerta y motor de evaluación

> Cómo se cargan reglas por perfil de entorno y cómo se deciden las alarmas.

## 1. Lo que la tabla pide y lo que el sistema hacía

La propuesta distinguía dos cosas que hasta ahora no estaban separadas:

| | Antes | Ahora |
|---|---|---|
| **Umbrales por perfil** | Se configuraban a mano, regla por regla | Plantillas por perfil |
| **Retardo** (`retardo_segundos`) | **El campo existía pero nadie lo leía** | Funcional |
| **Histéresis** | No existía | Funcional |
| **Estados** | `active` → `resolved` | `active` → `acknowledged` → `resolved` |

> **Advertencia importante para la tesis**: `retardo_segundos` se guardaba
> desde antes, pero era un campo decorativo. Citarlo como implementado antes
> de este cambio habría sido incorrecto.

## 2. El motor de alertas (ISA-18.2 / IEC 62682)

`api/src/modules/alerts/motor-alertas.ts` — funciones puras, sin BD ni relojes
ocultos.

### Retardo

Una condición debe mantenerse N segundos antes de abrir la alerta.

```
t=0    30 °C  → cumple, arranca cronómetro → esperar
t=30   30 °C  → sigue cumpliendo            → esperar
t=60   30 °C  → venció el retardo           → ABRIR
```

El cronómetro vive en la tabla `alertas_retardo`, que se limpia al abrir la
alerta o al dejar de cumplirse la condición.

**Sin esto**, un pico de un segundo genera una alarma que alguien debe
atender a mano.

### Histéresis

El umbral para **cerrar** es distinto del de **abrir**.

Banda 20–24 °C e histéresis 0,5:

| Valor | ¿Abierta? | Acción |
|---|---|---|
| 24,1 | no | **Abrir** (fuera de banda) |
| 23,99 | sí | **Mantener** (aún no entró de verdad) |
| 23,4 | sí | **Resolver** (dentro de 20,5–23,5) |

**Sin esto**, un valor oscilando en el borde abre y cierra la alerta en cada
medición: decenas de avisos por minuto.

### Estados

Una alerta se puede **reconocer** (`acknowledged`) sin cerrarla. Solo se
resuelve cuando la condición deja de cumplirse.

`buscarActivaPorRegla` ahora considera abiertas tanto `active` como
`acknowledged`. Antes, reconocer una alerta hacía que la siguiente medición
creara **otra** alerta duplicada.

## 3. Un fallo que solo apareció contra la base real

Los tests unitarios pasaban, pero en la API real la alerta **no se cerraba**.

**Causa**: PostgreSQL devuelve las columnas `NUMERIC` como **string** al
driver `pg`, no como número.

```js
"20" + 0.5   // → "200.5"   (concatenación, no suma)
```

La banda de cierre se hacía enorme y ningún valor la cumplía.

**Por qué no lo detectaron los tests**: en las pruebas los valores eran
números de JavaScript. Con `20` y `0.5` funciona; con `"20"` y `"0.5000"` no.

Se corrige con una conversión explícita (`aNumero`) y **5 tests de regresión**
que pasan los valores como string, tal como llegan de la base.

> **Lección**: una función pura puede ser correcta y aun así fallar en
> producción, si el test no usa el mismo tipo de dato que la base.

## 4. Plantillas por perfil

Viven en `api/src/plantillas-alerta/*.json`. **Añadir un perfil es añadir un
archivo**: no requiere tocar código.

| Perfil | Reglas | Norma |
|---|---|---|
| `quirofano-ashrae-170` | 7 | ASHRAE 170 |
| `sala-limpia-iso-14644` | 6 | ISO 14644-1 · EU GMP Anexo 1 |
| `centro-datos-ashrae-tc99` | 5 | ASHRAE TC 9.9 |
| `cadena-frio-vacunas` | 4 | Reglamento sanitario aplicable |

### Cómo se aplican

```
POST /api/v1/plantillas-alerta/:id/aplicar  { "canal_id": "..." }
```

Crea **reglas normales** en `reglas_alerta`. A partir de ahí se editan una a
una sin quedar atadas a la plantilla.

### Filtrado por tipo de variable

Cada regla de la plantilla declara `tipos_variable`. Al aplicarla a un canal
solo se crean las que encajan, y se informa de las omitidas:

```
Aplicando «Quirófano» a un canal de TEMPERATURA:
  creadas: 2
  omitidas: humedad_relativa, presion_diferencial, co2
```

Es mejor **no crear** una regla de temperatura en un canal de presión que
crearla mal.

## 5. Valores marcados `[verificar]`

Se conservaron las marcas de la propuesta original. Son valores que **no**
están confirmados en la norma y deben contrastarse antes de usarlos en un
entorno real:

| Valor | Dónde | Estado |
|---|---|---|
| Presión positiva ≥ 2,5 Pa | Quirófano | Por confirmar |
| Presión 10–15 Pa entre zonas | Sala limpia | Por confirmar |
| 18–24 °C en sala limpia | Sala limpia | Depende del proyecto |
| 2–8 °C / −18 °C | Cadena de frío | Depende de la autoridad sanitaria |
| Humedad mínima 20 % | Centro de datos | Referencia operativa |

**Confirmados en fuente**: temperatura y humedad de quirófano (ASHRAE 170),
clases de partículas (ISO 14644-1), envolvente 18–27 °C (TC 9.9).

**Ninguno** de los retardos, histéresis ni severidades viene de una norma: son
propuestas del proyecto, tal como pedía ISA-18.2 (que exige definirlos, no
impone valores).

## 6. Verificación

| Prueba | Resultado |
|---|---|
| Retardo: alerta no abre antes de 60 s | ✅ |
| Retardo: abre al vencer | ✅ |
| Histéresis: 24,3 mantiene la alerta | ✅ |
| Histéresis: 23,0 resuelve la alerta | ✅ |
| Valores `NUMERIC` como string | ✅ (5 tests nuevos) |
| Plantillas filtradas por tipo | ✅ 2 creadas, 5 omitidas |
| Retardo e histéresis persistidos | ✅ |
| Tests | **162/162** |
| Build copia los JSON a `dist/` | ✅ |

## 7. Archivos

| Archivo | Cambio |
|---|---|
| `api/.../migrations/0017_histeresis_reglas.sql` | Columna `histeresis` + tabla `alertas_retardo` |
| `api/.../alerts/motor-alertas.ts` | **Nuevo**: motor con retardo e histéresis |
| `api/.../alerts/motor-alertas.test.ts` | **Nuevo**: 22 tests |
| `api/.../alerts/alert.service.ts` | Usa el motor |
| `api/.../alerts/alert.repository.ts` | Cronómetro y alertas reconocidas |
| `api/src/plantillas-alerta/*.json` | **Nuevos**: 4 perfiles |
| `api/.../plantillas-alerta/*` | **Nuevo**: servicio, rutas |
| `api/package.json` | El build copia los JSON a `dist/` |
| `frontend/.../selector-plantilla.tsx` | **Nuevo**: UI para aplicar |

## 8. Añadir un perfil nuevo

Crea `api/src/plantillas-alerta/mi-perfil.json`:

```json
{
  "id": "mi-perfil",
  "nombre": "Mi entorno",
  "descripcion": "…",
  "norma": "…",
  "notas": ["…"],
  "reglas": [
    {
      "variable": "temperatura",
      "tipos_variable": ["TEMPERATURA"],
      "nombre": "Temperatura fuera de rango",
      "operador": "fuera_de_rango",
      "valor_min": 18,
      "valor_max": 24,
      "severidad": "warning",
      "retardo_segundos": 60,
      "histeresis": 0.5,
      "mensaje": "…"
    }
  ]
}
```

Reinicia la API y aparece en la lista. No hay que tocar código.

> **Cuidado con `entre`**: en este sistema avisa cuando el valor **está
> dentro**. Para expresar una banda aceptable usa siempre `fuera_de_rango`.
