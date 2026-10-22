# Cómo desplegar y cómo comprobar el cumplimiento normativo

> Respuestas a: ¿corro `pnpm migrate`?, ¿cómo sé que se aplica la norma?

## 1. ¿Debo correr `pnpm migrate`?

### **No.**

`pnpm migrate` **re-ejecuta TODAS las migraciones**, no solo las nuevas. Y entre
ellas está `0009_canales.sql`, que contiene un `TRUNCATE` de 11 tablas.

```
áreas, dispositivos, sensores, canales, mediciones,
actuadores, cámaras, alertas…
```

El propio script avisa antes de ejecutar:

```
Este script re-ejecuta todas las migraciones (no hay tabla de control);
0009 contiene TRUNCATE y borrará los datos existentes.
```

### Qué hacer en su lugar

**Aplica solo la migración pendiente**, una a una:

```bash
cd api

# 0017 (si no la aplicaste antes)
psql "$DATABASE_URL" -f src/database/migrations/0017_histeresis_reglas.sql

# 0018 (nueva)
psql "$DATABASE_URL" -f src/database/migrations/0018_perfil_area_y_origen_reglas.sql
```

Ambas son **idempotentes**: llevan `IF NOT EXISTS`, así que ejecutarlas dos
veces no hace nada la segunda vez.

### Comprobar si ya están aplicadas

Sin ejecutar nada:

```sql
-- 0017
SELECT EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_name='reglas_alerta' AND column_name='histeresis');

SELECT EXISTS(SELECT 1 FROM information_schema.tables
  WHERE table_name='alertas_retardo');

-- 0018
SELECT EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_name='areas' AND column_name='perfil_alerta');

SELECT EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_name='reglas_alerta' AND column_name='plantilla_id');
```

**En esta máquina, las dos ya están aplicadas** y los datos siguen intactos
(247 mediciones).

> `pnpm migrate` solo es seguro en una base **vacía** o recién creada.

## 2. ¿Cómo sé que se aplica la norma?

Hay tres niveles de comprobación, de más general a más concreto.

### a) El perfil del área (qué norma le aplica)

```bash
PATCH /api/v1/areas/:id
{ "perfil_alerta": "quirofano-ashrae-170" }
```

Sin perfil declarado no hay nada contra lo que comparar: cada recinto se
somete a una norma distinta y no se puede adivinar.

### b) El cumplimiento en vivo (el semáforo)

```bash
GET /api/v1/areas/:id/cumplimiento
```

```json
{
  "perfil": { "nombre": "Quirófano (ASHRAE 170)", "norma": "ASHRAE 170 — …" },
  "resumen": { "total": 1, "cumple": 0, "fuera": 1, "sin_datos": 0, "sin_regla": 0 },
  "magnitudes": [
    {
      "tipo_codigo": "TEMPERATURA",
      "valor": 28.4,
      "unidad": "°C",
      "banda": "20 – 24",
      "estado": "fuera",
      "requiere_verificacion": false
    }
  ]
}
```

En la web aparece como una tarjeta **«Cumplimiento normativo»** en la vista
del área, con un semáforo por magnitud.

### c) La trazabilidad de cada regla (de dónde sale)

Cuando una regla se crea desde una plantilla, se guarda su origen:

| Campo | Ejemplo |
|---|---|
| `plantilla_id` | `quirofano-ashrae-170` |
| `norma` | `ASHRAE 170 — Ventilación de instalaciones de salud` |
| `requiere_verificacion` | `true` si el valor llevaba `[verificar]` |

Las reglas creadas a mano tienen `plantilla_id = NULL`: así se distingue una
regla **de norma** de una **del proyecto**.

## 3. Los cuatro estados del semáforo

| Estado | Significado |
|---|---|
| **Cumple** | El último valor está dentro de la banda del perfil |
| **Fuera** | El último valor sale de la banda |
| **Sin datos** | La magnitud existe pero nunca se ha medido |
| **Sin regla** | El perfil no define banda para esa magnitud |

### Dos avisos que la interfaz muestra siempre

**Dato antiguo**: si la última medición tiene más de 15 minutos se marca en
ámbar.

> Decir «cumple» con un dato de hace tres días es peor que no decir nada: da
> una falsa sensación de seguridad.

**Umbral sin confirmar**: si la regla viene de un valor marcado `[verificar]`,
se avisa en la propia fila.

## 4. Qué NO demuestra el semáforo

Conviene tenerlo claro para la defensa:

- **No certifica** el cumplimiento: eso exige ensayos acreditados
  (ISO 14644-3 para salas limpias, por ejemplo).
- **No sustituye** al sistema de alarmas: el semáforo da una foto del último
  valor; las alarmas aplican retardo e histéresis sobre toda la serie.
- **Depende de la cobertura**: si el área no tiene sensor de presión, la
  presión aparecerá como «sin regla» aunque la norma la exija.

## 5. Cómo añadir un perfil nuevo

Crea `api/src/plantillas-alerta/mi-perfil.json`, reinicia la API y aparecerá
en la lista. No requiere migración ni cambios de código.

Luego asigna ese perfil al área con el `PATCH` del punto 2a.

## Archivos

| Archivo | Cambio |
|---|---|
| `api/.../migrations/0018_perfil_area_y_origen_reglas.sql` | Perfil del área + origen de regla |
| `api/.../areas/cumplimiento.ts` | Cálculo de cumplimiento (puro) |
| `api/.../areas/cumplimiento.test.ts` | 10 tests |
| `api/.../areas/area.repository.ts` | `ultimosValoresPorMagnitud` |
| `api/.../areas/area.service.ts` | `cumplimiento()` |
| `frontend/.../areas/cumplimiento-area.tsx` | Tarjeta de semáforo |
