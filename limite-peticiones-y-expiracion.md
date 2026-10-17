# Límite de peticiones y expiración de comandos

> Dos problemas que aparecieron en uso real: el panel bloqueado por 429 y
> comandos que se ejecutaban horas después de pulsarlos.

## 1. El 429 del dashboard

### El síntoma

```
GET /api/v1/dashboard/resumen 429 0.223 ms
```

El panel dejaba de cargar datos sin explicación.

### La causa: el cupo lo consumía el propio panel

El límite era **100 peticiones cada 15 minutos por IP**. Y el dashboard,
solo por estar abierto, gastaba:

| Consulta | Cada | En 15 min |
|---|---|---|
| resumen | 90 s | 10 |
| magnitudes | 60 s | 15 |
| actividad | 60 s | 15 |
| actuadores | 30 s | 30 |
| **Total en reposo** | | **70** |

**70 de 100 sin tocar nada.** Al navegar, editar o abrir una segunda pestaña
se pasaba del límite.

### Solución: tres medidas

**a) Las lecturas autenticadas no cuentan**

```ts
skip: (req) => {
  if (req.path.startsWith(`${VERSION}/iot/`)) return true;

  const esLectura = req.method === 'GET' || req.method === 'HEAD';
  if (!esLectura) return false;

  const credenciales = req.cookies?.token ?? req.headers.authorization;
  return Boolean(credenciales);
}
```

Solo se excluyen **lecturas**, y solo **con credenciales**. Las escrituras y
el acceso anónimo siguen limitados: ahí es donde importa protegerse.

**b) El límite sube a 300**

Sigue habiendo un techo, pero para lo que de verdad puede abusar.

**c) El panel pregunta menos**

Todos los intervalos del dashboard pasan a 90 s: **70 → 40 peticiones** cada
15 minutos (−43 %).

> **La actualización normal sigue siendo instantánea**: el WebSocket invalida
> las claves en cuanto llega un evento. El intervalo solo cubre el caso en que
> el WebSocket no esté disponible.

### Verificación

| Prueba | Resultado |
|---|---|
| 150 lecturas **autenticadas** | **150 × 200** ✅ |
| 120 lecturas **anónimas** | bloqueadas con **429** ✅ |

---

## 2. Expiración de comandos

### El problema

Un comando queda `pendiente` hasta que Node-RED lo recoge. Si Node-RED está
caído, su API Key revocada o la red cortada, **se queda ahí para siempre**.

Y al volver, se encuentra la cola llena y ejecuta todo de golpe:

> «A las 09:15 pulsé el extractor. A las 11:40 se encendió solo.»

En un quirófano eso no es una orden ejecutada: es un incidente.

### La solución

Pasado el plazo, un trabajo periódico marca el comando como **`expirado`**:

```sql
UPDATE comandos_actuador
   SET estado = 'expirado',
       respuesta = ... 'motivo', 'expirado', 'detalle', ...
 WHERE estado = 'pendiente'
   AND creado_en < NOW() - ($1::int * INTERVAL '1 minute')
```

Como `listarPendientes` filtra por `estado = 'pendiente'`, **el comando
expirado deja de entregarse de inmediato**.

### Qué NO se expira

Solo los `pendiente`. Los **`enviado` no se tocan**: ya salieron hacia el
equipo y esperan confirmación. Expirarlos escondería una orden que quizá se
ejecutó de verdad.

### Configuración

```env
# Minutos antes de descartar un comando pendiente. 0 = desactivado.
COMANDO_EXPIRACION_MINUTOS=2

# Cada cuánto revisa el job. 0 = desactivado.
COMANDO_EXPIRACION_INTERVALO_SEG=30
```

**2 minutos** porque Node-RED consulta cada 2 segundos: un comando sano se
recoge en segundos. Si no lo hace en 2 minutos, algo se rompió.

### El aviso queda en el log

```
[comandos] 1 comando(s) expirado(s) sin recoger (más de 2 min pendientes).
Revise que Node-RED esté activo y su API Key sea válida.
```

Incluye el diagnóstico, no solo el hecho.

### Verificación

| Prueba | Resultado |
|---|---|
| Comando de 10 min | → `expirado` ✅ |
| Comando de 5 min | → `expirado` ✅ |
| Comando recién creado | sigue `pendiente` ✅ |
| Entrega a Node-RED tras expirar | **0 comandos** ✅ |
| Motivo guardado | `Nadie recogió el comando…` ✅ |
| Aviso en el log | ✅ |

---

## Un tropiezo durante la prueba

La primera vez el aviso **no apareció en el log** pese a que los comandos sí
expiraban. La causa: había **dos instancias de la API** corriendo y la que
respondía era otra, con su propio log.

> Merece la pena comprobarlo antes de dar por bueno un comportamiento raro:
> `ps -eo pid,args | grep server.ts`

## Archivos

| Archivo | Cambio |
|---|---|
| `api/src/app.ts` | Excluir lecturas autenticadas del límite |
| `api/src/config/env.ts` | Límite 300 + variables de expiración |
| `api/src/jobs/comando-expiracion.ts` | **Nuevo**: trabajo periódico |
| `api/src/modules/comandos-actuador/comando-actuador.types.ts` | Estado `expirado` |
| `...comando-actuador.repository.ts` | Método `expirarPendientes` |
| `...comando-actuador.service.ts` | Delegación con validación |
| `api/src/server.ts` | Arranque y parada del job |
| `frontend/src/components/dashboard/*` | Intervalos a 90 s |
