# Dashboard: por qué no se actualizaba

> El panel se quedaba congelado aunque llegaran datos nuevos.

## El síntoma

El resto de la aplicación se actualizaba en tiempo real, pero el **dashboard
no cambiaba** hasta recargar la página.

## La causa: claves de caché que nadie tocaba

Cada consulta de TanStack Query se guarda bajo una **clave**. Los hooks de
tiempo real parchean las claves de sus módulos:

| Hook | Claves que actualiza |
|---|---|
| `useEventosMediciones` | `["mediciones"]`, `["canales"]`, `["canal", id]` |
| `useEventosDispositivos` | `["dispositivos"]`, `["dispositivo", id]` |
| `useEventosAlertas` | `["alertas"]`, `["alerta", id]` |

Pero el dashboard usa **claves propias**:

```
["dashboard", "resumen"]   ← métricas del encabezado
["canales-dashboard"]      ← tarjetas de magnitud
["mini-serie", canalId]    ← mini-gráficas
["actividad", modo]        ← gráfica de actividad
```

**Ningún evento tocaba esas claves.** Llegaban datos, se actualizaban las
listas de cada módulo… y el panel seguía igual.

Había además un segundo agravante: `useResumenDashboard` **no tenía
`refetchInterval`**, así que tampoco se refrescaba por su cuenta.

## La solución

### 1. Un hook propio para el dashboard

`useEventosDashboard` se suscribe al WebSocket e invalida las claves del panel
cuando llega un evento relevante:

```ts
const CLAVES_DASHBOARD = [
  ["dashboard", "resumen"],
  ["canales-dashboard"],
  ["actividad"],
];

queryClient.invalidateQueries({ queryKey: ["mini-serie"] });
```

### 2. Polling de respaldo

```ts
refetchInterval: POLLING_RESPALDO_MS,  // 90 s
```

Si el WebSocket no está disponible —red restrictiva, proxy que corta
conexiones, servidor reiniciado— el panel se habría quedado congelado **sin
que el usuario lo supiera**. Este intervalo es la red de seguridad.

**90 s y no 10 s**: en condiciones normales el WebSocket llega mucho antes y
esta consulta casi nunca aporta nada nuevo.

## Por qué invalidar en lugar de parchear

Parchear (`setQueryData`) exige conocer la forma exacta de la respuesta. El
resumen es un **agregado** —totales, últimas mediciones, dispositivos
recientes— y las tarjetas de magnitud llevan contadores. Escribir esa lógica a
mano sería frágil y se rompería al cambiar el backend.

Invalidar pregunta de nuevo a la API, que es la fuente de verdad. Cuesta una
petición, y solo cuando llega un evento real.

> **Sobre el agrupamiento**: si llegan diez mediciones en un segundo,
> `invalidateQueries` se llama diez veces, pero TanStack Query **solo hace un
> refetch**, porque la consulta ya está en vuelo.

## El formulario de actuadores desactualizado

El detalle de dispositivo (`/dispositivos/[id]`) tenía un **mini-formulario
propio** para crear actuadores que solo pedía nombre y tipo:

```ts
await crearActuador({
  dispositivo_id: dispositivoId,
  nombre: formulario.nombre.trim(),
  tipo: formulario.tipo.trim(),
  activo: true,
});          // ← ni protocolo ni direccionamiento
```

Al añadir el direccionamiento, ese formulario se quedó atrás: creaba
actuadores **siempre como `mqtt` y sin dirección**, que nunca se podían
accionar desde un PLC. Y el fallo era silencioso: el actuador se creaba sin
error, simplemente no funcionaba.

### La solución: un solo formulario

Se reutiliza el mismo `FormularioActuador` de la página de Actuadores:

```tsx
<FormularioActuador
  abierto={modalAbierto}
  actuador={null}
  dispositivos={dispositivos}
  onGuardar={guardarActuador}
/>
```

> **Regla**: mantener dos formularios para la misma entidad garantiza que uno
> se quede obsoleto. Con uno solo, cualquier campo nuevo aparece en los dos
> sitios a la vez.

## Verificación

| Prueba | Resultado |
|---|---|
| Crear actuador desde el detalle con protocolo Modbus | `protocolo: modbus` ✅ |
| Dirección guardada | `coil 120, unidad 2` ✅ |
| El comando lleva el direccionamiento | `direccion: 120` ✅ |
| Antes del arreglo | Se habría guardado como `mqtt` **sin dirección** |
| `tsc` · `lint` · `build` | Correcto |

## Archivos

| Archivo | Cambio |
|---|---|
| `hooks/use-eventos-dashboard.ts` | **Nuevo**: invalida las claves del panel |
| `components/dashboard/panel-dashboard.tsx` | Monta el hook |
| `hooks/use-resumen-dashboard.ts` | Polling de respaldo cada 90 s |
| `components/dispositivos/detalle-dispositivo.tsx` | Reutiliza el formulario completo |

## Cómo comprobarlo

```bash
# 1. Abre el dashboard
# 2. Envía una medición (simulador, Node-RED o curl)
# 3. Sin recargar, la tarjeta de la magnitud debe cambiar
```

Si no cambia pero el resto de la app sí, el problema está en las **claves de
caché**, no en el WebSocket.
