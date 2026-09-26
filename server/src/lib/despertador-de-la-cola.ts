// ═══════════════════════════════════════════════════════════════════════════
// DESPERTAR A LA COLA CUANDO ENTRA UN MENSAJE
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta el 2026-09-25 el trabajador de la cola se enteraba de un mensaje nuevo
// SONDEANDO: miraba la base cada 1000 ms, pasara lo que pasara. Con la ventana
// de agrupado ya en 300 ms, ese sondeo era el suelo de todo el chat — y además
// se pagaba entre mensaje y mensaje: una ráfaga de 12 toques de un cliente
// esperó 50 s el último, porque cada toque pagaba su segundo de sondeo.
//
// Lo instantáneo «de verdad» sería LISTEN/NOTIFY, y la migración de los 300 ms
// lo descartó por ser un cambio de arquitectura. Pero no hace falta: el
// webhook y el trabajador viven en el MISMO proceso. Quien recibe el mensaje
// puede despertar al que lo procesa sin pasar por la base.
//
// ⚠️ Es un ATAJO, no el camino. Si nadie escucha (el freno de tareas de fondo
// en local, o una segunda réplica que recibe el webhook de otra), el sondeo de
// siempre sigue recogiendo el mensaje. Por eso despertar nunca lanza.

import type { InboundWebhookPayload } from '../services/inbound-webhook'

/**
 * La ventana de agrupado de `enqueue_webhook_event`, en milisegundos.
 *
 * ⚠️ Es una COPIA del `interval '300 milliseconds'` del SQL. Si se despierta
 * antes de que venza, la reserva no ve el mensaje y el texto vuelve a esperar
 * el segundo del sondeo — justo lo que esto quita. La vigila
 * `despertador-de-la-cola.test.js` leyendo `schema.sql`.
 */
export const VENTANA_DE_AGRUPADO_MS = 300

/** Lo que tarda la ida y vuelta a la base no se puede dar por hecho. */
const MARGEN_MS = 50

type Despertador = (esperaMilisegundos: number) => void

let despertador: Despertador | null = null

/** El trabajador se apunta al arrancar. `null` lo borra. */
export function alEntrarUnMensaje(escuchar: Despertador | null): void {
  despertador = escuchar
}

/**
 * Cuánto hay que esperar para que la reserva vea el mensaje.
 *
 * ⚠️ Replica el `v_es_texto_libre` del SQL: lo ELEGIDO (botón o fila) entra
 * disponible al instante; lo ESCRITO espera la ventana por si llega a trozos.
 */
export function esperaAntesDeProcesar(
  payload: Pick<InboundWebhookPayload, 'content'>,
): number {
  const contenido = payload.content
  const esTextoLibre = contenido?.kind === 'text'
    && typeof contenido.text === 'string'
    && contenido.interactivo !== true
  return esTextoLibre ? VENTANA_DE_AGRUPADO_MS + MARGEN_MS : 0
}

/** Lo llama el webhook en cuanto el mensaje queda guardado en la cola. */
export function avisarQueEntroUnMensaje(
  payload: Pick<InboundWebhookPayload, 'content'>,
): void {
  try {
    despertador?.(esperaAntesDeProcesar(payload))
  } catch {
    // Despertar es un atajo: si falla, el sondeo de siempre recoge el mensaje.
  }
}
