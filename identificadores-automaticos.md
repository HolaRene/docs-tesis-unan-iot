# Identificadores y códigos: generación automática

> Cómo se asignan las claves únicas del sistema y por qué las genera el
> servidor en lugar del usuario.

## El problema

Tres campos del modelo son **claves únicas en toda la base de datos** y, además,
las usa el hardware para identificarse:

| Campo | Tabla | Quién lo usa |
|---|---|---|
| `identificador` | `dispositivos` | El equipo, al enviar datos: `{"dispositivo": "ESP32-Q2"}` |
| `codigo` | `sensores` | Base del código de sus canales |
| `codigo` | `canales` | El equipo, en cada medición: `{"canal": "DHT1W-TEMPERATURA"}` |
| `codigo` | `actuadores` | **Tema MQTT**: `hospital/quirofano/cmd/BUZZER-QUIROFANO` |

Si se escriben a mano desde el frontend aparecen tres problemas:

1. **Duplicados.** Dos usuarios inventan el mismo código y uno falla al guardar
   con un error de base de datos poco claro.
2. **Inconsistencias.** `TEMP1`, `temp-1` y `Temp_1` para el mismo concepto.
3. **Roturas del histórico.** Cambiar el código de un sensor que ya envía datos
   deja las mediciones anteriores asociadas al valor viejo: el histórico se
   parte en dos.

## La solución: los genera el servidor

```
   Usuario escribe:  "Sensor Quirófano 1"
                            │
                            ▼
   Servidor genera:  SENSOR-QUIROFANO-1
                     SENSOR-QUIROFANO-1-2   (si ya existe)
```

### Reglas de generación

| Entrada | Salida | Por qué |
|---|---|---|
| `Sensor Quirófano 1` | `SENSOR-QUIROFANO-1` | Mayúsculas, guiones, sin acentos |
| `Quirófano` | `QUIROFANO` | **Los acentos se quitan, no se borran** |
| `Sensor   de   Área` | `SENSOR-DE-AREA` | Separadores colapsados |
| `--prueba--` | `PRUEBA` | Sin guiones en los extremos |
| `Sensor #1 (nuevo)` | `SENSOR-1-NUEVO` | Símbolos descartados |
| *(nada utilizable)* | `DISPOSITIVO` | Nunca queda vacío |

> **El detalle de los acentos importa.** Sin normalizar, `Quirófano` produciría
> `QUIR-FANO` al descartar la `ó`, y el identificador dejaría de parecerse al
> nombre. Se usa descomposición NFD y se eliminan las marcas diacríticas.

### Resolución de colisiones

Se prueban sufijos incrementales hasta encontrar uno libre:

```
SENSOR-QUIROFANO-1      ← primero, sin sufijo
SENSOR-QUIROFANO-1-2    ← segundo
SENSOR-QUIROFANO-1-3    ← tercero
```

El **primer intento no lleva sufijo**, así el caso normal produce el
identificador limpio.

### Caso particular: actuadores (tipo + nombre)

El código del actuador se forma con el **tipo delante**:

```
"Quirófano"        + buzzer       →  BUZZER-QUIROFANO
"Buzzer Quirófano" + buzzer       →  BUZZER-QUIROFANO   (no repite)
"LED 1"            + digital_out  →  DIGITAL-OUT-LED-1
"Válvula A"        + valvula      →  VALVULA-A
"Relé 1"           + (sin tipo)   →  RELE-1
```

**Por qué el tipo va primero**: el código forma parte del tema MQTT al que
Node-RED publica las órdenes. Que empiece por el tipo hace el tema
autoexplicativo: al ver `cmd/BUZZER-QUIROFANO` se sabe qué se está accionando
sin consultar la base de datos.

**Los guiones bajos se normalizan** (`digital_out` → `DIGITAL-OUT`), porque en
un tema MQTT quedan mejor como guiones.

Además, el formulario muestra una **previsualización en vivo** del código,
reproduciendo la misma regla. Se comprobó con 7 casos que la previsualización
coincide exactamente con lo que genera el backend.

## Generación en cascada

Los códigos se derivan unos de otros:

```
Área: "Quirófano"
   └─► Dispositivo "ESP32 Quirófano"  →  ESP32-QUIROFANO
          └─► Sensor "DHT Ambiente"    →  DHT-AMBIENTE
                 └─► Canal Temperatura →  DHT-AMBIENTE-TEMPERATURA
                 └─► Canal Humedad     →  DHT-AMBIENTE-HUMEDAD-RELATIVA
```

Por eso el código del sensor se genera **antes** de crear el sensor: sus
canales lo necesitan para construir el suyo.

### Evitar repeticiones

Si el código del sensor ya contiene la magnitud, no se repite:

```
DHT1W-TEMPERATURA + TEMPERATURA  →  DHT1W-TEMPERATURA   ✅
                                  (no DHT1W-TEMPERATURA-TEMPERATURA)
```

## Inmutabilidad

Una vez creados, **estos campos no se pueden cambiar**:

| Operación | `identificador` | `codigo` (sensor) |
|---|---|---|
| Crear sin enviarlo | Se genera | Se genera |
| Crear enviándolo | **Se ignora** | **Se ignora** |
| Editar el nombre | Se conserva | Se conserva |
| Editar el campo | **Se descarta** | **Se descarta** |

Si el cliente envía el campo, se **descarta en silencio** (sin error 400). Así
una versión antigua del frontend que aún lo mande sigue funcionando.

### Por qué es inmutable

El identificador es la clave con la que el equipo ya está enviando datos. Si se
modificara:

```
Antes:   {"dispositivo": "ESP32-Q2",     "valor": 24.8}  →  histórico A
Cambio:  ESP32-Q2  →  ESP32-QUIROFANO
Después: {"dispositivo": "ESP32-QUIROFANO", "valor": 25.1} → histórico B
```

El histórico quedaría partido en dos y los gráficos mostrarían un salto.

## Implementación

### Backend

| Archivo | Responsabilidad |
|---|---|
| `src/utils/identificadores.ts` | Normalización y generación |
| `src/utils/identificadores.test.ts` | 18 tests |
| `device.service.ts` | Genera el identificador, ignora el del cliente |
| `sensor.service.ts` | Genera el código, lo ignora al editar |
| `canal.service.ts` | Deriva el código del canal (ya existía) |

### Frontend

Los campos se muestran **bloqueados** con un candado y un texto que explica:

- **Al crear**: «Lo genera el servidor a partir del nombre. No hace falta
  inventarlo y nunca se repite.»
- **Al editar**: «No se puede cambiar: las mediciones anteriores quedarían
  asociadas al valor antiguo.»

Se dejan **visibles** (no ocultos) porque el identificador hace falta para
configurar el equipo: hay que copiarlo al ESP32.

## Verificación

| Prueba | Resultado |
|---|---|
| Crear dispositivo sin identificador | `SENSOR-QUIROFANO-1` |
| Crear otro con el mismo nombre | `SENSOR-QUIROFANO-1-2` |
| Crear enviando `MI-CODIGO-INVENTADO` | Se ignora → `PRUEBA-HACKEO` |
| Editar enviando otro identificador | Se descarta, el nombre sí cambia |
| Crear sensor enviando código | Se ignora → `DHT-QUIROFANO` |
| El canal derivado | `DHT-QUIROFANO-TEMPERATURA` |
| Acentos | `Quirófano` → `QUIROFANO` |

**18 tests** en `identificadores.test.ts` cubren la normalización, los sufijos,
la resolución de colisiones y la generación del código de canal.

## Consecuencia práctica

El usuario **solo escribe el nombre**. Todo lo demás se deriva:

```
Nombre: "DHT Quirófano"
   →  Sensor:         DHT-QUIROFANO
   →  Canal temp.:    DHT-QUIROFANO-TEMPERATURA
   →  Canal humedad:  DHT-QUIROFANO-HUMEDAD-RELATIVA
```

Los dos únicos datos que hay que copiar al equipo son:

1. El **identificador del dispositivo** (una vez).
2. Los **códigos de canal** de sus sensores (en cada payload de medición).
