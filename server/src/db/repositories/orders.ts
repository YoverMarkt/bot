import type { SupabaseClient } from '@supabase/supabase-js'

type OrderData = Record<string, unknown>
type OrderItemData = Record<string, unknown>

const db = require('../client') as SupabaseClient

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
  },
)

const getOrders = async (businessId: string, limit = 100) => {
  const { data, error } = await db
    .from('orders')
    .select('*, order_items(*)')
    .eq('business_id', businessId)
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

export = {
  createOrder,
  getOrders,
  getLastOrderForContact,
  updateOrder,
  setOrderStatus,
}
