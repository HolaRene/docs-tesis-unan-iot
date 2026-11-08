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
 * TRES REGLAS QUE NO SE DEBEN ROMPER
 * ──────────────────────────────────────────────────────────────────────
 *
 * 1. SE MARCA `enviado` ANTES DE ESCRIBIR.
 *
 *    El inject consulta cada 2 s. Si el comando sigue `pendiente` mientras
 *    se está escribiendo, el siguiente ciclo lo escribe OTRA VEZ, y las dos
 *    escrituras Modbus chocan. Marcándolo `enviado` al recogerlo, deja de
 *    aparecer en `/iot/comandos/pendientes`.
 *
 * 2. SE DECIDE POR LA LECTURA, NO POR EL ERROR DE LA ESCRITURA.
 *
 *    El `modbus write` puede devolver error (timeout de respuesta, CRC…)
 *    aunque la bobina SÍ haya quedado escrita: OpenPLC tarda en contestar.
 *    La única prueba de que la orden se aplicó es leerla de vuelta.
 *
 *    Si el valor leído coincide y la escritura había dado error, el comando
 *    se da por EJECUTADO y el error se guarda en `respuesta.advertencia`.
 *    No se oculta: quien lea el historial debe saber que hubo un aviso.
 *
 * 3. RESPONSE TIMEOUT DEL CLIENTE MODBUS: 3–5 s.
 *
 *    En el nodo `modbus write` y en el `modbus read`:
 *      Response timeout  → 5000 ms
 *      Delay between polls → 1000 ms
 *    OpenPLC responde lento; con el valor por defecto (1000 ms) casi todas
 *    las escrituras dan error aunque funcionen.
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
/** Espera antes de la lectura tardía de reconciliación. */
const ESPERA_RECONCILIACION_MS = 10_000;

/** Timeout por defecto si la API no responde con la configuración. */
const TIMEOUT_POR_DEFECTO_S = 10;

/**
 * ──────────────────────────────────────────────────────────────────────
 * NORMALIZAR EL VALOR LEÍDO
 * ──────────────────────────────────────────────────────────────────────
 * El nodo `modbus read` de una bobina NO devuelve `1`: devuelve un arreglo
 * de booleanos, `[true]`.
 *
 * Comparar `String([true])` («true») con `String(1)` («1») nunca coincide,
 * así que TODOS los comandos acababan en timeout aunque el PLC sí hubiera
 * cambiado. Hay que normalizar antes de comparar.
 */
function normalizarLeido(crudo) {
  // Algunas configuraciones devuelven el arreglo dentro de `payload`.
  let v = crudo;
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object" && !(v instanceof Boolean)) {
    // Objetos tipo { value: 1 } o { datos: [true] }
    if (v.value !== undefined) v = Array.isArray(v.value) ? v.value[0] : v.value;
    else if (Array.isArray(v.datos)) v = v.datos[0];
  }

  // Cualquier representación de «encendido» vale.
  if (v === true || v === 1 || v === "1" || v === "true" || v === "TRUE") return 1;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "FALSE") return 0;
  return v;
}

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

  /*
   * ── MARCAR 'enviado' ANTES DE ESCRIBIR ──
   *
   * Este inject corre cada 2 s. Si el comando siguiera `pendiente` mientras
   * se escribe, el siguiente ciclo lo recogería otra vez, lo escribiría de
   * nuevo, y las dos escrituras Modbus pueden pisarse: la segunda puede
   * llegar a mitad de la primera y dejar la bobina en un estado indefinido.
   *
   * Marcándolo ahora, `/iot/comandos/pendientes` deja de devolverlo y no hay
   * segunda escritura. El precio es que si Node-RED muere justo aquí, el
   * comando queda `enviado` sin confirmar; por eso existe la reconciliación
   * por estado reportado en la API, y por eso el comando expira.
   */
  const enviadoEn = new Date().toISOString();
  try {
    await fetch(`${API}/iot/comandos/${cmd.id}`, {
      method: "PATCH",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ estado: "enviado", enviado_en: enviadoEn }),
    });
  } catch (e) {
    // Si no se puede marcar, NO se escribe: se evita el duplicado.
    node.warn(`No se pudo marcar 'enviado' ${cmd.id}: ${e.message}`);
    continue;
  }

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
      // Ya quedó marcado arriba; aquí solo se propaga al resto del flujo.
      enviado_en: enviadoEn,
      /*
       * Error que reportó la ESCRITURA, si lo hubo. Se rellena en el bloque
       * 3 y NO decide nada: la decisión es de la lectura de vuelta.
       */
      error_escritura: null,
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

/*
 * ── CAPTURAR EL ERROR DE ESCRITURA, SIN DECIDIR CON ÉL ──
 *
 * El nodo `modbus write` deja el resultado en `msg.payload` o en `msg.error`
 * según cómo esté configurado. Aquí solo se ANOTA: la decisión la toma la
 * lectura de vuelta, más abajo.
 *
 * OpenPLC tarda en responder; con un Response timeout de 1 s el write da
 * error aunque la bobina haya quedado escrita. Descartar el comando por ese
 * error marcaría como fallido algo que sí funcionó.
 */
if (msg.error || msg.payload?.error) {
  actual.error_escritura =
    String(msg.error || msg.payload?.error?.message || msg.payload?.error);
  node.warn(
    `[escritura] ${actual.actuador_codigo}: ${actual.error_escritura} ` +
    `— se decidirá por lectura de vuelta`
  );
}

// Primera vez que pasa por aquí: arrancar el cronómetro.
// (`enviado_en` ya se fijó ANTES de escribir, en el bloque 2.)
if (!actual.inicio_ms) {
  actual.inicio_ms = Date.now();
  node.status({
    fill: "blue",
    shape: "dot",
    text: `${actual.actuador_codigo}: esperando (máx ${actual.timeout_s}s)`,
  });
}

// ¿Se alcanzó el valor esperado?
// Se normaliza: `modbus read` devuelve `[true]` para una bobina, y
// `String([true])` nunca es igual a `String(1)`.
const leido = normalizarLeido(msg.payload);
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
    `y se leyó ${leido} tras ${(transcurrido_ms / 1000).toFixed(1)} s` +
    (actual.error_escritura
      ? ` (la escritura había avisado: ${actual.error_escritura})`
      : "")
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
const valorLeido = normalizarLeido(msg.payload);
const transcurrido = c.inicio_ms ? Date.now() - c.inicio_ms : null;

/*
 * ── LA DECISIÓN ES DE LA LECTURA, NO DE LA ESCRITURA ──
 *
 * `exito` depende SOLO de que el valor leído coincida con el esperado.
 * El error de la escritura (`c.error_escritura`) NO cambia la decisión:
 *
 *   - write con error + lectura correcta  → EJECUTADO, con advertencia
 *   - write correcto + lectura incorrecta → fallido (timeout)
 *
 * OpenPLC tarda en contestar al write; descartar por ese error marcaría
 * como fallido algo que la bobina ya tiene aplicado.
 */
const exito = String(valorLeido) === String(c.valor_esperado);

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

    /*
     * ADVERTENCIA: la escritura dio error pero la lectura confirmó.
     *
     * Se guarda y se muestra. Ocultarlo dejaría un historial que dice
     * «ejecutado» sin rastro de que hubo un problema de comunicación, y
     * quien lo revise no entendería por qué el equipo a veces tarda.
     */
    ...(exito && c.error_escritura
      ? {
          advertencia:
            `escritura reportó error: ${c.error_escritura}` +
            " — confirmado por lectura de vuelta",
          error_escritura: c.error_escritura,
          confirmado_por: "lectura_vuelta",
        }
      : {}),
  },
};

node.status({
  fill: exito ? "green" : "red",
  shape: "dot",
  text:
    `${c.actuador_codigo}: ${exito ? "ejecutado" : "timeout"}` +
    (exito && c.error_escritura ? " (con aviso)" : ""),
});

return msg;


/* ══════════════════════════════════════════════════════════════════
   BLOQUE 5 · LECTURA EXTRA TARDÍA (reconciliación)
   ══════════════════════════════════════════════════════════════════

   ── POR QUÉ EXISTE ──

   El bloque 4 confirma el comando cuando la lectura coincide dentro del
   timeout. Si el equipo tarda MÁS (un extractor que se mueve despacio),
   el comando queda `fallido` aunque la orden sí se aplicó.

   Existe un endpoint para corregirlo:

       POST /iot/actuadores/:codigo/estado

   …pero NADIE lo llamaba. La reconciliación estaba escrita y no se
   ejecutaba nunca. Este bloque es el que la activa.

   ── CUÁNDO SE EJECUTA ──

   Solo si el comando terminó en TIMEOUT. Si ya se confirmó, no hace
   falta. Se espera `ESPERA_RECONCILIACION_MS` y se lee una vez más.

   Si en esa lectura el actuador está en el estado pedido, se avisa a la
   API y ella pasa el comando a `ejecutado` con
   `confirmado_por = "estado_reportado"`.

   ══════════════════════════════════════════════════════════════════ */

const c5 = msg.comando_actual;

// Solo tiene sentido si el comando quedó sin confirmar.
if (!c5 || String(normalizarLeido(msg.payload)) === String(c5.valor_esperado)) {
  return null;
}

// Esperar antes de la lectura extra: si el equipo cambia justo después del
// timeout, es ahora cuando se verá.
await new Promise((r) => setTimeout(r, ESPERA_RECONCILIACION_MS));

msg.direccion = c5.direccion;
msg.unidad_id = c5.unidad_id;
msg.reconciliacion = true; // marca para el bloque 6

node.status({
  fill: "yellow",
  shape: "ring",
  text: `${c5.actuador_codigo}: lectura tardía`,
});

// Salida 1 → `modbus read` y vuelve al bloque 6.
return [msg, null];


/* ══════════════════════════════════════════════════════════════════
   BLOQUE 6 · AVISAR A LA API DEL ESTADO REAL
   ══════════════════════════════════════════════════════════════════

   Va DESPUÉS de la lectura tardía del bloque 5.

   Informa a la API del estado que tiene el actuador AHORA. La API decide:
   si coincide con un comando reciente `fallido` o `enviado` (últimos 2
   minutos), lo pasa a `ejecutado` conservando el error original.

   No se envía nada si el actuador no está en el estado que se pedía:
   avisar de un estado distinto solo generaría ruido.

   ══════════════════════════════════════════════════════════════════ */

const c6 = msg.comando_actual;
const leido6 = normalizarLeido(msg.payload);

if (!c6 || String(leido6) !== String(c6.valor_esperado)) {
  node.status({
    fill: "grey",
    shape: "ring",
    text: `${c6?.actuador_codigo ?? "?"}: sigue sin confirmar`,
  });
  return null;
}

const estadoReal = String(leido6) === "1" ? "on" : "off";

msg.url = `${API}/iot/actuadores/${c6.actuador_codigo}/estado`;
msg.method = "POST";
msg.headers = { "X-API-Key": API_KEY, "Content-Type": "application/json" };
msg.payload = { estado: estadoReal };

node.status({
  fill: "green",
  shape: "dot",
  text: `${c6.actuador_codigo}: reportado ${estadoReal}`,
});

return msg;
