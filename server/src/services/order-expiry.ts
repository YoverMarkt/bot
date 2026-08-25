/**
 * El pedido sin pagar caduca solo.
 *
 * 20 de las 40 cancelaciones de producción murieron en `esperando_pago`: gente
 * que pidió y nunca mandó su comprobante. El dueño los cancelaba A MANO uno a
 * uno mientras el cliente se quedaba mirando una pantalla de pago que ya no
 * llevaba a ninguna parte. `expirado` existía en las restricciones desde el
 * 2026-08-05 y nadie lo escribía nunca.
 *
 * ⚠️ Es la primera tarea de la plataforma que cambia el estado de un pedido
 * sola, y eso estaba prohibido a propósito hasta el 2026-08-28 («no hay tarea
 * que expire pedidos por su cuenta», `order-notify.ts`). La cautela era el
 * dinero: cada aviso se paga y una tarea automática puede mandar cien de
 * golpe. Los frenos que sustituyen a la prohibición:
 *
 *   · `LIMITE_POR_TANDA` — nunca más de 20 por pasada.
 *   · La ventana superior de 24 h, dentro de la propia función SQL: lo más
 *     viejo NO se toca, así que encenderlo no barre el histórico.
 *   · `payment_window_minutes = 0` lo apaga para ese negocio.
 *   · Y el aviso SUSTITUYE al de la cancelación manual, no se añade a él.
 *
 * ⚠️ Nunca lanza: corre en un `setInterval` y una excepción aquí dejaría el
 * proceso con un rechazo sin capturar. Lo que falle va al registro de errores.
 */
const db = require('../db') as typeof import('../db')
// ⚠️ Se accede por PROPIEDAD (`notice.avisarAlCliente`) y no desestructurando:
// desestructurar congela la referencia al cargar el módulo, y entonces el
// camino que de verdad importa —el que avisa— no se puede ejercer en una
// prueba. Es el mismo patrón que ya usa `order-notify.ts`.
const notice = require('./order-status-notice') as typeof import('./order-status-notice')
const errores = require('./error-log') as typeof import('./error-log')

/**
 * Cuántos por pasada. Con un intervalo de 10 minutos son 120 por hora como
 * mucho, que es de sobra para cualquier volumen real y sigue siendo un techo
 * duro frente al escenario de los cien avisos de golpe.
 */
const LIMITE_POR_TANDA = 20

export const expireUnpaidOrders = async (): Promise<number> => {
  try {
    const expirados = await db.expireUnpaidOrders(LIMITE_POR_TANDA)
    if (!expirados.length) return 0

    console.log(`⌛ [expiración] ${expirados.length} pedido(s) sin comprobante`)

    // El aviso va uno a uno y NUNCA en paralelo: cada uno reclama su turno de
    // forma atómica y sale por el canal del negocio, así que dispararlos a la
    // vez solo amontonaría peticiones al proveedor sin ganar nada.
    for (const pedido of expirados) {
      await notice.avisarAlCliente(pedido.business_id, pedido.order_id, 'expirado')
    }
    return expirados.length
  } catch (error) {
    // Falla en silencio hacia el registro: que un barrido no corra deja las
    // cosas como estaban ayer, y tumbar el proceso las deja peor.
    await errores.recordError({
      category: 'servidor',
      code: 'expiracion_pedidos',
      message: error instanceof Error ? error.message : 'Error desconocido',
    }).catch(() => { /* el registro no puede ser el que rompa */ })
    return 0
  }
}
