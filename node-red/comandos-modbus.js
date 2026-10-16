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

/*
 * Ya NO hay dirección por defecto a propósito.
 *
 * Antes existía `REGISTRO_POR_DEFECTO = 0`: si el actuador no traía
 * dirección, se escribía en la 0 en silencio. Eso accionaba OTRA salida del
 * PLC, y el síntoma («pulso el extractor y se enciende la luz») es de los
 * que cuesta horas encontrar.
 *
 * Ahora, si falta la dirección, el comando se salta y se avisa.
 */

/**
 * ¿Hace falta un mapa de direcciones aquí?
 *
 * NO. Y esa es la mejora importante: la dirección ya NO se configura en
 * Node-RED, viene en el propio comando desde la API.
 *
 * Antes había que mantener este mapa a mano:
 *
 *     const DIRECCIONES = {
 *       "LED-1":    { direccion: 0, tipo: "coil" },
 *       "RELE-1":   { direccion: 1, tipo: "coil" },
 *     };
 *
 * Eso obligaba a editar Node-RED cada vez que se añadía un actuador, y las
 * direcciones (que son el CABLEADO de la instalación) acababan duplicadas en
 * dos sitios que podían desincronizarse.
 *
 * Ahora la API envía:
 *
 *     direccionamiento: {
 *       protocolo: "modbus", tipo: "coil", direccion: 100, unidad_id: 1,
 *       valor_on: 1, valor_off: 0
 *     }
 *
 * Node-RED solo lo reenvía al nodo `modbus write`. Añadir un actuador nuevo
 * no requiere tocar este flujo.
 */

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
  /*
   * La dirección viene DEL COMANDO, no de un mapa local.
   *
   * Es la diferencia clave: añadir un actuador nuevo ya no obliga a editar
   * este flujo. La API la calcula desde la configuración del actuador.
   */
  const dir = cmd.direccionamiento || {};

  const direccion = dir.direccion;
  const tipo = dir.tipo || "coil";
  const unidad = dir.unidad_id !== undefined ? dir.unidad_id : 1;

  /*
   * Si el comando NO trae dirección, no se puede accionar nada.
   *
   * Se avisa y se SALTA el comando en lugar de escribir en la dirección 0,
   * que es una salida real del PLC y accionaría OTRO equipo. Ese fallo sería
   * muy difícil de diagnosticar: «pulso el extractor y se enciende la luz».
   */
  if (direccion === undefined || direccion === null) {
    node.warn(
      `[modbus] ${cmd.actuador_codigo} no tiene dirección configurada. ` +
      `Configúrala en la web (Actuadores → editar → protocolo Modbus).`
    );
    continue;
  }

  const c = String(cmd.comando || "").trim().toUpperCase();
  const encender = ["ON", "1", "TRUE", "ENCENDER", "ABRIR"].includes(c);

  /*
   * El valor sale del comando, no de un 1/0 fijo: un relé invertido se
   * activa escribiendo 0.
   */
  const valor = encender
    ? (dir.valor_on !== undefined ? dir.valor_on : 1)
    : (dir.valor_off !== undefined ? dir.valor_off : 0);

  salidas.push({
    // El nodo `modbus write` lee de aqui la direccion y el tipo.
    topic: tipo,
    payload: valor,
    // La unidad Modbus distingue varios PLC en la misma red.
    unidad_id: unidad,
    // Contexto que viaja hasta la fase de confirmacion.
    comando_actual: {
      id: cmd.id,
      actuador_codigo: cmd.actuador_codigo,
      direccion: direccion,
      unidad_id: unidad,
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
