// ── ¿SIGUE VIVO ESTE PEDIDO? ───────────────────────────────────────────────
//
// La pantalla de «pedido recibido» es estática a propósito: no consulta nada
// porque no promete nada que pueda cambiar. Esa premisa aguanta para todo…
// menos para una cosa. Si el dueño cancela, el «¡Gracias!» pasa a ser mentira,
// y el cliente se queda mirando una pantalla que le dice que todo va bien
// mientras su comida no se está haciendo.
//
// Por eso esa pantalla pregunta UNA sola cosa —«¿sigue vivo?»— y solo mientras
// está abierta. No es la pantalla de seguimiento que se retiró el 2026-08-12:
// aquella preguntaba «¿por dónde va?» durante toda la vida del pedido.

/**
 * Los finales de los que no se vuelve.
 *
 * `expirado` está aunque hoy no lo escriba nadie —no hay tarea que expire
 * pedidos—: si algún día existe, esta pantalla ya sabrá leerlo. Aquí no cuesta
 * nada tenerlo, al revés que en la lista de avisos, donde cada estado es un
 * mensaje que se paga.
 */
const CANCELADOS = new Set(['cancelado', 'rechazado', 'expirado'])

/** ¿El pedido murió? `completado` NO cuenta: ese llegó, y bien. */
export const estaCancelado = (status?: string | null): boolean =>
  CANCELADOS.has(String(status || '').trim().toLowerCase())

/**
 * ¿Hay algo más que esperar de este pedido?
 *
 * Con el pedido en un estado final se deja de preguntar: seguir consultando
 * cada 30 segundos por algo que ya no puede cambiar es gastar los datos del
 * cliente para nada.
 */
export const esEstadoFinal = (status?: string | null): boolean =>
  estaCancelado(status) || String(status || '').trim().toLowerCase() === 'completado'
