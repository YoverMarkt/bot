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
  // La dirección viaja incrustada: sin ella la bandeja de Pedidos no puede
  // decirle al repartidor a dónde va, que es medio trabajo del pedido.
  let query = db
    .from('orders')
    .select('*, order_items(*), customer_addresses:address_id (label, address, reference)')
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

// Último pedido de UN contacto dentro de SU negocio. Alimenta "repetir pedido":
// se leen los ítems para rearmar el carrito, pero los precios NO se reutilizan
// (se recalculan con el catálogo vigente en bot-menu-flow).
const getLastOrderForContact = async (businessId: string, contactPhone: string) => {
  const { data, error } = await db
    .from('orders')
    .select('*, order_items(*)')
    .eq('business_id', businessId)
    .eq('contact_phone', contactPhone)
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

const setOrderStatus = async (businessId: string, id: string, status: string) => db.rpc(
  'set_order_status',
  {
    p_business_id: businessId,
    p_order_id: id,
    p_status: status,
  },
)

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
  updateOrder,
  setOrderStatus,
}
