// ── LOS AVISOS AL CLIENTE MIENTRAS SU PEDIDO AVANZA ────────────────────────
//
// El cliente que pide por la mini app no se entera de nada si cerró el
// navegador —y lo normal es cerrarlo—. Se le avisa en los TRES momentos en que
// mira el teléfono:
//
//   · entra en preparación → su pago valió y le van a hacer la comida;
//   · sale a la calle, o queda listo para retirar → cuándo esperarlo o cuándo
//     salir a buscarlo;
//   · entregado → se cierra, y de paso se le agradece.
//
// ⚠️ SON TRES MENSAJES POR PEDIDO, y desde el 1 de octubre de 2026 Meta cobra
// cada mensaje de servicio (los de texto libre dentro de la ventana de 24 h,
// gratis desde finales de 2024). Se empezó con uno solo por ese costo; el
// dueño decidió los tres el 2026-08-08 sabiendo lo que valen. Añadir un CUARTO
// hito no es gratis: multiplica el gasto de cada pedido del SaaS entero.
//
// ⚠️ LA VENTANA DE 24 HORAS NO DESAPARECE en octubre; lo que cambia es que
// deja de ser gratis. Fuera de ella sigue haciendo falta una PLANTILLA
// aprobada por Meta, y nuestra integración de YCloud hoy solo manda texto.
// En la práctica casi todo cae dentro: el cliente le escribe al bot, recibe el
// enlace, pide, y el pedido se entrega el mismo día. Lo que queda fuera es el
// pedido que se cierra al día siguiente — y por eso un envío fallido se
// REGISTRA en vez de perderse: si el dueño cree que su cliente fue avisado y
// no lo fue, es peor que no haber avisado nunca.
//
// El día que se enganchen las plantillas, el cambio es aquí y en ningún otro
// sitio: el resto del sistema solo llama a `notificarCambioDePedido`.
import type { BusinessRecord } from '../db/types'
import { detalleEnTexto } from './order-detail'
import type { OpcionDelPedido } from './order-detail'

/** Lo justo para redactar el aviso. Nada de esto se recalcula: viene de la base. */
export interface PedidoParaAvisar {
  order_number?: number | null
  contact_phone?: string | null
  contact_name?: string | null
  total?: number | string | null
  currency?: string | null
  /** Decide si «salió» o «está listo para que pases»: no es lo mismo. */
  fulfillment?: string | null
  order_items?: {
    product_name?: string | null
    variant_name?: string | null
    quantity?: number | null
    /** Lo que eligió, agrupado por `order-detail.ts`. Sin esto el mensaje
     *  decía «1× Pizza (Personal)» y el cliente no podía comprobar nada. */
    order_item_options?: OpcionDelPedido[] | null
    /** El respaldo de los pedidos anteriores al motor de opciones. */
    extras_names?: string[] | null
  }[] | null
}

/**
 * Los hitos que se le cuentan al cliente.
 *
 * ⚠️ Esta lista es la que decide CUÁNTO cuesta cada pedido en mensajes. Los
 * demás estados existen y no se avisan a propósito: `aceptado` y `confirmado`
 * no le dicen nada al cliente que no diga «en preparación», y `esperando_pago`
 * o `pago_en_revision` son cosas que él mismo acaba de hacer.
 */
export const HITOS_QUE_SE_AVISAN = [
  'preparacion',
  'en_camino',
  'listo_para_retiro',
  'completado',
  // ⚠️ Los dos finales que dejan al cliente esperando algo que NO va a llegar,
  // añadidos el 2026-08-13 por decisión del dueño. En los otros cuatro el
  // cliente espera algo que viene; aquí espera de balde hasta que se cansa —
  // y ese es el que no vuelve a pedir.
  //
  // No multiplican el gasto como los demás: un pedido cancelado no recibe
  // ninguno de los otros, así que es UN mensaje en vez de tres. Y no puede
  // dispararse solo: `cancelado` y `rechazado` únicamente se escriben desde
  // `PUT /api/client/orders/:id/status`, que exige sesión de cliente y permiso
  // de ventas. No hay tarea que expire pedidos por su cuenta.
  'cancelado',
  'rechazado',
] as const

export type HitoAvisado = typeof HITOS_QUE_SE_AVISAN[number]

export const seAvisa = (status: string): status is HitoAvisado =>
  (HITOS_QUE_SE_AVISAN as readonly string[]).includes(status)

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
 * La despedida del pedido entregado.
 *
 * Vive aquí y en la mini app (`screens/OrderTracking.tsx`) porque el cliente
 * llega por los dos caminos y tiene que leer lo mismo. Es texto de marca: si
 * algún día lo cambia el dueño, se cambia en los dos sitios o el pedido dice
 * una cosa por WhatsApp y otra en pantalla.
 */
export const GRACIAS_POR_PREFERIRNOS = 'Gracias por preferirnos 🙌'
export const PRONTO_EN_UMBANI = 'Pronto también estaremos en la app de Umbani.'

/**
 * El detalle de lo que se pidió, que solo hace falta en el primer aviso.
 *
 * Va COMPLETO a propósito. Meta cobra por mensaje, no por carácter: alargar el
 * texto con lo que el cliente eligió no cuesta un centavo más, y es justo el
 * momento en que él comprueba que le entendieron bien y aún se puede corregir.
 *
 * Antes esto decía «1× Pizza (Personal)» y se acababa ahí — ni siquiera leía
 * `extras_names`, que ya venía en la consulta.
 */
const lineasDelPedido = (pedido: PedidoParaAvisar): string[] => {
  const items = (pedido.order_items || []).filter(item => item?.product_name)
  if (!items.length) return []
  return items.flatMap((item) => {
    const cantidad = Number(item.quantity) || 1
    // La variante va pegada al nombre porque «Pizza» y «Pizza Familiar» son
    // cosas distintas, y el cliente comprueba aquí que le entendieron bien.
    const variante = item.variant_name ? ` (${item.variant_name})` : ''
    return [
      `• ${cantidad}× ${item.product_name}${variante}`,
      // Sangradas bajo su producto: en un pedido de tres platos, sin sangría no
      // se sabe de cuál es cada cosa.
      ...detalleEnTexto(item).map(linea => `   ${linea}`),
    ]
  })
}

/**
 * El texto de cada aviso.
 *
 * Se exporta aparte para poder probarlo sin tocar ningún canal, y porque es lo
 * único que cambiará el día que esto sean plantillas de Meta.
 *
 * ⚠️ Ningún importe se calcula aquí (regla inviolable #8): el total llega tal
 * como lo dejó PostgreSQL y solo se le da formato.
 *
 * Devuelve `null` si el estado no es de los que se avisan, en vez de un texto
 * vacío: así quien llama no manda un WhatsApp en blanco.
 */
export const textoDelAviso = (
  // El teléfono hace falta para el aviso de cancelación: ahí lo único útil que
  // se le puede ofrecer al cliente es a quién llamar.
  negocio: Pick<BusinessRecord, 'name' | 'phone'>,
  pedido: PedidoParaAvisar,
  status: string,
): string | null => {
  const numero = pedido.order_number ? ` #${pedido.order_number}` : ''
  const lineas: string[] = []

  if (status === 'preparacion') {
    lineas.push(`✅ *Tu pedido${numero} está confirmado*`)
    lineas.push('')
    lineas.push(`${negocio.name} ya lo está preparando.`)

    // El detalle va SOLO aquí. Repetirlo en cada aviso alargaría tres mensajes
    // para decir lo mismo, y este es el momento en que sirve: es cuando el
    // cliente comprueba que le entendieron bien y aún se puede corregir.
    const items = lineasDelPedido(pedido)
    if (items.length) lineas.push('', ...items)

    const total = Number(pedido.total)
    if (Number.isFinite(total) && total > 0) {
      lineas.push('')
      lineas.push(`*Total: $${total.toFixed(2)}*`)
    }
    return lineas.join('\n')
  }

  if (status === 'en_camino') {
    lineas.push(`🛵 *Tu pedido${numero} va en camino*`)
    lineas.push('')
    lineas.push('Ya salió para tu dirección. Atento al timbre 🙂')
    return lineas.join('\n')
  }

  // Quien retira NO pasa por «en camino»: pasa por aquí. Y a este le importa
  // más todavía, porque tiene que salir de casa a buscarlo.
  if (status === 'listo_para_retiro') {
    lineas.push(`🛍️ *Tu pedido${numero} está listo*`)
    lineas.push('')
    lineas.push(`Ya puedes pasar a retirarlo por ${negocio.name}.`)
    return lineas.join('\n')
  }

  // ⚠️ Cancelado y rechazado se cuentan IGUAL al cliente, y es deliberado.
  // Para él son la misma noticia —su pedido no va a llegar— y la diferencia
  // entre «lo cancelé» y «no lo acepté» es de gestión interna. Contársela solo
  // le haría preguntarse qué hizo mal.
  if (status === 'cancelado' || status === 'rechazado') {
    lineas.push(`❌ *Tu pedido${numero} fue cancelado*`)
    lineas.push('')
    lineas.push(`${negocio.name} no pudo continuar con este pedido.`)
    // No se inventa un motivo: no hay ningún campo donde el dueño lo escriba,
    // y un motivo falso es peor que ninguno. Lo que sí se puede dar es a quién
    // preguntarle, que es exactamente lo que el cliente quiere en ese momento.
    const telefono = String(negocio.phone || '').trim()
    lineas.push('')
    lineas.push(telefono
      ? `Si quieres saber qué pasó o volver a pedir, llámalos al ${telefono}.`
      : 'Si quieres saber qué pasó o volver a pedir, escríbeles por aquí.')
    return lineas.join('\n')
  }

  if (status === 'completado') {
    lineas.push(`✅ *Pedido${numero} entregado*`)
    lineas.push('')
    lineas.push(GRACIAS_POR_PREFERIRNOS)
    lineas.push(PRONTO_EN_UMBANI)
    return lineas.join('\n')
  }

  return null
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
  async function notificarCambioDePedido(
    negocio: BusinessRecord,
    pedido: PedidoParaAvisar,
    status: string,
  ): Promise<boolean> {
    const telefono = String(pedido.contact_phone || '').trim()
    if (!esDestinatarioValido(telefono)) return false

    const texto = textoDelAviso(negocio, pedido, status)
    // Un estado que no se avisa no manda un mensaje vacío: no manda nada.
    if (!texto) return false

    try {
      await dependencias.enviar(negocio, telefono, texto)
      return true
    } catch (error) {
      await dependencias.registrarError({
        businessId: negocio.id,
        category: 'envio',
        message: error,
        context: {
          motivo: `aviso de pedido: ${status}`,
          pedido: pedido.order_number ?? null,
        },
      }).catch(() => { /* registrar el fallo no puede provocar otro */ })
      return false
    }
  }

// Carga diferida, como el resto de servicios que hablan con los canales: evita
// ciclos durante el arranque del bot.
export const notificarCambioDePedido = crearNotificadorDePedidos({
  enviar(negocio, telefono, mensaje) {
    const notify = require('./notify') as typeof import('./notify')
    return notify.sendToContact(negocio, telefono, mensaje)
  },
  registrarError(input) {
    const log = require('./error-log') as typeof import('./error-log')
    return log.recordError(input)
  },
})
