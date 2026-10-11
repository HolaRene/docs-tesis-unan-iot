# Errores de Base UI y validación

> Dos fallos corregidos: el aviso de `nativeButton` en los botones que navegan,
> y un 400 sin explicación al crear sensores.

## 1. Base UI: `nativeButton`

### El aviso

```
Base UI: A component that acts as a button expected a native <button> because
the `nativeButton` prop is true. Rendering a non-<button> removes native button
semantics, which can impact forms and accessibility.
```

### La causa

Base UI asume `nativeButton: true`. Eso es correcto para un botón normal, pero
**falla cuando se usa `render` para que el botón sea un enlace**:

```tsx
<Button render={<Link href="/sensores/123" />}>
  <Eye />
</Button>
```

El elemento final es un `<a>`, no un `<button>`, así que la suposición de Base
UI deja de ser cierta.

### La solución

`nativeButton={false}`, **detectado automáticamente**:

```tsx
const esEnlace = render != null && nativeButton === undefined;

<ButtonPrimitive
  {...(esEnlace ? { nativeButton: false } : {})}
  render={render}
  {...props}
/>
```

### Por qué automático y no manual

El proyecto tiene **7 sitios** que renderizan enlaces como botón:

| Archivo | Uso |
|---|---|
| `acciones-fila.tsx` | Botón «Ver detalle» |
| `camara-card.tsx` | Botón «Ver detalle» |
| `detalle-camara.tsx` | Botón «Volver» |
| `barra-lateral-panel.tsx` | Enlaces del menú (×2) |
| `cabecera-panel.tsx` | «Mi perfil» y «Web» |

Exigir la prop en cada uno es fácil de olvidar, y **el aviso solo sale en la
consola del navegador**, donde pasa desapercibido hasta que alguien lo reporta.

Detectándolo en el componente `Button` se corrige en todos a la vez, y los
nuevos que se añadan quedan bien por defecto.

> Si alguien pasa `nativeButton` explícitamente, se respeta su valor.

### Por qué `false` es correcto aquí

Un `<a>` ya es accesible por sí mismo: recibe el foco con Tab, se activa con
Enter y los lectores de pantalla lo anuncian como **enlace**, no como botón.
Forzar la semántica de botón sería lo incorrecto.

---

## 2. El 400 al crear un sensor

### El síntoma

```
POST /api/v1/sensors  →  400

{"exito":false,"mensaje":"Error de validación",
 "detalles":[{"campo":"codigo",
              "mensaje":"Invalid input: expected string, received undefined"}]}
```

El usuario veía un error de validación **en un campo que ni siquiera aparece en
el formulario**: no había nada que pudiera rellenar.

### La causa

Una incoherencia introducida al hacer que el servidor genere los códigos:

| Capa | Estado |
|---|---|
| Formulario | El campo `codigo` se quitó ✅ |
| Servicio | El código se genera desde el nombre ✅ |
| **Esquema de Zod** | **Seguía exigiéndolo** ❌ |

El formulario ya no enviaba `codigo`, pero el esquema lo rechazaba antes de
llegar al servicio que debía generarlo.

### La solución

```ts
/*
 * El `codigo` NO se exige: lo genera el servidor a partir del nombre.
 * Se acepta si llega (para no romper clientes antiguos) pero el servicio lo
 * descarta y usa el suyo.
 */
codigo: z.string().trim().max(100).optional(),
```

Se mantiene **opcional** en lugar de eliminarlo para no romper versiones
antiguas del frontend que aún lo envíen. El servicio lo ignora de todos modos.

### La lección

> Al mover la responsabilidad de un campo del cliente al servidor hay que
> tocar **tres capas**: el formulario, el servicio **y el esquema de
> validación**. Olvidar la tercera produce un error que el usuario no puede
> resolver.

Hay **6 tests de regresión** en `sensor.schema.test.ts` que fijan el contrato:
`codigo` debe ser opcional al crear.

---

## Un detalle sobre los UUID en los tests

Al escribir los tests, tres fallaron con «No es un id válido» usando:

```
11111111-2222-3333-4444-555555555555   ❌
```

Zod **valida la versión y la variante** del UUID, no solo el formato:

| Grupo | Posición | Valor válido |
|---|---|---|
| Tercero | primero | `1`-`5` (versión) |
| Cuarto | primero | `8`, `9`, `a`, `b` (variante) |

Ese valor tiene versión `3` y variante `4`, así que se rechaza. El UUID
correcto para tests es:

```
11111111-2222-4333-8444-555555555555   ✅
```

> Merece la pena tenerlo presente: un UUID inventado "con pinta correcta" no
> sirve como dato de prueba.

---

## Verificación

| Prueba | Resultado |
|---|---|
| Crear sensor sin `codigo` | ✅ `SENSOR-PRUEBA-400` |
| Canal generado | `SENSOR-PRUEBA-400-TEMPERATURA` |
| Variable del canal | `TEMPERATURA` (°C) |
| Al editar, la variable se carga | ✅ |
| Aviso de Base UI en consola | ✅ desaparecido |
| Tests | **99/99** |
