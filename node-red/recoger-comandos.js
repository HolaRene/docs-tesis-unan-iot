/**
 * Node-RED — RECOGIDA Y ENTREGA DE COMANDOS A ACTUADORES
 * ======================================================
 *
 * Este nodo function cierra el circuito de los actuadores. Se ejecuta con un
 * `inject` periódico (cada 2-3 s) y hace tres cosas:
 *
 *   1. Pregunta a la API si hay comandos PENDIENTES.
 *   2. Publica cada uno en su tema MQTT (para el ESP32/PLC).
 *   3. Confirma la entrega a la API ('enviado').
 *
 * ────────────────────────────────────────────────────────────────────
 * POR QUÉ POLLING Y NO WEBSOCKET
 * ────────────────────────────────────────────────────────────────────
 * El WebSocket de la plataforma sirve para EMPUJAR datos hacia el navegador
 * (mediciones, alertas). Para Node-RED, preguntar cada 2 s es más robusto:
 * sobrevive a reinicios y a cortes de red sin lógica de reconexión.
 *
 * ────────────────────────────────────────────────────────────────────
 * CÓMO MONTARLO EN NODE-RED
 * ────────────────────────────────────────────────────────────────────
 *
 *   [inject 2s] ──► [function: este código] ──► [json] ──► [debug]
 *
 * El nodo `function` usa `node.send` DOS VECES por salida:
 *   - La salida del mensaje MQTT (para el nodo `mqtt out`).
 *   - Un mensaje HTTP (para confirmar la entrega).
 *
 * Se configuran DOS salidas en el nodo function:
 *   salida 1 → nodo `mqtt out`      (publica la orden)
 *   salida 2 → nodo `http request`  (confirma a la API)
 *
 * ────────────────────────────────────────────────────────────────────
 * SI NO QUIERES USAR MQTT
 * ────────────────────────────────────────────────────────────────────
 * La salida 1 se puede conectar a lo que prefieras: un `http request` al PLC,
 * un `modbus write`, un `tcp out`… El payload ya viene listo.
 */

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────────────────────

/** URL base de la API. */
const API = "http://localhost:4000/api/v1";

/** API Key con permiso `comandos:enviar`. */
// Se lee de la variable de entorno de Node-RED (settings.js).
const API_KEY =
  env.get("NODE_RED_API_KEY") || "flx_CAMBIAR_ESTA_CLAVE";

/**
 * Prefijo de los temas MQTT.
 *
 * Cada actuador se publica en SU propio tema, para que un ESP32 solo reciba
 * las órdenes que le corresponden:
 *
 *     hospital/quirofano/cmd/RELE-1
 *     hospital/quirofano/cmd/RELE-2
 *
 * Si el actuador tiene `topico_mqtt` configurado en la base de datos, se usa
 * ese tal cual; si no, se construye con este prefijo + el código.
 */
const PREFIJO_TEMA = "hospital/quirofano/cmd";

/** Sinónimos de comando aceptados, normalizados a ON/OFF. */
const COMANDOS_ON = ["ON", "1", "TRUE", "ENCENDER", "ABRIR"];
const COMANDOS_OFF = ["OFF", "0", "FALSE", "APAGAR", "CERRAR"];

/** Normaliza el comando a un valor booleano comprensible por el equipo. */
function normalizar(comando) {
  const c = String(comando || "").trim().toUpperCase();
  if (COMANDOS_ON.includes(c)) return { valor: true, texto: "ON" };
  if (COMANDOS_OFF.includes(c)) return { valor: false, texto: "OFF" };
  // Comando desconocido: se envía tal cual, sin interpretarlo.
  return { valor: null, texto: c };
}

// ─────────────────────────────────────────────────────────────
// 1) PEDIR LOS COMANDOS PENDIENTES
// ─────────────────────────────────────────────────────────────
const respuesta = await fetch(API + "/iot/comandos/pendientes?limite=50", {
  method: "GET",
  headers: {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json",
  },
});

if (!respuesta.ok) {
  const texto = await respuesta.text();
  node.warn(
    `[comandos] La API respondió ${respuesta.status}. ¿API Key correcta? ${texto.slice(0, 120)}`
  );
  return null;
}

const cuerpo = await respuesta.json();
const pendientes = cuerpo?.datos ?? [];

// Sin comandos: no se emite nada (evita ensuciar el debug cada 2 segundos).
if (pendientes.length === 0) {
  node.status({ fill: "grey", shape: "ring", text: "sin comandos" });
  return null;
}

node.status({
  fill: "green",
  shape: "dot",
  text: `${pendientes.length} comando(s)`,
});

// ─────────────────────────────────────────────────────────────
// 2) PUBLICAR EN MQTT  +  3) CONFIRMAR A LA API
// ─────────────────────────────────────────────────────────────
const paraMqtt = [];
const paraConfirmar = [];

for (const cmd of pendientes) {
  const { valor, texto } = normalizar(cmd.comando);

  // Tema del actuador: el suyo propio si lo tiene, si no se deriva del código.
  const tema =
    cmd.actuador_topico_mqtt || `${PREFIJO_TEMA}/${cmd.actuador_codigo}`;

  paraMqtt.push({
    topic: tema,
    qos: 1,
    retain: false,
    payload: {
      // Identificación: permite al equipo comprobar que la orden es suya.
      actuador: cmd.actuador_codigo,
      dispositivo: cmd.dispositivo_identificador,
      comando: texto,
      valor,
      // El id permite al equipo ACK-ear la ejecución más tarde.
      comando_id: cmd.id,
      enviado_en: new Date().toISOString(),
      // Datos extra que pudiera haber añadido la web.
      parametros: cmd.valor ?? null,
    },
  });

  paraConfirmar.push(cmd.id);
}

// Salida 1: un mensaje por comando → nodo `mqtt out`.
node.send([paraMqtt, null]);

// Salida 2: confirmar la entrega a la API.
//
// Se hace DESPUÉS de publicar en MQTT. Si Node-RED se cayera entre ambas
// cosas, el comando seguiría 'pendiente' y se reintentaría: es preferible
// duplicar una entrega (idempotente para un relé) que perderla en silencio.
const confirmaciones = [];
for (const id of paraConfirmar) {
  const r = await fetch(API + "/iot/comandos/" + id, {
    method: "PATCH",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      estado: "enviado",
      respuesta: { origen: "node-red", via: "mqtt" },
    }),
  });

  confirmaciones.push({
    id,
    ok: r.ok,
    status: r.status,
  });

  if (!r.ok) {
    node.warn(`[comandos] No se pudo confirmar ${id}: HTTP ${r.status}`);
  }
}

node.send([null, confirmaciones]);

return null;
