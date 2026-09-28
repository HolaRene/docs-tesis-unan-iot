# ESP32 con buzzer/LED por HTTP (sin Node-RED ni MQTT)

> Controla una salida desde la web **sin** broker MQTT y **sin** Node-RED.
> El propio ESP32 pregunta a la API si tiene órdenes pendientes.

## Cuándo usar esto y cuándo usar MQTT

| | HTTP (este documento) | MQTT (Node-RED) |
|---|---|---|
| Piezas necesarias | Solo la API | API + Node-RED + broker |
| Latencia | Hasta 2 s (según el intervalo) | Milisegundos |
| El equipo pregunta | Sí (polling) | No, recibe (push) |
| Sobrevive a reinicios | Sí, sin lógica extra | Necesita reconexión |
| Ideal para | LED, buzzer, riego, ventilador | Alarmas, tiempo real |

**Para un buzzer o un LED, HTTP sobra.** La orden tarda como máximo lo que
tarde el ESP32 en preguntar.

> ⚠️ **HTTP no puede empujar.** El servidor no puede avisar al ESP32 por su
> cuenta: HTTP es petición→respuesta. Por eso el ESP32 pregunta en bucle. Si
> necesitas reacción instantánea, usa MQTT.

---

## El circuito

```
   WEB                API                  ESP32
    │                  │                    │
    │ POST comandos    │                    │
    ├─────────────────►│  guarda            │
    │                  │  'pendiente'       │
    │                  │                    │
    │                  │  GET pendientes    │
    │                  │◄───────────────────┤  cada 2 s
    │                  │───────────────────►│  [{comando: "ON"}]
    │                  │                    │
    │                  │                    │ acciona el buzzer 🔊
    │                  │  PATCH ejecutado   │
    │                  │◄───────────────────┤
    │                  │                    │
    │  ve "ejecutado"  │                    │
    │◄─────────────────┤                    │
```

---

## 1. Datos que necesitas

### Identificador y código

| Concepto | Valor de ejemplo | Dónde se usa |
|---|---|---|
| `identificador` | `ESP32-BUZZER` | Columna `dispositivos.identificador`. El ESP32 pregunta por él |
| `codigo` | `BUZZER-1` | Columna `actuadores.codigo`. Viaja en el comando |

El tema MQTT `hospital/quirofano/cmd/RELE-1` **solo aplica si usas MQTT**. En la
variante HTTP no se usa: el ESP32 se identifica con su `identificador`.

### La IP de tu PC (importante)

```bash
# Linux/macOS
hostname -I

# Windows
ipconfig
```

El ESP32 debe usar esa IP, **no `localhost`**: dentro del ESP32, `localhost`
apunta a sí mismo.

---

## 2. La API Key

El ESP32 necesita una clave con el permiso **`comandos:enviar`**. Créala desde
**Configuración → Claves API** en la web (marca también `estado:actualizar` si
quieres que reporte su estado).

---

## 3. El endpoint

```http
GET /api/v1/iot/comandos/pendientes?identificador=ESP32-BUZZER
X-API-Key: flx_...
```

### Por qué el filtro `identificador` es imprescindible

Sin él, el endpoint devuelve **todas** las órdenes de la instalación. Tu ESP32
recibiría —y ejecutaría— comandos destinados a otros equipos.

Con él, cada equipo recibe solo lo suyo:

| Petición | Devuelve |
|---|---|
| `?identificador=ESP32-BUZZER` | Solo los comandos de los actuadores de ese dispositivo |
| `?actuador=BUZZER-1` | Solo los de ese actuador concreto |
| *(sin filtro)* | Todos (lo usa Node-RED) |

### Respuesta

```json
{
  "exito": true,
  "datos": [
    {
      "id": "49c80599-3887-4ca1-8da8-57eae191980a",
      "comando": "ON",
      "valor": null,
      "actuador_codigo": "BUZZER-1",
      "dispositivo_identificador": "ESP32-BUZZER",
      "estado": "pendiente"
    }
  ]
}
```

El campo **`id`** es lo que permite confirmar la ejecución después.

### Confirmar

```http
PATCH /api/v1/iot/comandos/{id}
X-API-Key: flx_...
Content-Type: application/json

{
  "estado": "ejecutado",
  "estado_actuador": "on",
  "respuesta": { "rssi": -55 }
}
```

`estado_actuador` hace que la web muestre el estado **real** del equipo, no el
que se pidió.

---

## 4. El sketch

Está en **`docs/node-red/esp32-buzzer-http.ino`**. Solo hay que cambiar:

```cpp
const char* WIFI_SSID  = "TU_WIFI";
const char* WIFI_PASS  = "TU_PASSWORD";
const char* API_URL    = "http://192.168.1.100:4000/api/v1";  // tu IP
const char* API_KEY    = "flx_TU_CLAVE";
const char* DISPOSITIVO = "ESP32-BUZZER";
const char* ACTUADOR    = "BUZZER-1";
const int   PIN_BUZZER  = 25;
```

### Conexiones

| Elemento | ESP32 |
|---|---|
| Buzzer activo (+) | GPIO 25 |
| Buzzer activo (−) | GND |
| LED | GPIO 26 + resistencia 220 Ω a GND |

> Un **buzzer activo** suena con solo darle tensión. Uno **pasivo** necesita
> PWM. El sketch usa un buzzer activo.

### Qué hace el sketch

1. Cada 2 s pregunta por sus comandos.
2. Si hay alguno, acciona el pin.
3. Confirma la ejecución a la API.
4. Cada 60 s manda un **heartbeat** para que la plataforma no lo marque como
   `offline`.

---

## 5. Probar sin hardware

```bash
cd api
npx tsx scripts/simular-esp32-buzzer.ts <API_KEY>
```

Simula exactamente lo mismo que el sketch. Envía un comando desde **Actuadores**
en la web y verás:

```
  >> 1 comando(s) recibido(s)
     BUZZER 🔊 ENCENDIDO
     confirmado -> HTTP 200
```

---

## 6. Problemas frecuentes

| Síntoma | Causa |
|---|---|
| `HTTP 401` | API Key incorrecta o sin el permiso `comandos:enviar` |
| `HTTP -1` / sin conexión | El ESP32 no alcanza la IP. Comprueba que estén en la misma red y que la API escuche en `0.0.0.0` |
| El comando se queda en `pendiente` | El ESP32 no pregunta, o su `identificador` no coincide con ninguno de la BD |
| El comando pasa a `ejecutado` pero el actuador sigue en `off` | No se está enviando `estado_actuador` |
| El dispositivo aparece `offline` en la web | No llega el heartbeat (revisa el permiso `estado:actualizar`) |
| El buzzer no suena | Es pasivo (necesita PWM), o el pin no es el correcto |

### Comprobar que la API escucha desde fuera

```bash
curl "http://TU_IP:4000/api/v1/iot/comandos/pendientes?identificador=ESP32-BUZZER" \
  -H "X-API-Key: TU_CLAVE"
```

Si esto falla desde tu PC con la IP, tampoco funcionará desde el ESP32.
