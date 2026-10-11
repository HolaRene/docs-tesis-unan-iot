/**
 * Node-RED — COMANDOS DE ACTUADORES POR MQTT (sin `fetch`)
 * ========================================================
 *
 * ────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE USA `fetch` NI `http` DE NODE
 * ────────────────────────────────────────────────────────────────────
 * El nodo `function` de Node-RED se ejecuta dentro de un sandbox, y no
 * siempre expone `fetch`:
 *
 *   - Con el sandbox por defecto (`vm`), `fetch` NO existe.
 *   - `await` en el nivel superior solo funciona en versiones recientes.
 *   - Si el sandbox está en modo `none`, sí hay `fetch`, pero depender de
 *     eso hace que el flujo funcione en unos equipos y en otros no.
 *
 * La forma correcta y portable en Node-RED es el nodo **`http request`**.
 * El código solo PREPARA el mensaje; el nodo hace la llamada.
 *
 * ────────────────────────────────────────────────────────────────────
 * ESTRUCTURA DEL FLUJO
 * ────────────────────────────────────────────────────────────────────
 *
 *   [inject 2s]
 *        │
 *   [function: preparar-pendientes]   ← pone msg.url y msg.method
 *        │
 *   [http request]                    ← hace el GET a la API
 *        │
 *   [function: repartir]              ← un mensaje por comando
 *        │
 *     [split]
 *        │
 *   [mqtt out]                        ← publica cada orden
 *        │
 *   [function: preparar-confirmar]    ← pone msg.url del PATCH
 *        │
 *   [http request]                    ← confirma la entrega
 *        │
 *      [debug]
 *
 * ────────────────────────────────────────────────────────────────────
 * POR QUÉ "ENTREGAR Y CONFIRMAR" VAN ENCADENADOS
 * ────────────────────────────────────────────────────────────────────
 * El `mqtt out` no espera confirmación del broker: al publicar, el mensaje
 * sigue por la cadena. Así se confirma la entrega inmediatamente después de
 * publicar, sin bloquear el flujo.
 *
 * ⚠️ Si Node-RED se cayera entre publicar y confirmar, el comando seguiría
 * `pendiente` y se reintentaría. Es preferible duplicar una entrega
 * (idempotente para un relé) que perderla en silencio.
 */

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN COMÚN
// ─────────────────────────────────────────────────────────────
const API = "http://localhost:4000/api/v1";
const API_KEY = env.get("NODE_RED_API_KEY") || "flx_CAMBIAR_ESTA_CLAVE";

/** Sinónimos aceptados, normalizados a booleano. */
const COMANDOS_ON = ["ON", "1", "TRUE", "ENCENDER", "ABRIR"];
const COMANDOS_OFF = ["OFF", "0", "FALSE", "APAGAR", "CERRAR"];

/** Prefijo si el actuador no trae `topico_mqtt` en la base de datos. */
const PREFIJO_TEMA = "hospital/quirofano/cmd";

// =============================================================
// NODO 1 · PREPARAR LA PETICIÓN DE PENDIENTES
// =============================================================
// Este es el código del PRIMER nodo function. Solo prepara el mensaje:
// no llama a nadie.

msg.url = `${API}/iot/comandos/pendientes?limite=50`;
msg.method = "GET";
msg.headers = {
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
};

// Se guarda para saber, al volver, que esta respuesta es de "pendientes".
msg.contexto = "pendientes";

node.status({ fill: "blue", shape: "ring", text: "consultando" });
return msg;


// =============================================================
// NODO 2 · INTERPRETAR Y REPARTIR (va DESPUÉS del http request)
// =============================================================
/*

  ⬇️  COPIA ESTE BLOQUE EN UN SEGUNDO NODO `function`  ⬇️

*/

/*
// ¿La petición falló?
if (msg.statusCode < 200 || msg.statusCode >= 300) {
  node.warn(`[comandos] La API respondio ${msg.statusCode}`);
  if (msg.statusCode === 401) {
    node.warn("[comandos] API Key incorrecta o sin permiso comandos:enviar");
  }
  node.status({ fill: "red", shape: "ring", text: `HTTP ${msg.statusCode}` });
  return null;
}

// `msg.payload` ya viene como OBJETO si el nodo tiene "Parse JSON" activado.
// Si viene como texto, se parsea aquí para no depender de esa opción.
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
  return null;   // sin comandos: no se emite nada
}

const salidas = [];

for (const cmd of pendientes) {
  const tema = cmd.actuador_topico_mqtt || (PREFIJO_TEMA + "/" + cmd.actuador_codigo);

  const c = String(cmd.comando || "").trim().toUpperCase();
  const encender = COMANDOS_ON.includes(c);

  salidas.push({
    // El nodo `mqtt out` lee el tema de aquí: NO se configura un tema fijo.
    topic: tema,
    qos: 1,
    retain: false,
    payload: {
      actuador: cmd.actuador_codigo,
      dispositivo: cmd.dispositivo_identificador,
      comando: encender ? "ON" : "OFF",
      valor: encender,
      comando_id: cmd.id,          // permite confirmar despues
      enviado_en: new Date().toISOString(),
      parametros: cmd.valor || null,
    },
  });
}

node.status({ fill: "green", shape: "dot", text: salidas.length + " comando(s)" });

// Se devuelve un ARRAY: el nodo `split` los separa en mensajes sueltos.
return [salidas];

*/


// =============================================================
// NODO 3 · PREPARAR LA CONFIRMACIÓN DE ENTREGA
// =============================================================
/*

  ⬇️  COPIA ESTE BLOQUE EN UN TERCER NODO `function`  ⬇️
  (va DESPUÉS del `mqtt out`, sobre el mismo mensaje)

*/

/*
// El `comando_id` viaja dentro del payload publicado; se recupera aquí.
const id = msg.payload && msg.payload.comando_id;

if (!id) {
  // Sin id no hay nada que confirmar: probablemente el mensaje no venía
  // de este flujo.
  return null;
}

msg.url = `${API}/iot/comandos/${id}`;
msg.method = "PATCH";
msg.headers = {
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
};
msg.payload = {
  estado: "enviado",
  respuesta: { origen: "node-red", via: "mqtt" },
};

return msg;

*/
