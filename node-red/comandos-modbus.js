/**
 * Node-RED — COMANDOS A PLC POR MODBUS, CON CONFIRMACIÓN
 * ======================================================
 *
 * Cierra el circuito: recoge los comandos pendientes, los escribe en el PLC
 * por Modbus y **confirma a la API si funcionó o no**.
 *
 * ────────────────────────────────────────────────────────────────────
 * EL PROBLEMA QUE RESUELVE
 * ────────────────────────────────────────────────────────────────────
 * Sin confirmar, la API no sabe nada: el comando se queda en `pendiente`
 * para siempre. Y como sigue pendiente, el `inject` lo vuelve a enviar en la
 * siguiente vuelta. Resultado:
 *
 *   - No sabes si el PLC encendió.
 *   - El comando se escribe en el PLC una y otra vez.
 *   - La web muestra "pendiente" eternamente.
 *
 * Confirmar es lo que convierte esto en un circuito cerrado.
 *
 * ────────────────────────────────────────────────────────────────────
 * ESTRUCTURA EN NODE-RED
 * ────────────────────────────────────────────────────────────────────
 *
 *   [inject 2s]
 *        │
 *   [function: pedir pendientes]      ← hace el GET, arma la lista
 *        │
 *   [split]                           ← un mensaje por comando
 *        │
 *   [modbus write]                    ← escribe en el PLC
 *        │
 *   [function: confirmar]             ← interpreta el resultado y hace PATCH
 *        │
 *   [debug]
 *
 * ────────────────────────────────────────────────────────────────────
 * CÓMO SE INTERPRETA EL RESULTADO DE MODBUS
 * ────────────────────────────────────────────────────────────────────
 * El nodo `modbus write` NO lanza error si el PLC responde con una excepción:
 * devuelve el error en `msg.payload` (con `payload.errorCode` y
 * `payload.errorMessage`) o deja el mensaje tal cual si todo fue bien.
 *
 * Hay que mirar esas señales explícitamente. Si no, se confirma "ejecutado"
 * aunque el PLC haya rechazado la escritura.
 *
 * ────────────────────────────────────────────────────────────────────
 * OJO: QUÉ SE PUEDE AFIRMAR Y QUÉ NO
 * ────────────────────────────────────────────────────────────────────
 * Que el `modbus write` no dé error significa que el PLC ACEPTÓ la escritura,
 * no necesariamente que la salida física cambió. Para saber eso de verdad hay
 * que LEER el registro/coil y comprobar el valor. En la sección 3 del
 * documento se explica cómo hacerlo con un `modbus read` después.
 */

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────────────────────
const API = "http://localhost:4000/api/v1";
const API_KEY = env.get("NODE_RED_API_KEY") || "flx_CAMBIAR_ESTA_CLAVE";

/** Dirección Modbus por defecto si el actuador no la trae. */
const REGISTRO_POR_DEFECTO = 0;

/**
 * Mapa de direcciones Modbus por código de actuador.
 *
 * Se usa SOLO como respaldo: lo ideal es que cada actuador traiga su dirección
 * en `configuracion.modbus` desde la base de datos. Así, añadir un actuador no
 * obliga a editar Node-RED.
 *
 *   configuracion: { "modbus": { "direccion": 100, "tipo": "coil" } }
 */
const DIRECCIONES = {
  "LED-1": { direccion: 0, tipo: "coil" },
  "RELE-1": { direccion: 1, tipo: "coil" },
};

// ─────────────────────────────────────────────────────────────
// ¿En qué fase está este mensaje?
// ─────────────────────────────────────────────────────────────
//
// El mismo nodo se usa para DOS tareas distintas:
//   1. Recoger los pendientes (no trae `msg.comando_actual`).
//   2. Confirmar el resultado (sí lo trae, porque viene del modbus write).
//
// Distinguirlas es lo que permite tener un solo nodo en lugar de dos.

if (msg.comando_actual) {
  // ─────────── FASE 2: CONFIRMAR EL RESULTADO ───────────
  const cmd = msg.comando_actual;
  const p = msg.payload || {};

  /*
   * Detección de error de Modbus.
   *
   * El nodo devuelve el fallo de tres formas posibles según la versión:
   *   - `payload.errorCode` + `payload.errorMessage` (excepción Modbus)
   *   - `payload.error` (error de transporte)
   *   - `msg.error` (fallo del propio nodo)
   *
   * Se comprueban las tres: quedarse con una sola haría que algunos fallos
   * pasaran por éxitos.
   */
  const errorCode = p.errorCode ?? p.error;
  const errorMensaje = p.errorMessage ?? msg.error?.message;
  const huboError = Boolean(errorCode || errorMensaje);

  const estado = huboError ? "fallido" : "ejecutado";

  msg.headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json",
  };
  msg.url = `${API}/iot/comandos/${cmd.id}`;
  msg.method = "PATCH";
  msg.payload = {
    estado,
    /*
     * `estado_actuador` hace que la web muestre el estado REAL del equipo.
     * Solo se envía si la escritura fue bien: si falló, no sabemos en qué
     * estado quedó la salida y es mejor no inventarlo.
     */
    ...(huboError ? {} : { estado_actuador: cmd.valor_on ? "on" : "off" }),
    respuesta: {
      origen: "node-red",
      via: "modbus",
      direccion: cmd.direccion,
      valor_escrito: cmd.valor_on ? 1 : 0,
      ...(huboError ? { error: String(errorMensaje ?? errorCode) } : { ok: true }),
    },
  };

  node.status({
    fill: huboError ? "red" : "green",
    shape: "dot",
    text: `${cmd.actuador_codigo} ${huboError ? "FALLO" : "OK"}`,
  });

  if (huboError) {
    node.warn(
      `[modbus] ${cmd.actuador_codigo} fallo al escribir en ${cmd.direccion}: ${errorMensaje}`
    );
  }

  return msg;
}

// ─────────── FASE 1: PEDIR LOS PENDIENTES ───────────

const respuesta = await fetch(`${API}/iot/comandos/pendientes?limite=50`, {
  method: "GET",
  headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
});

if (!respuesta.ok) {
  node.warn(`[comandos] La API respondio ${respuesta.status}`);
  return null;
}

const cuerpo = await respuesta.json();
const pendientes = cuerpo?.datos ?? [];

if (pendientes.length === 0) {
  node.status({ fill: "grey", shape: "ring", text: "sin comandos" });
  return null;
}

const salidas = [];

for (const cmd of pendientes) {
  // Dirección Modbus: primero la del actuador, luego el mapa local.
  const cfg = DIRECCIONES[cmd.actuador_codigo] || {};
  const direccion = cfg.direccion ?? REGISTRO_POR_DEFECTO;
  const tipo = cfg.tipo ?? "coil";

  // Normalizar el comando a 0/1 (lo que entiende Modbus).
  const c = String(cmd.comando || "").trim().toUpperCase();
  const encender = ["ON", "1", "TRUE", "ENCENDER", "ABRIR"].includes(c);

  salidas.push({
    payload: encender ? 1 : 0,
    // El nodo `modbus write` lee de aquí la dirección y el tipo.
    topic: tipo,
    // Contexto que viaja hasta la fase de confirmación.
    comando_actual: {
      id: cmd.id,
      actuador_codigo: cmd.actuador_codigo,
      direccion,
      valor_on: encender,
    },
  });
}

node.status({
  fill: "blue",
  shape: "dot",
  text: `${salidas.length} comando(s)`,
});

// `node.send` acepta un array: el `split` los separará en mensajes sueltos.
return [salidas];
