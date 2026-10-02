# Comandos a PLC por Modbus con Node-RED

> Cómo enviar un comando desde la web a un PLC, **y saber si se ejecutó**.
>
> Complementa [`integracion-node-red-mqtt.md`](./integracion-node-red-mqtt.md),
> que cubre el circuito por MQTT. Este documento es para **Modbus**.

## Índice

1. [El problema: no sabes si llegó](#1-el-problema-no-sabes-si-llegó)
2. [El flujo completo](#2-el-flujo-completo)
3. [Confirmar de verdad: leer el estado](#3-confirmar-de-verdad-leer-el-estado)
4. [Leer variables vs leer actuadores](#4-leer-variables-vs-leer-actuadores)
5. [Problemas frecuentes](#5-problemas-frecuentes)

---

## 1. El problema: no sabes si llegó

Tu flujo actual hace esto:

```
[inject] → [http request] → [function] → [modbus write]
```

El `modbus write` ocurre, **pero nadie avisa a la API**. Consecuencias:

| Síntoma | Por qué |
|---|---|
| El comando se queda en `pendiente` | La API nunca recibió confirmación |
| No sabes si encendió | No hay lectura de vuelta |
| El PLC recibe el comando **varias veces** | Al seguir `pendiente`, el `inject` lo reenvía en cada vuelta |
| La web muestra "pendiente" siempre | Igual que el primero |

Esto es comprobable en la base de datos:

```sql
SELECT comando, estado, creado_en, enviado_en
FROM comandos_actuador ORDER BY creado_en DESC LIMIT 5;
```

```
 comando |  estado   |         creado_en         | enviado_en
---------+-----------+---------------------------+------------
 ON      | pendiente | 2026-09-28 20:56:53       |        ← nunca se confirmó
 ON      | pendiente | 2026-09-28 14:55:06       |
 ON      | pendiente | 2026-09-28 14:51:26       |
```

**`enviado_en` vacío = la API no sabe nada.** Ese es el diagnóstico.

> ⚠️ **El reenvío repetido es grave.** Un comando que se queda en `pendiente`
> se vuelve a escribir en el PLC cada 2 segundos, indefinidamente. En un relé
> puede significar conmutaciones constantes.

---

## 2. El flujo completo

### Estructura

```
   [inject 2s]                                  ← dispara el ciclo
        │
   [function: pedir pendientes]                 ← GET a la API
        │
     [split]                                    ← 1 mensaje por comando
        │
   [modbus write]                               ← escribe en el PLC
        │
   [function: confirmar]                        ← PATCH a la API
        │
     [debug]
```

### Por qué hace falta `split`

El nodo `function` devuelve un **array** de comandos. El nodo `modbus write`
trabaja con **un mensaje a la vez**, así que hay que separarlos.

Sin `split`, Modbus recibe un array y falla (o escribe solo el primero).

### Nodos

**1. `inject`**

| Campo | Valor |
|---|---|
| Repeat | interval |
| Every | `2` seconds |

**2. `function` (el código está en `docs/node-red/comandos-modbus.js`)**

Un solo nodo hace las dos fases: recoger y confirmar. Se distinguen porque en
la fase de confirmación el mensaje trae `msg.comando_actual`.

**3. `split`**

- Por defecto (`msg.payload`). El array de comandos se convierte en mensajes
  sueltos.

**4. `modbus write`**

| Campo | Valor |
|---|---|
| Unit-Id | el de tu PLC (habitualmente `1`) |
| FC | `FC 5: Force Single Coil` (para encender/apagar) |
| Address | **desde `msg.topic`** (marcar la casilla) |
| Value | **desde `msg.payload`** (marcar la casilla) |

> La dirección y el valor los pone el nodo `function`, así que se marcan las
> casillas "desde el mensaje". Así el mismo nodo sirve para todos los
> actuadores.

**5. `function` de confirmación**

Es **el mismo nodo** otra vez: al recibir el resultado del `modbus write`,
detecta `msg.comando_actual` y hace el `PATCH`. Si prefieres separarlo, copia
solo el bloque "FASE 2" del archivo en un segundo nodo.

### Qué se escribe en Modbus

```js
msg.topic   = "coil"      // tipo de dato
msg.payload = 1           // 1 = ON, 0 = OFF
```

---

## 3. Confirmar de verdad: leer el estado

Aquí está el matiz importante:

> **Que el `modbus write` no dé error NO significa que la salida cambió.**
> Significa que el PLC **aceptó** la escritura.

Para saber el estado real hay que **leer** el coil o registro después de
escribir:

```
[modbus write] → [delay 200ms] → [modbus read] → [function: confirmar]
```

### Por qué el delay

Algunos PLC aplican el cambio de salida en el siguiente ciclo de scan. Leer
inmediatamente puede devolver el valor antiguo y dar un falso "no cambió".

### Detectar el error de Modbus

El nodo `modbus write` **no lanza una excepción** si el PLC responde con error.
Lo devuelve en el payload:

```js
const errorCode    = msg.payload?.errorCode ?? msg.payload?.error;
const errorMensaje = msg.payload?.errorMessage ?? msg.error?.message;
const huboError    = Boolean(errorCode || errorMensaje);
```

Si no se comprueban **las tres** señales, algunos fallos pasan por éxitos y la
API recibe un "ejecutado" falso.

### Los tres estados de la confirmación

| `estado` | Cuándo | Efecto |
|---|---|---|
| `enviado` | Se escribió, pero no se ha leído de vuelta | La web muestra "enviado" |
| `ejecutado` | Se leyó y el valor **coincide** con lo pedido | El actuador se actualiza |
| `fallido` | El PLC dio error, o el valor leído **no coincide** | Se registra el motivo |

Ejemplo de confirmación con lectura incluida:

```js
// `msg.leido` viene del nodo modbus read
const valorLeido = msg.leido ?? msg.payload;
const coincide = Number(valorLeido) === (cmd.valor_on ? 1 : 0);

const estado = !huboError && coincide ? "ejecutado" : "fallido";

msg.payload = {
  estado,
  ...(estado === "ejecutado"
    ? { estado_actuador: cmd.valor_on ? "on" : "off" }
    : {}),
  respuesta: {
    via: "modbus",
    direccion: cmd.direccion,
    escrito: cmd.valor_on ? 1 : 0,
    leido: valorLeido,        // el valor real del PLC
    coincide,                 // la prueba de que se aplicó
  },
};
```

Guardar `leido` y `coincide` en `respuesta` es lo que te permite auditar
después: en la web queda registrado qué se escribió, qué se leyó y si
coincidían.

### Confirmar "enviado" primero (opcional pero recomendado)

Si el ciclo de escritura+lectura tarda, conviene confirmar en dos pasos:

```
[modbus write] → [function: confirmar "enviado"] → [modbus read] → [function: confirmar "ejecutado"]
```

Así la web refleja "el PLC aceptó" aunque la lectura falle después.

---

## 4. Leer variables vs leer actuadores

**No es lo mismo**, y conviene tenerlo claro:

| | Leer variables (mediciones) | Leer actuadores (estado) |
|---|---|---|
| Qué es | Un dato del proceso | El estado de una salida |
| Dónde se guarda | `mediciones`, vía **canal** | `actuadores.estado_actual` |
| Endpoint | `POST /iot/mediciones` | `PATCH /iot/comandos/:id` |
| Frecuencia | Cada pocos segundos | Solo al ejecutar un comando |
| Tabla destino | `mediciones` (histórico) | `actuadores` (estado actual) |

### Leer variables (ya lo tienes funcionando)

```
[modbus read] → [function] → [http request: POST /iot/mediciones]
```

El `http request` necesita `X-API-Key` (permiso `mediciones:crear`). El payload
usa **códigos de canal**, no direcciones Modbus:

```json
{
  "dispositivo": "PLC-1",
  "mediciones": [
    { "canal": "PLC-1-TEMPERATURA", "valor": 24.8 }
  ]
}
```

> El **canal** es la traducción entre el mundo Modbus y la plataforma. Node-RED
> sabe que la dirección Modbus `40001` corresponde al canal
> `PLC-1-TEMPERATURA`, y es él quien hace esa traducción.

### Leer actuadores (esto es lo que falta)

No hay endpoint de "leer actuadores". El estado se actualiza **al confirmar un
comando**, con `estado_actuador`:

```json
PATCH /iot/comandos/{id}
{ "estado": "ejecutado", "estado_actuador": "on" }
```

Si quieres que el actuador refleje cambios hechos **fuera** de la web (alguien
accionó el PLC manualmente), tienes dos opciones sin tocar la API:

1. **Solo al confirmar comandos**: el actuador se actualiza cuando la web manda
   algo. Es lo que hay hoy.
2. **Refresco periódico**: un `inject` que lee los coils y, si el valor cambió
   respecto al último conocido, confirma con `estado_actuador`. Requiere
   recordar el último valor leído (en `context`).

---

## 5. Problemas frecuentes

| Síntoma | Causa |
|---|---|
| El comando se queda en `pendiente` | No se está llamando al `PATCH` de confirmación |
| El PLC recibe el comando muchas veces | Igual que el anterior: al seguir pendiente, el `inject` lo reenvía |
| `msg.payload.errorCode` distinto de 0 | El PLC rechazó la escritura (dirección inválida, FC incorrecto, unit-id mal) |
| La web dice "ejecutado" pero el PLC no cambió | Se confirmó sin leer de vuelta. Añade el `modbus read` |
| El valor leído no coincide nada más escribir | El PLC aplica los cambios en el siguiente scan: añade un `delay` de 100–300 ms |
| `ECONNREFUSED` en el `modbus write` | IP/puerto del PLC mal, o el PLC no acepta Modbus TCP |
| Se escriben comandos de otro actuador | Falta el `split`, o el nodo `modbus write` tiene dirección fija |

### Comprobar el ciclo de vida

```sql
SELECT comando, estado, creado_en, enviado_en, ejecutado_en, respuesta
FROM comandos_actuador
ORDER BY creado_en DESC LIMIT 5;
```

| `estado` | `enviado_en` | `ejecutado_en` | Significa |
|---|---|---|---|
| `pendiente` | — | — | **Node-RED no confirmó** ← el problema típico |
| `enviado` | ✅ | — | El PLC aceptó, sin verificar |
| `ejecutado` | ✅ | ✅ | Verificado |
| `fallido` | ✅ | — | Error de Modbus o el valor no coincidía |

### Purgar comandos pendientes atascados

Si tienes comandos antiguos que nunca se confirmaron:

```sql
-- Revisar antes de borrar
SELECT comando, estado, creado_en FROM comandos_actuador WHERE estado = 'pendiente';

-- Marcarlos como fallidos (conserva el histórico)
UPDATE comandos_actuador
SET estado = 'fallido',
    respuesta = '{"motivo":"sin confirmacion de Node-RED"}'::jsonb
WHERE estado = 'pendiente';
```

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`integracion-node-red-mqtt.md`](./integracion-node-red-mqtt.md) | Circuito por MQTT |
| [`comandos-actuadores.md`](./comandos-actuadores.md) | Arquitectura de comandos |
| [`node-red/comandos-modbus.js`](./node-red/comandos-modbus.js) | Nodo de Modbus con confirmación |
| [`node-red/recoger-comandos.js`](./node-red/recoger-comandos.js) | Nodo equivalente para MQTT |
