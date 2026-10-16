# Diálogos que no se salen de la pantalla

> Un formulario con muchos campos desbordaba la ventana y dejaba el botón de
> guardar fuera del área visible.

## El síntoma

El formulario de actuadores era demasiado alto: se salía por arriba y por
abajo de la pantalla, y **no había forma de llegar a los botones de guardar**.

```
┌─────────────── pantalla ───────────────┐
│                                        │
│        ┌──── diálogo ────┐             │
│        │ Nuevo actuador  │  ← cortado  │
│        │ ...campos...    │             │
│        │ ...campos...    │             │
│        │ [Guardar]       │  ← fuera    │
└────────┴─────────────────┴─────────────┘
```

## Las dos causas

### 1. El diálogo base no tenía límite de altura

```tsx
"fixed top-1/2 left-1/2 ... gap-6 rounded-4xl bg-popover p-6 ..."
```

Sin `max-h`, el diálogo crece todo lo que necesite su contenido.

### 2. El formulario tenía demasiados bloques apilados

Siete bloques en una columna: dispositivo, nombre, tipo, asistente de
direccionamiento (con sus propios campos), código, estado y activo.

## Las dos soluciones

### En el componente base (protege TODOS los diálogos)

```tsx
// src/components/ui/dialog.tsx — DialogContent
"fixed top-1/2 left-1/2 z-50 grid max-h-[90vh] w-full ... overflow-y-auto overflow-x-hidden ..."
```

```tsx
// src/components/ui/dialog.tsx — DialogFooter
"sticky bottom-0 -mx-6 flex ... border-t bg-popover px-6 pt-4 pb-1 ..."
```

**Por qué en el componente base y no en cada formulario**: olvidarlo en uno
solo reproduce el problema. Poniéndolo aquí, ningún diálogo futuro puede
desbordarse.

**Por qué el pie es `sticky`**: con scroll, sin esto el botón de guardar sube
y hay que desplazarse hasta el final para guardar. Si el usuario no descubre
el scroll, parece que el formulario no se puede guardar.

### En el formulario (reduce la altura un 33 %)

| Antes | Ahora |
|---|---|
| Dispositivo (bloque solo) | **Dispositivo + Nombre + Tipo en una fila** |
| Nombre + Tipo | ← comparten fila |
| Asistente: protocolo apilado | **Protocolo y su ayuda lado a lado** |
| Código (bloque solo, 3 líneas de ayuda) | **Código + Estado + Activo en una fila** |
| Estado + Activo | ← comparten fila |

```
ANTES:  ~830 px  →  se salía de la pantalla
AHORA:  ~560 px  →  cabe incluso en un portátil de 768 px
```

Ningún campo se eliminó: **todos** siguen ahí, reorganizados.

## Reglas para formularios nuevos

1. **No añadir `max-h` ni `overflow` a mano**: el `DialogContent` ya lo trae.
2. **Agrupar campos cortos en filas** con `sm:grid-cols-[...]`. Un bloque
   apilado por campo desperdicia altura.
3. **Los textos de ayuda, cortos.** Un párrafo de tres líneas bajo cada campo
   suma 150 px sin aportar más que la documentación.
4. **Usar `DialogFooter`** para los botones: así quedan fijos y visibles.

## Verificación

| Prueba | Resultado |
|---|---|
| Altura del formulario de actuadores | 830 px → **560 px** |
| Pantalla de 768 px (portátil) | **Cabe sin desplazarse** |
| Ventana muy pequeña | Scroll dentro del diálogo |
| Botones de guardar | **Siempre visibles** (sticky) |
| Otros diálogos | Sin cambios visuales; ganan la misma protección |
| `tsc` · `lint` · `build` | Correcto |

## Archivos

| Archivo | Cambio |
|---|---|
| `src/components/ui/dialog.tsx` | `max-h` + scroll + pie fijo (componente base) |
| `src/components/actuadores/formulario-actuador.tsx` | Campos reorganizados en filas |
| `src/components/actuadores/asistente-direccion.tsx` | Protocolo en fila, textos más cortos |
