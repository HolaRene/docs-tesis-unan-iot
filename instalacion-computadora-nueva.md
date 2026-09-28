# Puesta en marcha en una computadora nueva

> Guía para levantar el proyecto después de un `git clone` / `git pull`.
>
> **El código no se basta solo: hay que crear las tablas.** Ese es el paso que
> más se olvida.

## ⚠️ En Windows: el error de `bash`

```text
> pnpm migrate
"bash" no se reconoce como un comando interno o externo,
programa o archivo por lotes ejecutable.
[ELIFECYCLE] Command failed with exit code 1.
```

**Ya está resuelto.** El script `scripts/migrate.sh` usaba `bash` y el binario
`psql`, que en Windows no vienen en el PATH. Se reescribió en TypeScript
(`scripts/migrate.ts`) usando el driver `pg` que el proyecto ya incluye.

`pnpm migrate` ahora funciona igual en **Windows, Linux y macOS**, sin instalar
nada adicional (ni Git Bash, ni las herramientas de línea de comandos de
PostgreSQL).

> Si en tu copia todavía falla con ese mensaje, es que tienes una versión
> antigua del proyecto: haz `git pull` para traer el script nuevo.

## El error típico

```text
[Error no controlado] error: no existe la relación «usuarios»
[watchdog] Error revisando dispositivos offline: no existe la relación «dispositivos»
POST /api/v1/users/registro 500
```

**No es un problema de relaciones ni de claves foráneas.** El código
`42P01` de PostgreSQL significa literalmente:

> `relation "usuarios" does not exist` → **la tabla no existe**.

El `git pull` trajo el código, pero **las migraciones no se ejecutan solas**.
La base de datos está vacía.

> El error del *watchdog* aparece cada 60 s y es el mismo problema: intenta
> marcar dispositivos offline y la tabla `dispositivos` tampoco existe. Los dos
> errores se arreglan con el mismo paso.

## Solución en 5 pasos

### 1. Requisitos

| Herramienta | Versión | Comprobar |
|---|---|---|
| Node.js | 20 o superior | `node -v` |
| pnpm | 9 o superior | `pnpm -v` |
| PostgreSQL | 14 o superior | Windows: `pgAdmin` o Servicios · Linux: `psql --version` |

> **Windows**: basta con tener PostgreSQL **instalado y en ejecución**. No hace
> falta añadir `psql` al PATH ni instalar Git Bash: las migraciones y el seed
> funcionan con Node.
>
> Aun así, si quieres usar `psql` cómodamente desde la terminal, añade
> `C:\Program Files\PostgreSQL\<version>\bin` al PATH.

### 2. Instalar dependencias

```bash
cd api && pnpm install
cd ../frontend && pnpm install
```

### 3. **Crear la base de datos vacía**

**Windows** (pgAdmin): clic derecho en *Databases* → *Create* → *Database…* →
nombre `monitoreo_iot_tesis` → *Save*.

**Linux / macOS**:

```bash
createdb monitoreo_iot_tesis
```

### 4. Configurar las variables de entorno

Crea el archivo `api/.env.development` (cópialo de `.env.example` si existe):

```ini
DATABASE_URL=postgresql://postgres:TU_CONTRASENA@localhost:5432/monitoreo_iot_tesis
JWT_SECRET=cualquier_cadena_larga_y_secreta
PORT=4000
NODE_ENV=development
```

> En Windows la contraseña puede contener caracteres que rompen la URL. Si el
> usuario o la clave llevan `@`, `:` o `/`, hay que codificarlos
> (`@` → `%40`).

### 5. **Aplicar las migraciones** ← el paso que faltaba

```bash
cd api
pnpm migrate
```

Debe terminar con:

```text
Migraciones aplicadas correctamente.
```

Y después cargar los datos iniciales (usuario admin y catálogo):

```bash
pnpm seed
```

Salida esperada:

```text
[seed] Usuario administrador creado: admin@monitoreo.local
[seed] Cámara de prueba creada: Cámara Quirófano 1 (/camara-qui-1)
```

### 6. Arrancar

```bash
# Terminal 1
cd api && pnpm dev

# Terminal 2
cd frontend && pnpm dev
```

Credenciales del admin: **`admin@monitoreo.local`** / **`Admin12345`**.

---

## ⚠️ AVISO IMPORTANTE: `pnpm migrate` borra datos

**Solo se ejecuta UNA VEZ, en una base de datos recién creada.**

La migración `0009_canales.sql` contiene un `TRUNCATE` que **vacía 11 tablas**:

```sql
TRUNCATE TABLE
  comandos_actuador, actuadores, claves_api, integraciones, camaras,
  alertas, umbrales, mediciones, sensores, dispositivos, areas
RESTART IDENTITY CASCADE;
```

Y `scripts/migrate.sh` aplica **todos** los archivos `.sql` en cada ejecución,
sin recordar cuáles ya se aplicaron. Por tanto:

| Situación | Qué pasa |
|---|---|
| Base de datos **recién creada** | ✅ Correcto. No hay nada que perder. |
| Base de datos **con datos** | ❌ **Se pierden** dispositivos, sensores, mediciones, cámaras, alertas y áreas |

**Qué se conserva** pese al `TRUNCATE`: `usuarios` y `tipos_variable`.

### Comprobado en la práctica

```text
ANTES:  camaras=1  usuarios=2
DESPUÉS de re-ejecutar `pnpm migrate`:
        camaras=0  usuarios=2      ← la cámara desapareció
```

### Regla práctica

- **¿La base de datos está vacía y es la primera vez?** → `pnpm migrate` sin miedo.
- **¿Ya tiene datos?** → **NO ejecutes `pnpm migrate`.** Para añadir una
  migración nueva, aplica a mano solo ese archivo:

  ```bash
  psql "$DATABASE_URL" -f src/database/migrations/00XX_nombre.sql
  ```

- **¿Necesitas datos de ejemplo?** → `pnpm seed` (crea el admin y la cámara de
  prueba; usa `ON CONFLICT`, así que se puede repetir sin duplicar).

---

## Cómo saber si las tablas existen

Antes de arrancar la API, comprueba que la migración funcionó:

```bash
psql "$DATABASE_URL" -c "\dt"
```

Debe listar **15 tablas**, entre ellas `usuarios`, `dispositivos`, `sensores`,
`mediciones`, `canales`, `areas` y `camaras`.

Consulta rápida:

```bash
psql "$DATABASE_URL" -t -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
```

Esperado: `15`.

---

## Checklist de diagnóstico

Si algo falla, revisa en este orden:

1. **`no existe la relación «X»`** → falta ejecutar `pnpm migrate`.
2. **`password authentication failed`** → la contraseña de `DATABASE_URL` no es
   correcta.
3. **`database "monitoreo_iot_tesis" does not exist`** → falta `createdb`.
4. **`psql: command not found`** → PostgreSQL no está en el `PATH` (en Windows,
   añade `C:\Program Files\PostgreSQL\<version>\bin`).
5. **La API arranca pero el registro da 500** → mira la consola: si vuelve a
   decir `no existe la relación «usuarios»`, la migración no se llegó a aplicar.
6. **CORS en el frontend** → añade el puerto del frontend a `CORS_ORIGINS` en
   `api/.env.development` (por ejemplo `http://localhost:3000`).

### Verificar que todo quedó bien

```bash
# 1. Las tablas existen (esperado: 15)
psql "$DATABASE_URL" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"

# 2. El admin existe (esperado: 1)
psql "$DATABASE_URL" -t -c "SELECT count(*) FROM usuarios WHERE email='admin@monitoreo.local';"

# 3. El catálogo de magnitudes (esperado: 16)
psql "$DATABASE_URL" -t -c "SELECT count(*) FROM tipos_variable;"

# 4. La API responde
curl http://localhost:4000/api/v1/health

# 5. El registro funciona (debe devolver exito: true)
curl -X POST http://localhost:4000/api/v1/users/registro \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Prueba","email":"prueba@test.local","password":"Prueba12345"}'
```
