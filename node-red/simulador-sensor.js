/**
 * Simulador de sensores para Node-RED — TELEMETRÍA aleatoria realista.
 *
 * ────────────────────────────────────────────────────────────────────
 * PERFILES DISPONIBLES
 * ────────────────────────────────────────────────────────────────────
 * Cambia `PERFIL` para elegir qué sensor simulas:
 *
 *   "dht"        → temperatura + humedad (como un DHT22)
 *   "electrico"  → voltaje + corriente + potencia + frecuencia (línea 230 V)
 *
 * ────────────────────────────────────────────────────────────────────
 * CÓMO USARLO EN NODE-RED
 * ────────────────────────────────────────────────────────────────────
 * 1. Nodo "function": pega este código completo.
 * 2. Nodo "inject" conectado a él:
 *      msg.payload = string vacío
 *      Repeat      = interval
 *      Every       = 15 (segundos)   ← ver aviso de rate limit abajo
 * 3. Nodo "http request" a la salida:
 *      Method → POST
 *      URL    → http://localhost:4000/api/v1/iot/mediciones
 * 4. Nodo "debug" a la salida del http request para ver la respuesta.
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ RATE LIMIT: NO uses 5 segundos
 * ────────────────────────────────────────────────────────────────────
 * La API limita a 100 peticiones cada 15 minutos por IP. A 5 s son 180
 * peticiones: a partir del minuto 8 recibirás HTTP 429 y el simulador
 * dejará de guardar datos sin avisar.
 *
 *      cada  5 s → 180 peticiones/15 min → SE PASA
 *      cada 10 s →  90 peticiones/15 min → justo al límite
 *      cada 15 s →  60 peticiones/15 min → recomendado
 *
 * Se recomienda 15 s: deja margen para que tú también navegues por la web
 * (que consume del mismo límite).
 *
 * Si ves HTTP 429 en el debug, espera 15 minutos o sube el intervalo.
 *
 * ⚠️ IMPORTANTE: este nodo debe colgar de su PROPIO `inject`, nunca de un
 *    `mqtt in`. Si lo cuelgas del flujo del ESP32, solo se ejecutará cuando
 *    llegue un mensaje MQTT real (y si el ESP32 está apagado, nunca).
 *
 * ────────────────────────────────────────────────────────────────────
 * POR QUÉ LOS VALORES NO SON `Math.random()` PURO
 * ────────────────────────────────────────────────────────────────────
 * Un `Math.random()` plano da ruido blanco: la gráfica sale como un serrucho
 * sin forma. Aquí se combinan tres componentes:
 *
 *   1. CICLO   → onda suave (simula el ciclo de uso del equipo).
 *   2. RUIDO   → pequeña variación aleatoria (ruido del propio sensor).
 *   3. DERIVA  → paseo aleatorio acotado que se autocorrige.
 *
 * ────────────────────────────────────────────────────────────────────
 * EL PERFIL ELÉCTRICO ES COHERENTE (importante)
 * ────────────────────────────────────────────────────────────────────
 * En una línea de corriente alterna las magnitudes NO son independientes:
 *
 *      P = V · I · cos(φ)        (potencia activa)
 *
 * Si se generan voltaje, corriente y potencia por separado, la gráfica
 * muestra combinaciones imposibles (p. ej. 230 V, 5 A y 300 W, cuando
 * deberían ser ~1150 W). Aquí se genera V e I, y **la potencia se CALCULA**
 * a partir de ellos con un factor de potencia realista.
 */

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * Perfil activo: "dht" | "electrico".
 * Cambia esta línea para simular otro sensor.
 */
const PERFIL = "electrico";

/** Perfiles de simulación. */
const PERFILES = {
  // ── Sensor ambiental DHT22 ────────────────────────────────
  dht: {
    dispositivo: "ESP32W",
    lecturasPorCiclo: 40,
    magnitudes: [
      {
        canal: "DHT1W-TEMPERATURA",
        tipo: "temperatura",
        base: 24, amplitud: 3, ruido: 0.25,
        min: 15, max: 35, decimales: 1,
      },
      {
        canal: "DHT1W-HUMEDAD_RELATIVA",
        tipo: "humedad",
        base: 55, amplitud: 8, ruido: 0.6,
        min: 20, max: 90, decimales: 1,
      },
    ],
  },

  // ── Analizador de red 230 V / 50 Hz ───────────────────────
  electrico: {
    dispositivo: "MEDIDOR-01",
    lecturasPorCiclo: 30,
    magnitudes: [
      {
        canal: "MEDIDOR-01-VOLTAJE",
        tipo: "voltaje",
        base: 230, amplitud: 4, ruido: 0.8,
        min: 195, max: 253, decimales: 1,
      },
      {
        canal: "MEDIDOR-01-CORRIENTE",
        tipo: "corriente",
        base: 4.5, amplitud: 2.5, ruido: 0.08,
        min: 0, max: 16, decimales: 2,
      },
      {
        canal: "MEDIDOR-01-FRECUENCIA",
        tipo: "frecuencia",
        base: 50, amplitud: 0.05, ruido: 0.02,
        min: 49.5, max: 50.5, decimales: 2,
      },
      {
        // La potencia NO es aleatoria: se calcula (ver más abajo).
        canal: "MEDIDOR-01-POTENCIA",
        tipo: "potencia",
        decimales: 1,
      },
    ],
  },
};

/** Factor de potencia (cos φ) de una instalación doméstica/industrial. */
const FACTOR_POTENCIA = 0.95;

// ─────────────────────────────────────────────────────────────
// ESTADO PERSISTENTE (sobrevive entre inyecciones)
// ─────────────────────────────────────────────────────────────
const config = PERFILES[PERFIL];

if (!config) {
  node.error(`[simulador] PERFIL desconocido: "${PERFIL}". Usa "dht" o "electrico".`);
  return null; // Detiene el flujo; el error aparece en la barra lateral.
}

// El estado se guarda por perfil para que cambiar de perfil no mezcle datos.
const claveEstado = `simulador_${PERFIL}`;
const ctx = context.get(claveEstado) || {
  t: 0,
  fase: Math.random() * Math.PI * 2,
  derivas: {},
};
ctx.t += 1;

/**
 * Genera el siguiente valor: ciclo + ruido + deriva acotada.
 * La deriva se guarda por magnitud para que cada una evolucione aparte.
 */
function siguienteValor(mag) {
  const ciclo =
    Math.sin((ctx.t / config.lecturasPorCiclo) * Math.PI * 2 + ctx.fase) *
    mag.amplitud;

  const ruido = (Math.random() - 0.5) * 2 * mag.ruido;

  let deriva = ctx.derivas[mag.tipo] ?? 0;
  deriva = (deriva + (Math.random() - 0.5) * mag.amplitud * 0.06) * 0.97;
  ctx.derivas[mag.tipo] = deriva;

  let valor = mag.base + ciclo + ruido + deriva;
  valor = Math.max(mag.min, Math.min(mag.max, valor));

  return Number(valor.toFixed(mag.decimales));
}

// ─────────────────────────────────────────────────────────────
// GENERACIÓN DE LAS MEDICIONES
// ─────────────────────────────────────────────────────────────
const valores = {};

for (const mag of config.magnitudes) {
  // La potencia no se simula: se calcula más abajo.
  if (mag.tipo === "potencia") continue;
  valores[mag.tipo] = siguienteValor(mag);
}

// COHERENCIA ELÉCTRICA: P = V · I · cos(φ)
if (PERFIL === "electrico") {
  const v = valores.voltaje;
  const i = valores.corriente;
  valores.potencia = Number((v * i * FACTOR_POTENCIA).toFixed(1));
}

context.set(claveEstado, ctx);

/** Construye la lista de mediciones en el formato que espera la API. */
const mediciones = config.magnitudes.map((mag) => ({
  canal: mag.canal,
  valor: valores[mag.tipo],
}));

// ─────────────────────────────────────────────────────────────
// PAYLOAD
// ─────────────────────────────────────────────────────────────
// IMPORTANTE: la clave `valor` debe estar SIEMPRE presente y ser numérica.
// Si se omite, la API devuelve "mediciones.N.valor: Invalid input".
msg.headers = {
  "X-API-Key":
    env.get("NODE_RED_API_KEY") || "flx_2-XJlrJozQt_71KbkbGp6ygfyUwf",
  "Content-Type": "application/json",
};

msg.payload = {
  dispositivo: config.dispositivo,
  mediciones,
  metadatos: {
    fuente: "simulador-node-red",
    perfil: PERFIL,
    timestamp: new Date().toISOString(),
  },
};

// ─────────────────────────────────────────────────────────────
// TRAZAS
// ─────────────────────────────────────────────────────────────
const resumen =
  PERFIL === "electrico"
    ? `${valores.voltaje} V · ${valores.corriente} A · ${valores.potencia} W · ${valores.frecuencia} Hz`
    : `${valores.temperatura} C · ${valores.humedad} %`;

node.status({ fill: "green", shape: "dot", text: resumen });
node.warn(`[simulador:${PERFIL}] ${config.dispositivo}: ${resumen}`);

return msg;
