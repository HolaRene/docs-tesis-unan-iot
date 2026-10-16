# Direccionamiento de actuadores

> Cómo se le dice al equipo **dónde** accionar. Un PLC no entiende «LED-1».

## El problema

Los comandos salían así:

```json
{ "actuador": "LED-1", "comando": "ON" }
```

Eso funciona para un ESP32, que busca qué pin corresponde a `LED-1`. **Un PLC
no puede hacer nada con eso**: solo entiende

> «en la dirección 100, pon un 1»

y eso activa lo que esté cableado a esa salida. La dirección es un dato de la
**instalación**, no algo que el software pueda deducir.

Y el fallo es silencioso: el comando llega, no ocurre nada, y no hay ningún
error que explique por qué.

## La solución

Cada actuador declara **cómo se acciona** y **dónde**:

| Protocolo | Para qué | Qué necesita |
|---|---|---|
| **modbus** | PLC industrial | tipo de registro + dirección + unidad |
| **gpio** | ESP32, Arduino, Raspberry | número de pin + nivel activo |
| **mqtt** | Cualquier equipo conectado | tema (opcional) |
| **http** | Equipo con API propia | URL + método |

La API incluye el direccionamiento **ya resuelto** en el comando:

```json
{
  "actuador": "MOTOR-EXTRACTOR",
  "comando": "ON",
  "valor": 1,
  "direccionamiento": {
    "protocolo": "modbus",
    "tipo": "coil",
    "direccion": 100,
    "unidad_id": 1,
    "valor_on": 1,
    "valor_off": 0
  }
}
```

Node-RED solo lo reenvía. **Añadir un actuador nuevo ya no requiere tocar
Node-RED.**

## Por qué el direccionamiento va en el comando y no en Node-RED

Antes había un mapa fijo en el flujo:

```js
const DIRECCIONES = {
  "LED-1":  { direccion: 0, tipo: "coil" },
  "RELE-1": { direccion: 1, tipo: "coil" },
};
```

Eso tenía tres problemas:

1. **Editar Node-RED** por cada actuador nuevo.
2. La dirección quedaba **duplicada** en dos sitios que podían
   desincronizarse.
3. Con varios PLC, dos actuadores podían necesitar la misma dirección en
   unidades distintas, y el mapa no lo distinguía.

## El caso del relé invertido

Muchos módulos de relé se activan con nivel **bajo** (0 V): escribir un 1 los
**apaga**. Si la lógica se cablea en el firmware, es donde peor se encuentra.

Por eso el actuador declara su `nivel_activo` y la API calcula los valores:

| Configuración | `valor_on` | `valor_off` |
|---|---|---|
| `nivel_activo: 1` (normal) | 1 | 0 |
| `nivel_activo: 0` (invertido) | **0** | **1** |

Así, un `ON` se traduce a un 0 cuando el relé está invertido, sin tocar el
programa del ESP32.

## Dos fallos silenciosos que se evitaron

### 1. El campo vacío se convertía en dirección 0

```js
Number("") // → 0, no NaN
```

Y **0 es una dirección Modbus válida**. Un usuario que dejara la dirección
vacía guardaba el actuador como «coil 0» y el botón accionaba **otra salida
del PLC**, distinta de la que creía configurada.

El síntoma —«pulso el extractor y se enciende la luz»— es de los que cuestan
horas de encontrar.

Se corrige comprobando explícitamente la cadena vacía antes de convertir.

### 2. La dirección por defecto accionaba la salida 0

El flujo tenía:

```js
const REGISTRO_POR_DEFECTO = 0;
const direccion = cfg.direccion ?? REGISTRO_POR_DEFECTO;
```

Si un actuador llegaba sin dirección, se escribía en la **0** en silencio. Se
eliminó: ahora el comando se salta y se avisa con un mensaje que dice qué
configurar.

> **Regla**: ante una dirección que falta, es preferible **no accionar nada**
> que accionar la salida equivocada.

## Validación al guardar

Un actuador sin dirección no se puede crear. La API responde con el problema
concreto:

```
Direccionamiento incompleto: El protocolo Modbus (PLC) necesita una dirección configurada
```

Es mejor rechazarlo al configurarlo que descubrirlo cuando un operario pulse
el botón y no ocurra nada.

## Cambios en el firmware del ESP32

Antes:

```cpp
#define PIN_RELE 2
digitalWrite(PIN_RELE, encender ? LOW : HIGH);   // lógica cableada
```

Cambiar de pin o de tipo de relé obligaba a **recompilar y flashear**.

Ahora el pin y el valor llegan en el comando:

```cpp
JsonObject dir = doc["direccionamiento"];
int pin   = dir["pin"] | PIN_RELE;        // respaldo si no viene
int valor = doc["valor"] | 0;             // ya ajustado al nivel activo
aplicarSalida(pin, valor);
```

El mismo firmware sirve para cualquier salida.

## Compatibilidad

| Escenario | Comportamiento |
|---|---|
| Actuador antiguo sin protocolo | `mqtt` por defecto: sigue funcionando con su tema derivado del código |
| ESP32 que ignora el direccionamiento | Usa su `PIN_RELE` de respaldo |
| Node-RED antiguo | Sigue leyendo `actuador_topico_mqtt`, que no se eliminó |

## Verificación

| Prueba | Resultado |
|---|---|
| Modbus sin dirección | **Rechazado** con mensaje claro |
| Modbus dirección 100 | `coil 100 (unidad 1)` |
| GPIO pin 2 invertido | `valor_on: 0`, `valor_off: 1` |
| Dirección vacía | **Rechazado** (no se guarda como 0) |
| Protocolo desconocido | Cae en `mqtt`, no rompe la entrega |
| Tests | **132/132** (21 nuevos) |

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `api/.../actuadores/direccionamiento.ts` | Esquemas por protocolo y construcción del bloque |
| `api/.../actuadores/direccionamiento.test.ts` | 21 tests |
| `api/.../iot/iot.controller.ts` | Añade el direccionamiento a los comandos pendientes |
| `frontend/.../asistente-direccion.tsx` | Asistente que cambia según el protocolo |
| `docs/node-red/recoger-comandos.js` | Reenvía el direccionamiento en el payload MQTT |
| `docs/node-red/comandos-modbus.js` | Escribe en la dirección que trae el comando |
| `docs/node-red/esp32-receptor-comandos.ino` | Usa el pin del comando |
