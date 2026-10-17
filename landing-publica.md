# Landing pública

> La portada de la plataforma: qué cuenta y por qué esas cifras.

## El problema de la versión anterior

La landing describía un sistema **genérico** y, en dos puntos, prometía algo
que no existía:

| Texto anterior | Realidad |
|---|---|
| «Preparado para cámaras IP con streams HLS o WebRTC» | WebRTC **ya funcionaba**, con reproductor y pantalla completa |
| «Soporta OpenPLC, Modbus TCP y otros protocolos» | Modbus **de escritura** con direccionamiento, ya implementado |
| «Publica datos a ThingsBoard Cloud» | **Sin una línea de código**. Era una previsión |
| «Consulta el estado al instante» | WebSocket con **8 tipos de evento** |

El efecto era doble: **infravaloraba** lo construido y **prometía** lo que no
estaba.

## Las cifras de la portada

Las cuatro se **cuentan en el código**, no se estiman. Están en `metricas`
dentro de `src/app/page.tsx`:

| Cifra | Significado | De dónde sale |
|---|---|---|
| **16** | magnitudes monitorizables | filas de `tipos_variable` |
| **4** | protocolos de accionamiento | `PROTOCOLOS_ACTUADOR` |
| **8** | eventos en tiempo real | `TipoEventoTiempoReal` |
| **5** | escalas de agregación | `INTERVALOS_AGREGACION` |

### Cómo comprobarlas

```bash
# 16 magnitudes
psql "$DB" -c "SELECT count(*) FROM tipos_variable;"

# 4 protocolos
grep -oE "'(modbus|gpio|mqtt|http)'" \
  api/src/modules/actuadores/direccionamiento.ts | sort -u | wc -l

# 8 eventos
grep -oE "'(dispositivo|medicion|canal|alerta):[a-z]+'" \
  api/src/realtime/eventos.ts | sort -u | wc -l

# 5 escalas
grep -cE "^  '(minuto|hora|dia|semana|mes)'," \
  api/src/modules/measurement*/measurement.types.ts
```

> **Si se añade un protocolo o un evento nuevo, hay que actualizar la
> portada.** Una cifra inflada es lo primero que se cae en una defensa.

## Estructura de la página

| Sección | Contenido |
|---|---|
| **Hero** | Titular + métricas + tarjeta con la cadena de un dato |
| **Qué hace** | 9 funcionalidades **implementadas** |
| **Arquitectura** | 6 capas encadenadas, con el detalle de cada una |
| **Caso de estudio** | Monitorización hospitalaria y sus 4 requisitos normativos |
| **Tecnologías** | 16 tecnologías en uso |
| **Ámbitos** | Otros entornos donde encaja el mismo modelo |
| **Llamada final** | Registro |

## Dos decisiones de contenido

### La tarjeta lateral muestra la cadena real

En lugar de un adorno, explica el recorrido de un dato:

```
1. El sensor entrega 4–20 mA al PLC
2. El PLC expone el valor por Modbus
3. Node-RED lo traduce a la API
4. PostgreSQL confirma la escritura
5. El WebSocket avisa al navegador
```

Y cierra con la regla que define el sistema:

> El evento se emite **después** de confirmar el dato: nunca se muestra algo
> que no está guardado.

### El caso hospitalario cita las normas

No como adorno, sino porque **determinan qué sensores sirven**:

- **ASHRAE 170** — ventilación en instalaciones sanitarias
- **ISO 14644** — salas limpias y control de partículas
- **NAMUR NE 43** — umbrales de detección de fallo en lazos de corriente

Los cuatro requisitos que se listan derivan de ellas.

## Otros sitios corregidos

El mismo problema estaba en tres sitios más:

| Archivo | Corrección |
|---|---|
| `(publico)/tecnologias/page.tsx` | Quitado ThingsBoard; añadidos WebSocket, MediaMTX y WebRTC |
| `(panel)/integraciones/page.tsx` | Tareas pendientes reales, sin nombrar una plataforma concreta |
| `tipos/entidades.ts` y servicio | Comentarios sin referencia a ThingsBoard |

**Cero menciones a ThingsBoard en `src/`.**

## Verificación

| Prueba | Resultado |
|---|---|
| Las 4 cifras contra el código | **16 · 4 · 8 · 5** (coinciden) |
| Renderizado en el navegador | Titular, métricas, normas y tecnologías presentes |
| Menciones a ThingsBoard | **0** |
| Lenguaje de promesa («se prevé») | **0** |
| `tsc` · `lint` · `build` | Correcto |
