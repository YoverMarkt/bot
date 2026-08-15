import type { SupabaseClient } from '@supabase/supabase-js'

type OrderData = Record<string, unknown>
type OrderItemData = Record<string, unknown>

const db: SupabaseClient = require('../client') as typeof import('../client')

const createOrder = async (order: OrderData, items: OrderItemData[]) => db.rpc(
  'create_order_with_items',
  {
    p_business_id: order.business_id,
    p_contact_phone: order.contact_phone,
    p_contact_name: order.contact_name,
    p_status: order.status || 'pendiente',
    p_discount: order.discount || 0,
    p_currency: order.currency || 'USD',
    p_items: items,
    // 'manual' = mostrador. Un pedido que nace 'completado' genera su venta
    // dentro de la misma función, así que aquí no hay un segundo paso.
    p_source: order.source || 'whatsapp',
  },
)

// El filtro por estado lo usa la vigilancia del panel: pedir solo lo que
// espera al negocio evita traer 100 pedidos con sus ítems cada pocos segundos.
// La ruta valida los estados; aquí solo se aplican si vienen.
//
// ⚠️ Admite VARIOS a propósito. Con uno solo se quedó corto el 2026-08-08: la
// alarma vigilaba «pendiente» y, desde que quien transfiere nace en
// `esperando_pago`, ningún pedido con comprobante volvía a sonar. Lo que pide
// atención son dos estados distintos, no uno.
const getOrders = async (
  businessId: string,
  limit = 100,
  status: string | string[] | null = null,
) => {
  // La dirección sale de las columnas `delivery_*` del propio pedido, que las
  // trae el `*`. Antes se incrustaba `customer_addresses` por `address_id` y
  // eso no decía a dónde iba el pedido: decía a dónde va HOY esa dirección.
  let query = db
    .from('orders')
    .select('*, order_items(*, order_item_options(option_group_name,option_name,quantity,group_sort))')
    .eq('business_id', businessId)
  if (Array.isArray(status)) {
    if (status.length) query = query.in('status', status)
  } else if (status) {
    query = query.eq('status', status)
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data || []) as OrderData[]
}

/**
 * Las formas en que el MISMO teléfono aparece guardado.
 *
 * ⚠️ Un pedido hecho por la mini app guarda `593990978367` —su CHECK exige
 * solo dígitos— y el mismo cliente escribiendo por WhatsApp llega como
 * `+593990978367`. Buscar con `=` no encuentra nada, y no falla: devuelve
 * vacío, que es peor porque parece que ese cliente nunca pidió.
 *
 * Costó un rato descubrirlo el 2026-08-12: el comprobante que llegaba por el
 * chat no se adjuntaba a ningún pedido y el bot respondía con el enlace del
 * menú a quien acababa de pagar. No había ningún error que mirar.
 */
const variantesDelTelefono = (telefono: string): string[] => {
  const crudo = String(telefono || '').trim()
  const digitos = crudo.replace(/\D/g, '')
  if (!digitos) return crudo ? [crudo] : []
  return [...new Set([crudo, digitos, `+${digitos}`])]
}

// Último pedido de UN contacto dentro de SU negocio. Alimenta "repetir pedido"
// y el comprobante que llega por el chat: se leen los ítems para rearmar el
// carrito, pero los precios NO se reutilizan (se recalculan con el catálogo
// vigente en bot-menu-flow).
const getLastOrderForContact = async (businessId: string, contactPhone: string) => {
  const { data, error } = await db
    .from('orders')
    .select('*, order_items(*)')
    .eq('business_id', businessId)
    // Con `in` en vez de `eq`: el mismo número vive con y sin el `+` según por
    // dónde entró el pedido.
    .in('contact_phone', variantesDelTelefono(contactPhone))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data || null) as OrderData | null
}

const updateOrder = async (
  businessId: string,
  id: string,
  data: OrderData,
) => {
  const safe = { ...data }
  delete safe.id
  delete safe.business_id
  delete safe.created_at
  return db
    .from('orders')
    .update({ ...safe, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
}

/**
 * Devuelve el pedido a «esperando pago» y BORRA el comprobante anterior.
 *
 * Las dos cosas van juntas: sin borrarlo, el buzón de WhatsApp rechazaría la
 * foto siguiente —solo adjunta cuando no hay una ya puesta— y el dueño se
 * quedaría mirando la borrosa para siempre.
 */
const requestNewPaymentProof = async (businessId: string, orderId: string) => {
  const { data, error } = await db.rpc('request_new_payment_proof', {
    p_business_id: businessId,
    p_order_id: orderId,
  })
  return { data, error }
}

const setOrderStatus = async (businessId: string, id: string, status: string) => db.rpc(
  'set_order_status',
  {
    p_business_id: businessId,
    p_order_id: id,
    p_status: status,
  },
)

/**
 * Reclama el derecho a avisarle al cliente DE ESTE HITO, y devuelve el pedido
 * si lo gana.
 *
 * ⚠️ RECLAMA, no consulta. El `where` va dentro del propio `update`, que es
 * atómico: si dos peticiones llegan a la vez, una sola se lleva la fila y la
 * otra recibe `null`. Comprobar primero y enviar después dejaría una carrera
 * entre las dos operaciones — las dos leerían lo mismo y las dos mandarían el
 * mensaje.
 *
 * Hace falta porque `set_order_status` devuelve `updated` también cuando el
 * estado ya era ese, así que desde fuera un segundo toque en un botón es
 * indistinguible del primero. Y desde el 1 de octubre de 2026 Meta cobra cada
 * mensaje de servicio: el doble toque se paga dos veces.
 *
 * ⚠️ Se compara con el ÚLTIMO estado avisado, no con una lista de todos. Vale
 * porque el pedido nunca retrocede —`set_order_status` lo prohíbe—, así que
 * los hitos llegan siempre en fila y cada uno es distinto del anterior.
 *
 * El `or` cubre el nulo a mano: `neq` en PostgreSQL descarta las filas nulas,
 * así que un pedido del que no se ha avisado nada no pasaría el filtro y
 * jamás recibiría su primer mensaje.
 */
const claimOrderNotification = async (
  businessId: string,
  orderId: string,
  status: string,
) => {
  const { data, error } = await db
    .from('orders')
    .update({
      customer_notified_status: status,
      customer_notified_at: new Date().toISOString(),
    })
    .eq('business_id', businessId)
    .eq('id', orderId)
    .or(`customer_notified_status.is.null,customer_notified_status.neq.${status}`)
    // Las opciones viajan con cada línea: el aviso de preparación cuenta lo
    // que el cliente eligió, y sin ellas decía «1× Pizza» y punto.
    .select(
      'id,order_number,status,fulfillment,contact_phone,contact_name,total,currency,'
      + 'order_items(*, order_item_options(option_group_name,option_name,quantity,group_sort))',
    )
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data || null) as OrderData | null
}

/**
 * Marca que el negocio dio el pago por bueno.
 *
 * Existe para el pago que llegó POR FUERA de la app: la mayoría transfiere
 * desde su banco y manda la captura por WhatsApp, a veces desde la cuenta de
 * otra persona. Ese pago es tan válido como el que se sube aquí, pero antes no
 * había dónde anotarlo — el cliente seguía viendo el número de cuenta y el
 * dueño, «sin comprobante todavía».
 *
 * ⚠️ Las condiciones van en el `where`, no en un `if` de la ruta. Es una sola
 * operación atómica y no hay forma de colarse por otro camino:
 *
 *  · **el negocio**, siempre, o se estaría marcando el pedido de otro local;
 *  · **transferencia**, porque en efectivo y «pago al retirar» se cobra al
 *    entregar: marcarlo antes diría que hay un dinero que nadie ha recibido;
 *  · **estado no final** — dar por pagado un pedido cancelado o expirado no
 *    significa nada, y en el reporte parecería dinero cobrado;
 *  · **`payment_confirmed_at is null`**, para que dos toques seguidos no
 *    muevan la hora y el cliente vea saltar el momento en que le confirmaron.
 *
 * Devuelve el pedido si lo marcó, y `null` si no cumplía. Quien llama
 * distingue los dos casos, que no son el mismo error.
 */
const confirmOrderPayment = async (businessId: string, orderId: string) => {
  const { data, error } = await db
    .from('orders')
    .update({ payment_confirmed_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', orderId)
    .eq('payment_method', 'transferencia')
    .is('payment_confirmed_at', null)
    .not('status', 'in', '("completado","cancelado","rechazado","expirado")')
    .select('id,status,payment_confirmed_at')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data || null) as { id: string; status: string; payment_confirmed_at: string } | null
}

/**
 * Lo justo para abrir un comprobante: su URL y su identificador de Cloudinary.
 *
 * Se pide por negocio Y por pedido, nunca solo por pedido: el id viaja en la
 * dirección y sin el negocio se estaría dando el comprobante de otro local.
 */
const getOrderProof = async (businessId: string, orderId: string) => {
  const { data } = await db
    .from('orders')
    .select('payment_proof_url,payment_proof_public_id')
    .eq('business_id', businessId)
    .eq('id', orderId)
    .maybeSingle()
  return (data || null) as unknown as {
    payment_proof_url?: string | null
    payment_proof_public_id?: string | null
  } | null
}

export = {
  getOrderProof,
  createOrder,
  getOrders,
  getLastOrderForContact,
  variantesDelTelefono,
  updateOrder,
  setOrderStatus,
  requestNewPaymentProof,
  confirmOrderPayment,
  claimOrderNotification,
}
