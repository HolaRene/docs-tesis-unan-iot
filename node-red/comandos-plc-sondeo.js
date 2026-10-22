/**
 * Node-RED · Entrega de comandos al PLC con SONDEO y TIMEOUT
 * ============================================================
 *
 * Sustituye la espera fija de 300 ms por un sondeo de lectura de vuelta:
 *
 *   1. consulta pendientes
 *   2. escribe en el PLC
 *   3. lee la salida repetidamente hasta que coincide o vence el timeout
 *   4. confirma: 'ejecutado' si coincide, 'fallido' si vence
 *
 * ──────────────────────────────────────────────────────────────────────
 * POR QUÉ SONDEAR EN LUGAR DE ESPERAR 300 ms
 * ──────────────────────────────────────────────────────────────────────
 * Un extractor industrial tarda segundos en mover su compuerta. Con una
 * espera fija de 300 ms, la lectura de vuelta siempre devolvía el estado
 * ANTERIOR y el comando se marcaba como fallido aunque el equipo estuviera
 * haciendo justo lo pedido.
 *
 * Con un sondeo y un timeout amplio se distingue:
 *   - el equipo hizo lo pedido           → 'ejecutado'
 *   - no lo hizo antes del timeout       → 'fallido' con motivo 'timeout'
 *
 * ──────────────────────────────────────────────────────────────────────
 * MARCAS DE TIEMPO PARA LA TESIS
 * ──────────────────────────────────────────────────────────────────────
 * Cada comando lleva cuatro instantes, todos en UTC (toISOString):
 *
 *   creado_en     (API)   al encolarse
 *   recogido_en   (aquí)  al salir de esta consulta
 *   enviado_en    (aquí)  al escribir en el PLC
 *   confirmado_en (aquí)  al verificar la lectura de vuelta
 *
 * Con ellas la consulta SQL del proyecto desglosa dónde se va el tiempo.
 *
 * ──────────────────────────────────────────────────────────────────────
 * CONFIGURACIÓN
 * ──────────────────────────────────────────────────────────────────────
 * En la variable de entorno de Node-RED:
 *   API_URL      http://localhost:4000/api/v1
 *   API_KEY      flx_...
 *
 * La latencia y el timeout de cada actuador NO se configuran aquí: se leen
 * de GET /iot/actuadores/configuracion, que los toma de la configuración
 * del actuador en la web. Así el parámetro vive en un solo sitio.
 */
const API = env.get("API_URL") || "http://localhost:4000/api/v1";
const API_KEY = env.get("API_KEY") || "";
const INTERVALO_SONDEO_MS = 300;
/** Timeout por defecto si la API no responde con la configuración. */
const TIMEOUT_POR_DEFECTO_S = 10;

/**
 * Cache de configuración de actuadores.
 *
 * Se refresca cada 60 s en lugar de pedirla en cada comando: Node-RED puede
 * procesar varios comandos por segundo y una consulta por comando duplicaría
 * innecesariamente el tráfico.
 */
const CACHE = context.global.get("cacheConfigActuadores") || {
  datos: {},
  cargadaEn: 0,
};

async function configuracionDe(actuadorCodigo) {
  const ahora = Date.now();
  if (ahora - CACHE.cargadaEn > 60_000) {
    try {
      const r = await fetch(`${API}/iot/actuadores/configuracion`, {
        headers: { "X-API-Key": API_KEY },
      });
      if (r.ok) {
        const cuerpo = await r.json();
        CACHE.datos = {};
        for (const a of cuerpo.datos || []) {
          CACHE.datos[a.actuador_codigo] = a;
        }
        CACHE.cargadaEn = ahora;
        context.global.set("cacheConfigActuadores", CACHE);
      }
    } catch (e) {
      node.warn(`No se pudo leer la configuración de actuadores: ${e.message}`);
    }
  }

  return (
    CACHE.datos[actuadorCodigo] || {
      latencia_s: 0,
      timeout_s: TIMEOUT_POR_DEFECTO_S,
    }
  );
}

/* ══════════════════════════════════════════════════════════════════
   BLOQUE 1 · PREPARAR LA CONSULTA DE PENDIENTES
   ══════════════════════════════════════════════════════════════════
   Va antes del nodo `http request`.
   ══════════════════════════════════════════════════════════════════ */

msg.url = `${API}/iot/comandos/pendientes?limite=20`;
msg.method = "GET";
msg.headers = { "X-API-Key": API_KEY };
// Se guarda el instante de recogida: es la marca `recogido_en`.
msg.recogido_en = new Date().toISOString();
return msg;


/* ══════════════════════════════════════════════════════════════════
   BLOQUE 2 · PREPARAR CADA COMANDO PARA EL PLC
   ══════════════════════════════════════════════════════════════════
   Va DESPUÉS de la lectura de pendientes y ANTES del `split`.
   El `split` los separa para que el flujo los trate de uno en uno.
   ══════════════════════════════════════════════════════════════════ */

const pendientes = msg.payload?.datos || [];
if (pendientes.length === 0) {
  node.status({ fill: "grey", shape: "ring", text: "sin comandos" });
  return null;
}

const salidas = [];

for (const cmd of pendientes) {
  const dir = cmd.direccionamiento || {};
  const config = await configuracionDe(cmd.actuador_codigo);

  const encender = ["ON", "1", "TRUE", "ENCENDER"].includes(
    String(cmd.comando || "").toUpperCase()
  );

  const valor = encender
    ? (dir.valor_on !== undefined ? dir.valor_on : 1)
    : (dir.valor_off !== undefined ? dir.valor_off : 0);

  salidas.push({
    // El nodo `modbus write` lee de aquí la dirección y el tipo.
    topic: dir.tipo || "coil",
    payload: valor,
    // Contexto que viaja hasta la confirmación.
    comando_actual: {
      id: cmd.id,
      actuador_codigo: cmd.actuador_codigo,
      direccion: dir.direccion,
      unidad_id: dir.unidad_id ?? 1,
      valor_esperado: valor,
      // El PLC suele tardar en reflejar el cambio: se espera su latencia
      // más un margen, en lugar de un tiempo fijo.
      timeout_s: config.timeout_s,
      latencia_s: config.latencia_s,
      recogido_en: msg.recogido_en,
    },
  });
}

node.status({ fill: "blue", shape: "dot", text: `${salidas.length} comando(s)` });
return [salidas];


/* ══════════════════════════════════════════════════════════════════
   BLOQUE 3 · SONDEO DE LECTURA DE VUELTA
   ══════════════════════════════════════════════════════════════════
   Va DESPUÉS del `modbus write`.

   Este bloque usa un BUCLE con espera asíncrona: vuelve a leer cada
   300 ms hasta que el valor coincide o se agota el timeout.

   Para que funcione, el flujo necesita:
     modbus write  →  (este nodo)  →  modbus read (bobina/registro)
                    ↑                     │
                    └─────────────────────┘   (vuelve si no coincide)

   El nodo `modbus read` debe apuntar a `msg.topic` y `msg.direccion`.
   ══════════════════════════════════════════════════════════════════ */

const actual = msg.comando_actual;
if (!actual) return null;

// Primera vez que pasa por aquí: marcar el envío y arrancar el cronómetro.
if (!actual.enviado_en) {
  actual.enviado_en = new Date().toISOString();
  actual.inicio_ms = Date.now();
  node.status({
    fill: "blue",
    shape: "dot",
    text: `${actual.actuador_codigo}: esperando (máx ${actual.timeout_s}s)`,
  });
}

// ¿Se alcanzó el valor esperado?
const leido = msg.payload;
const coincide = String(leido) === String(actual.valor_esperado);

if (coincide) {
  actual.confirmado_en = new Date().toISOString();
  node.status({ fill: "green", shape: "dot", text: `${actual.actuador_codigo}: confirmado` });
  return [null, msg];           // salida 2 → confirmar 'ejecutado'
}

const transcurrido_ms = Date.now() - actual.inicio_ms;
const limite_ms = actual.timeout_s * 1000;

if (transcurrido_ms >= limite_ms) {
  node.warn(
    `[timeout] ${actual.actuador_codigo}: se esperaba ${actual.valor_esperado} ` +
    `y se leyó ${leido} tras ${(transcurrido_ms / 1000).toFixed(1)} s`
  );
  return [null, msg];           // salida 2 → confirmar 'fallido'
}

// Aún no: esperar y volver a leer.
await new Promise((r) => setTimeout(r, 300));
msg.direccion = actual.direccion;
msg.unidad_id = actual.unidad_id;
node.status({
  fill: "yellow",
  shape: "ring",
  text: `${actual.actuador_codigo}: ${(transcurrido_ms / 1000).toFixed(1)}s`,
});
return [msg, null];             // salida 1 → volver a `modbus read`


/* ══════════════════════════════════════════════════════════════════
   BLOQUE 4 · CONFIRMAR A LA API
   ══════════════════════════════════════════════════════════════════
   Va ANTES del `http request` que hace PATCH /iot/comandos/:id.

   Decide 'ejecutado' o 'fallido' comparando lo leído con lo pedido,
   e incluye las marcas de tiempo.
   ══════════════════════════════════════════════════════════════════ */

const c = msg.comando_actual;
const valorLeido = msg.payload;
const exito = String(valorLeido) === String(c.valor_esperado);
const transcurrido = c.inicio_ms ? Date.now() - c.inicio_ms : null;

msg.url = `${API}/iot/comandos/${c.id}`;
msg.method = "PATCH";
msg.headers = { "X-API-Key": API_KEY, "Content-Type": "application/json" };

msg.payload = {
  estado: exito ? "ejecutado" : "fallido",
  // Estado REAL del actuador tras la operación.
  estado_actuador: exito
    ? (String(c.valor_esperado) === "1" ? "on" : "off")
    : undefined,

  // Marcas de tiempo (UTC) para el análisis de latencias.
  recogido_en: c.recogido_en,
  enviado_en: c.enviado_en,
  confirmado_en: c.confirmado_en,

  respuesta: {
    valor_esperado: c.valor_esperado,
    valor_leido: valorLeido,
    intentos_ms: transcurrido,
    // El motivo es lo que permite contar fallos por timeout en SQL.
    motivo: exito ? "confirmado" : "timeout",
    timeout_s: c.timeout_s,
    latencia_configurada_s: c.latencia_s,
  },
};

node.status({
  fill: exito ? "green" : "red",
  shape: "dot",
  text: `${c.actuador_codigo}: ${exito ? "ejecutado" : "timeout"}`,
});

return msg;
