// ── EL AVISO AL CLIENTE CUANDO SU PEDIDO ARRANCA ───────────────────────────
//
// El cliente que pide por la mini app se queda sin saber nada hasta que abre
// la pantalla de seguimiento. Si cerró el navegador —y lo normal es cerrarlo—
// no se entera de que su pedido fue aceptado. Este es el ÚNICO mensaje
// saliente del pedido, y es a propósito:
//
// ⚠️ Desde el 1 de octubre de 2026 Meta cobra cada mensaje de servicio (los de
// texto libre dentro de la ventana de 24 h, gratis desde finales de 2024).
// Avisar en cada estado —«en camino», «entregado»— multiplicaría por tres el
// costo de cada pedido para decir cosas que el cliente ya ve en la pantalla de
// seguimiento. El único que vale su precio es este, porque cierra la duda que
// de verdad angustia: «¿le llegó mi pago, me van a preparar el pedido?».
//
// ⚠️ LA VENTANA DE 24 HORAS NO DESAPARECE en octubre; lo que cambia es que
// deja de ser gratis. Fuera de ella sigue haciendo falta una PLANTILLA
// aprobada por Meta, y nuestra integración de YCloud hoy solo manda texto.
// En la práctica casi todo cae dentro: el cliente le escribe al bot, recibe el
// enlace, pide, y el dueño acepta en minutos. Lo que queda fuera es el pedido
// aceptado al día siguiente — y por eso un envío fallido se REGISTRA en vez de
// perderse: si el dueño cree que su cliente fue avisado y no lo fue, es peor
// que no haber avisado nunca.
//
// El día que se enganchen las plantillas, el cambio es aquí y en ningún otro
// sitio: el resto del sistema solo llama a `notificarPedidoEnPreparacion`.
import type { BusinessRecord } from '../db/types'

/** Lo justo para redactar el aviso. Nada de esto se recalcula: viene de la base. */
export interface PedidoParaAvisar {
  order_number?: number | null
  contact_phone?: string | null
  contact_name?: string | null
  total?: number | string | null
  currency?: string | null
  order_items?: {
    product_name?: string | null
    variant_name?: string | null
    quantity?: number | null
  }[] | null
}

/**
 * Los teléfonos que NO son de un cliente al que se pueda escribir.
 *
 * `mostrador` es el literal que usa el pedido en persona: quien compra en el
 * local está delante del dueño, y mandarle un WhatsApp a un número inventado
 * gastaría dinero por un mensaje que no llega a ninguna parte.
 */
const SIN_DESTINATARIO = new Set(['', 'mostrador'])

const esDestinatarioValido = (telefono: string): boolean => {
  if (SIN_DESTINATARIO.has(telefono)) return false
  // Telegram viaja como `tg_<chatId>` y lo entrega el mismo notificador.
  if (telefono.startsWith('tg_')) return telefono.length > 3
  return telefono.replace(/\D/g, '').length >= 8
}

/**
 * El texto del aviso.
 *
 * Se exporta aparte para poder probarlo sin tocar ningún canal, y porque es lo
 * único que cambiará el día que esto sea una plantilla de Meta.
 *
 * ⚠️ Ningún importe se calcula aquí (regla inviolable #8): el total llega tal
 * como lo dejó PostgreSQL y solo se le da formato.
 */
export const textoPedidoEnPreparacion = (
  negocio: Pick<BusinessRecord, 'name'>,
  pedido: PedidoParaAvisar,
): string => {
  const lineas: string[] = []
  const numero = pedido.order_number ? ` #${pedido.order_number}` : ''

  lineas.push(`✅ *Tu pedido${numero} está confirmado*`)
  lineas.push('')
  lineas.push(`${negocio.name} ya lo está preparando.`)

  const items = (pedido.order_items || []).filter(item => item?.product_name)
  if (items.length) {
    lineas.push('')
    for (const item of items) {
      const cantidad = Number(item.quantity) || 1
      // La variante va pegada al nombre porque «Pizza» y «Pizza Familiar» son
      // cosas distintas, y el cliente comprueba aquí que le entendieron bien.
      const variante = item.variant_name ? ` (${item.variant_name})` : ''
      lineas.push(`• ${cantidad}× ${item.product_name}${variante}`)
    }
  }

  const total = Number(pedido.total)
  if (Number.isFinite(total) && total > 0) {
    lineas.push('')
    lineas.push(`*Total: $${total.toFixed(2)}*`)
  }

  return lineas.join('\n')
}

export interface NotificarDependencias {
  enviar(negocio: BusinessRecord, telefono: string, mensaje: string): Promise<unknown>
  registrarError(input: {
    businessId?: string | null
    category: 'envio'
    message: unknown
    context?: Record<string, unknown>
  }): Promise<void>
}

/**
 * Avisa al cliente de que su pedido entró en preparación.
 *
 * **Nunca lanza.** El pedido ya avanzó cuando esto corre: si el aviso falla
 * —fuera de la ventana de 24 h, sin saldo, canal caído— la cocina tiene su
 * comanda igual, y devolverle un error al dueño le haría creer que el pedido
 * no arrancó. El fallo va al registro de errores, que es donde el dueño puede
 * verlo y decidir si le escribe a mano.
 *
 * Devuelve si se envió, para que quien llame pueda decirlo si algún día hace
 * falta. Hoy nadie lo mira.
 */
export const crearNotificadorDePedidos = (dependencias: NotificarDependencias) =>
  async function notificarPedidoEnPreparacion(
    negocio: BusinessRecord,
    pedido: PedidoParaAvisar,
  ): Promise<boolean> {
    const telefono = String(pedido.contact_phone || '').trim()
    if (!esDestinatarioValido(telefono)) return false

    try {
      await dependencias.enviar(negocio, telefono, textoPedidoEnPreparacion(negocio, pedido))
      return true
    } catch (error) {
      await dependencias.registrarError({
        businessId: negocio.id,
        category: 'envio',
        message: error,
        context: {
          motivo: 'aviso de pedido en preparación',
          pedido: pedido.order_number ?? null,
        },
      }).catch(() => { /* registrar el fallo no puede provocar otro */ })
      return false
    }
  }

// Carga diferida, como el resto de servicios que hablan con los canales: evita
// ciclos durante el arranque del bot.
export const notificarPedidoEnPreparacion = crearNotificadorDePedidos({
  enviar(negocio, telefono, mensaje) {
    const notify = require('./notify') as typeof import('./notify')
    return notify.sendToContact(negocio, telefono, mensaje)
  },
  registrarError(input) {
    const log = require('./error-log') as typeof import('./error-log')
    return log.recordError(input)
  },
})
