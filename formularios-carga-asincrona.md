# Formularios de edición: carga asíncrona de datos

> Un error de React que hacía que al editar un sensor no aparecieran sus
> magnitudes. Patrón aplicable a cualquier formulario del sistema.

## El síntoma

Al abrir **Editar** en un sensor, los desplegables de **magnitud** salían
vacíos. Los datos existían en la base de datos y la API los devolvía
correctamente.

## La causa

```tsx
const [magnitudes, setMagnitudes] = useState(magnitudesIniciales);
```

`useState` con una prop **solo lee esa prop en el PRIMER render**. Lo que ocurre
en la práctica:

```
1. Se abre el diálogo de edición
      │
      ▼
2. El formulario se MONTA
      │  La petición de canales aún va en camino
      │  magnitudesIniciales = []   (array vacío)
      ▼
3. useState([...])  ← estado inicial CONGELADO con la lista vacía
      │
      ▼
4. Llega la respuesta de la API (200 ms después)
      │  magnitudesIniciales ya tiene 2 elementos
      ▼
5. ❌ El estado no se vuelve a inicializar
      El desplegable sigue vacío
```

> **Regla**: `useState(prop)` no reacciona a los cambios de `prop`. Solo se usa
> el valor del primer render; los siguientes se ignoran.

## La solución

**No montar el formulario hasta que los datos estén disponibles.**

```tsx
// ¿Ya se puede montar? Solo si no estamos esperando datos.
const magnitudesListas = !editar || !canalesSensor.isLoading;

return (
  <div>
    {magnitudesListas ? (
      <FormularioSensor
        key={`${editar?.id ?? "nuevo"}-${canalesSensor.dataUpdatedAt}`}
        magnitudesIniciales={magnitudesIniciales}
        ...
      />
    ) : null}
  </div>
);
```

Ahora el estado **nace con los datos correctos**, porque cuando el componente se
monta la petición ya terminó.

### Por qué es mejor que la alternativa

| Opción | Problema |
|---|---|
| `useEffect` que hace `setState` al llegar los datos | Provoca un render extra, y la regla `react-hooks/set-state-in-effect` lo señala como antipatrón |
| `key` que cambia con los datos | Remonta el formulario, pero pierde lo que el usuario ya hubiera escrito |
| **No montar hasta tener datos** | El estado nace correcto. Sin renders extra y sin perder nada |
| `defaultValues` de React Hook Form sin `useState` | No sirve aquí: las magnitudes son una **lista dinámica** con estado propio |

### La `key` como red de seguridad

```
key={`${editar?.id ?? "nuevo"}-${canalesSensor.dataUpdatedAt}`}
```

`dataUpdatedAt` es la marca de tiempo de la última carga correcta. Si por
cualquier motivo el formulario se montara antes de tener los datos, al llegar
estos la `key` cambia y el formulario **se remonta con el estado correcto**.

## Respaldo para sensores sin canales

En el modelo multivariable cada magnitud vive en un **canal**. Un sensor sin
canales mostraría el formulario vacío, así que se recurre a su variable
principal:

```tsx
const desdeCanales = (canalesSensor.data ?? []).map(...);
if (desdeCanales.length > 0) return desdeCanales;

// Respaldo: la variable del propio sensor.
if (editar?.tipo_variable_id) {
  return [{ clave: "principal", tipo_variable_id: editar.tipo_variable_id, ... }];
}
```

Cubre el caso de sensores antiguos, creados antes de que existiera el modelo
multivariable.

## Un detalle sobre `useMemo`

No se usa `useMemo` para calcular `magnitudesIniciales`. El proyecto tiene
**React Compiler** activado, que ya memoriza los componentes:

> Si se declara un `useMemo` manual cuyas dependencias no coinciden
> **exactamente** con las inferidas, el compilador **se salta la optimización
> del componente entero** y avisa con:
>
> `Compilation Skipped: Existing memoization could not be preserved`

Dejar que el compilador lo haga es más seguro que mantener listas de
dependencias a mano.

## Cómo comprobarlo

| Prueba | Resultado |
|---|---|
| Editar `DHT1W` | Aparecen 2 magnitudes |
| Variable del canal 1 | `TEMPERATURA` |
| Variable del canal 2 | `HUMEDAD_RELATIVA` |
| Los IDs existen en `tipos_variable` | 2 de 2 |

```bash
# Comprobar que la API devuelve las variables de los canales
curl "http://localhost:4000/api/v1/sensors/$SENSOR_ID/canales" \
  -H "Authorization: Bearer $TOKEN" | jq '.datos.canales[] | {codigo, tipo_variable_id}'
```

## Regla general del proyecto

> **Ningún formulario de edición debe montarse antes de que sus datos estén
> cargados.**

Aplica a cualquier formulario que inicialice estado con datos que vengan de una
petición. Es preferible mostrar un instante de espera a mostrar un formulario
incompleto que el usuario puede guardar por error, borrando las magnitudes sin
darse cuenta.
