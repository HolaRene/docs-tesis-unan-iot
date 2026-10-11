/**
 * Node-RED — COMANDOS A PLC POR MODBUS, CON CONFIRMACIÓN (sin `fetch`)
 * ====================================================================
 *
 * Cierra el circuito: recoge los comandos pendientes, los escribe en el PLC
 * por Modbus y **confirma a la API si funcionó o no**.
 *
 * ────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE USA `fetch`
 * ────────────────────────────────────────────────────────────────────
 * El nodo `function` corre en un sandbox que NO siempre expone `fetch`. Con
 * el sandbox por defecto (`vm`) no existe, y `await` en el nivel superior
 * solo funciona en versiones recientes.
 *
 * La forma portable es el nodo **`http request`**. El código solo prepara
 * `msg.url`, `msg.method` y `msg.headers`.
 *
 * ────────────────────────────────────────────────────────────────────
 * ESTRUCTURA DEL FLUJO
 * ────────────────────────────────────────────────────────────────────
 *
 *   [inject 2s]
 *        │
 *   [function: preparar-pendientes]   ← GET /iot/comandos/pendientes
 *        │
 *   [http request]
 *        │
 *   [function: repartir]              ← un mensaje por comando
 *        │
 *     [split]
 *        │
 *  [modbus write]                      ← escribe en el PLC
 *        │
 *   [function: preparar-confirmar]     ← PATCH con el resultado
 *        │
 *   [http request]
 *        │
 *      [debug]
 *
 * ────────────────────────────────────────────────────────────────────
 * EL PROBLEMA QUE RESUELVE CONFIRMAR
 * ────────────────────────────────────────────────────────────────────
 * Sin confirmar, el comando se queda en `pendiente` para siempre y el
 * `inject` lo vuelve a escribir en el PLC en cada ciclo, indefinidamente.
 * Confirmar es lo que CIERRA el circuito y detiene el reenvío.
 *
 * ⚠️ Que el `modbus write` no dé error significa que el PLC ACEPTÓ la
 * escritura, no que la salida física cambió. Para saberlo hay que LEER de
 * vuelta (ver `docs/node-red-modbus.md`, sección 3).
 */

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN COMÚN
// ─────────────────────────────────────────────────────────────
const API = "http://localhost:4000/api/v1";
const API_KEY = env.get("NODE_RED_API_KEY") || "flx_CAMBIAR_ESTA_CLAVE";

/** Dirección Modbus por defecto si el actuador no la trae. */
const REGISTRO_POR_DEFECTO = 0;

/**
 * Mapa de direcciones Modbus por código de actuador.
 *
 * Respaldo local: lo ideal es que cada actuador traiga su dirección en
 * `configuracion.modbus` desde la base de datos, para no editar Node-RED al
 * añadir un actuador.
 */
const DIRECCIONES = {
  "LED-1": { direccion: 0, tipo: "coil" },
  "RELE-1": { direccion: 1, tipo: "coil" },
};

// =============================================================
// NODO 1 · PREPARAR LA PETICIÓN DE PENDIENTES
// =============================================================

msg.url = `${API}/iot/comandos/pendientes?limite=50`;
msg.method = "GET";
msg.headers = {
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
};

node.status({ fill: "blue", shape: "ring", text: "consultando" });
return msg;


// =============================================================
// NODO 2 · INTERPRETAR Y REPARTIR (tras el http request)
// =============================================================
/*

  ⬇️  COPIA ESTE BLOQUE EN UN SEGUNDO NODO `function`  ⬇️

*/

/*
if (msg.statusCode < 200 || msg.statusCode >= 300) {
  node.warn(`[comandos] La API respondio ${msg.statusCode}`);
  if (msg.statusCode === 401) {
    node.warn("[comandos] API Key incorrecta o sin permiso comandos:enviar");
  }
  node.status({ fill: "red", shape: "ring", text: `HTTP ${msg.statusCode}` });
  return null;
}

let cuerpo = msg.payload;
if (typeof cuerpo === "string") {
  try {
    cuerpo = JSON.parse(cuerpo);
  } catch (e) {
    node.warn("[comandos] La respuesta no es JSON valido");
    return null;
  }
}

const pendientes = (cuerpo && cuerpo.datos) ? cuerpo.datos : [];

if (pendientes.length === 0) {
  node.status({ fill: "grey", shape: "ring", text: "sin comandos" });
  return null;
}

const salidas = [];

for (const cmd of pendientes) {
  const cfg = DIRECCIONES[cmd.actuador_codigo] || {};
  const direccion = (cfg.direccion !== undefined) ? cfg.direccion : REGISTRO_POR_DEFECTO;
  const tipo = cfg.tipo || "coil";

  const c = String(cmd.comando || "").trim().toUpperCase();
  const encender = ["ON", "1", "TRUE", "ENCENDER", "ABRIR"].includes(c);

  salidas.push({
    // El nodo `modbus write` lee de aqui la direccion y el tipo.
    topic: tipo,
    payload: encender ? 1 : 0,
    // Contexto que viaja hasta la fase de confirmacion.
    comando_actual: {
      id: cmd.id,
      actuador_codigo: cmd.actuador_codigo,
      direccion: direccion,
      valor_on: encender,
    },
  });
}

node.status({ fill: "blue", shape: "dot", text: salidas.length + " comando(s)" });

return [salidas];

*/


// =============================================================
// NODO 3 · PREPARAR LA CONFIRMACIÓN (tras el modbus write)
// =============================================================
/*

  ⬇️  COPIA ESTE BLOQUE EN UN TERCER NODO `function`  ⬇️

*/

/*
const cmd = msg.comando_actual;

if (!cmd) {
  // Sin contexto no se sabe que comando era: no se confirma nada.
  return null;
}

const p = msg.payload || {};

// ── Detección del error de Modbus ──────────────────────────────
//
// El nodo `modbus write` NO lanza excepcion: devuelve el error dentro del
// payload. Se comprueban TRES senales distintas, porque con una sola
// algunos fallos pasarian por exitos.
const errorCode = p.errorCode !== undefined ? p.errorCode : p.error;
const errorMensaje = p.errorMessage !== undefined
  ? p.errorMessage
  : (msg.error ? msg.error.message : null);
const huboError = Boolean(errorCode || errorMensaje);

const estado = huboError ? "fallido" : "ejecutado";

msg.url = `${API}/iot/comandos/${cmd.id}`;
msg.method = "PATCH";
msg.headers = {
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
};
msg.payload = {
  estado: estado,
  // `estado_actuador` hace que la web muestre el estado REAL del equipo.
  // Solo se envia si la escritura fue bien: si fallo, no sabemos en que
  // estado quedo la salida y es mejor no inventarlo.
  estado_actuador: huboError ? undefined : (cmd.valor_on ? "on" : "off"),
  respuesta: {
    origen: "node-red",
    via: "modbus",
    direccion: cmd.direccion,
    valor_escrito: cmd.valor_on ? 1 : 0,
    error: huboError ? String(errorMensaje || errorCode) : undefined,
    ok: !huboError,
  },
};

// Se limpia el contexto para que no viaje al siguiente nodo.
delete msg.comando_actual;

node.status({
  fill: huboError ? "red" : "green",
  shape: "dot",
  text: cmd.actuador_codigo + (huboError ? " FALLO" : " OK"),
});

if (huboError) {
  node.warn(`[modbus] ${cmd.actuador_codigo} fallo en ${cmd.direccion}: ${errorMensaje}`);
}

return msg;

*/
