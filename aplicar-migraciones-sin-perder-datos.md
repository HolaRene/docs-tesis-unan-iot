# Cómo aplicar migraciones sin borrar los datos

> La respuesta corta: **no hace falta perder nada**, y ya no hay que hacerlo
> a mano nunca más.

## 1. El problema

`pnpm migrate` re-ejecutaba **todas** las migraciones en cada pasada, porque
no llevaba registro de lo aplicado. Entre ellas:

| Migración | Qué destruye |
|---|---|
| `0009_canales.sql` | `TRUNCATE` de 11 tablas |
| `0010_tipos_variable_seed.sql` | `DELETE FROM tipos_variable` |

Ejecutarlo sobre una base con datos **los borra**. Ya pasó una vez.

## 2. La solución

`scripts/migrar-seguro.mjs` lleva una tabla `_migraciones_aplicadas` y ejecuta
**solo lo que falta**.

```bash
cd api
pnpm migrate           # aplica lo pendiente
pnpm migrate:dry       # muestra qué haría, sin ejecutar
pnpm migrate:baseline  # marca lo existente como aplicado (una sola vez)
pnpm respaldar         # copia de seguridad
```

### Salvaguardas

- **Detecta sentencias destructivas** y se niega a ejecutarlas.
- **Cada migración en su propia transacción**: si falla, se revierte solo esa.
- **Archivo vacío no cuenta como respaldo**: comprueba el tamaño real.

## 3. Procedimiento en tu máquina (primera vez)

Tu base ya tiene datos y no hay registro de qué se aplicó. El orden es:

### Paso 1 · Respaldo

```bash
cd api
pnpm respaldar
```

```
✓ Respaldo completado: 102.9 KB
  respaldos/monitoreo_iot_tesis_2026-10-21_22-48-11.sql
```

> **Verificado**: restauré ese respaldo en una base vacía y devolvió las
> 248 mediciones. No es un archivo que simplemente "se creó": se puede usar.

### Paso 2 · Ver qué falta

```bash
pnpm migrate:dry
```

Salida esperada en tu caso:

```
  Ya aplicadas: 0
  Pendientes:   19

    ⚠ 0009_canales.sql → TRUNCATE
    ⚠ 0010_tipos_variable_seed.sql → DELETE
    ...
  ABORTADO: hay migraciones que borran datos.
```

**Abortar aquí es correcto.** Significa que las salvaguardas funcionan.

### Paso 3 · Marcar lo que ya está

```bash
pnpm migrate:baseline
```

Marca las 19 como aplicadas **sin ejecutar ninguna**. Así la 0009 y la 0010
nunca vuelven a correr.

> ⚠️ El baseline asume que la estructura ya es la correcta. Compruébalo con
> el SQL del paso 4 antes de seguir.

### Paso 4 · Verificar la estructura

```sql
-- Todo debe devolver true / columnas existentes
SELECT EXISTS(SELECT 1 FROM information_schema.tables  WHERE table_name='alertas_retardo');
SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='areas'     AND column_name='perfil_alerta');
SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='reglas_alerta' AND column_name='histeresis');
SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='comandos_actuador' AND column_name='recogido_en');

-- Una que SÍ falta en tu base actual:
SELECT column_name FROM information_schema.columns
WHERE table_name='actuadores' AND column_name IN ('topico_mqtt','ultima_orden_en');
-- Si sale vacío, la 0015 no se aplicó nunca.
```

### Paso 5 · Aplicar lo que falte de verdad

Si el paso 4 muestra que faltan columnas, **no hace falta `psql`**:

```bash
pnpm migrate:forzar
```

Re-ejecuta todas las migraciones salvo las destructivas (0009 y 0010 quedan
excluidas siempre). Como son idempotentes, repetirlas no hace daño, y esto
repara una base a la que le faltan columnas aunque el registro diga lo
contrario.

Es segura: solo hace `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` y crea un
índice. **No borra nada.**

Después, márcala si quieres que el runner lo sepa (o déjalo: es idempotente).

## 4. A partir de ahora

Cuando añadas una migración nueva:

```bash
pnpm respaldar     # por si acaso
pnpm migrate:dry   # ver qué hará
pnpm migrate       # aplicar
```

Solo se ejecutará la nueva. Las antiguas quedan registradas y no se tocan.

## 5. Si algo sale mal

```bash
node scripts/restaurar.mjs respaldos/monitoreo_iot_tesis_FECHA.sql
```

No requiere `psql`: usa el mismo driver que la API.

> Restaurar **sobrescribe** la base con el contenido del respaldo. Todo lo
> creado después se pierde.

## 6. Resumen

| Pregunta | Respuesta |
|---|---|
| ¿Hay que borrar datos? | **No** |
| ¿Corro `pnpm migrate` a secas? | Solo después del `--baseline` |
| ¿La 0015 borra algo? | No: solo añade columnas e índices |
| ¿Qué nunca debo ejecutar sobre datos? | `0009` y `0010` |
| ¿El respaldo sirve? | Verificado: 248 → 248 al restaurar |


## 7. Windows

Todos los comandos funcionan igual. Se revisaron y corrigieron tres cosas que
**fallaban solo en Windows**:

| Problema | Causa | Solución |
|---|---|---|
| `pnpm build` fallaba | El `&&` del script no existe en `cmd.exe` | `scripts/build.mjs` |
| `pnpm test` ejecutaba 0 tests | `**` no se expande sin bash | `scripts/test.mjs` |
| `pg_dump` no se encontraba | No está en el PATH por defecto | Búsqueda automática |
| `pnpm migrate:bash` | Requería `bash` | **Eliminado** |

### `pg_dump` en Windows

El instalador de PostgreSQL **no añade `bin/` al PATH** salvo que marques la
casilla. El script ahora lo busca solo en:

```
C:\Program Files\PostgreSQL\<version>\bin\pg_dump.exe
```

Si aun así no lo encuentra, el mensaje te dice qué hacer:

1. Añadir esa carpeta al PATH y reabrir la terminal, **o**
2. Hacer la copia con **pgAdmin** → clic derecho en la base → *Backup*.

### Comandos en PowerShell

```powershell
cd api
pnpm respaldar
pnpm migrate:dry
pnpm migrate:baseline
pnpm migrate
```

Son idénticos a Linux/macOS: se ejecutan con `node`, nada de `bash`.

### Restaurar un respaldo en Windows

```powershell
node scripts/restaurar.mjs respaldos\monitoreo_iot_tesis_FECHA.sql
```

**No necesitas `psql` en el PATH.** Todos los comandos usan el driver `pg`,
que ya viene instalado con la API.


## 8. Si el baseline se aplicó en la base equivocada

### Qué síntoma tiene

La salida del script dice:

```
Base de datos: postgresql://postgres:***@localhost:5432/postgres
                                                        ^^^^^^^^
```

**`postgres` es la base administrativa**, no la del proyecto. El nombre
correcto aparece en `api/.env`, normalmente `monitoreo_iot_tesis`.

### Por qué es grave

El baseline **marca las 19 migraciones como aplicadas sin ejecutarlas**. Si se
hace en una base vacía, esa base queda con el registro, y la **base real del
proyecto sigue sin registrar nada**. El resultado es que nunca se aplican las
migraciones nuevas, y nadie se entera.

### Cómo arreglarlo en Windows

**Paso 1 · Comprobar a qué base apunta**

```powershell
cd api
Get-Content .env | Select-String "DATABASE_URL"
```

Si no aparece, crea `api\.env` con la línea correcta:

```ini
DATABASE_URL=postgresql://postgres:TU_CLAVE@localhost:5432/monitoreo_iot_tesis
```

> El script también lee `.env.development`. Si ese archivo apunta a un sitio,
> `.env` a otro y no coinciden, ejecuta siempre desde `api/` para que se lea
> el correcto.

**Paso 2 · Deshacer el baseline en la base equivocada**

```powershell
node scripts/desmarcar.mjs --base postgres
```

No borra datos del proyecto: esa tabla solo contenía el registro falso.

**Paso 3 · Verificar que es la base correcta**

```powershell
pnpm esquema
```

Si sale un número, es la base buena.

**Paso 4 · Repetir el baseline en la correcta**

```powershell
pnpm migrate:dry        # debe decir "Tablas del proyecto encontradas: 5 de 5"
pnpm migrate:baseline
```

### Salvaguarda a partir de ahora

El script **aborta** si la base indicada no contiene ninguna de estas tablas:

```
areas, dispositivos, mediciones, usuarios, tipos_variable
```

```
⛔ ABORTADO: esta base no parece la del proyecto.
   No contiene ninguna de estas tablas: areas, dispositivos, ...
```

En ese caso no marca nada y no ejecuta nada.

## Archivos

| Archivo | Qué hace |
|---|---|
| `api/scripts/migrar-seguro.mjs` | Runner con tabla de control |
| `api/scripts/respaldar.mjs` | Respaldo con `pg_dump` verificado |
| `api/package.json` | `migrate`, `migrate:dry`, `migrate:baseline`, `respaldar` |
