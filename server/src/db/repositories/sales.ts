import type { SupabaseClient } from '@supabase/supabase-js'

// `SaleData` y `SaleItemData` vivían aquí para el alta manual de ventas, que
// se retiró el 2026-08-02: hoy toda venta nace de un pedido, una cita o una
// estadía, y las crea PostgreSQL.

const db: SupabaseClient = require('../client') as typeof import('../client')
const getSaleById = async (businessId: string, id: string) => {
  const { data } = await db.from('sales').select('*, sale_items(*)')
    .eq('business_id', businessId).eq('id', id).single()
  return data
}

const getSalesByContact = async (businessId: string, phone: string) => {
  const { data } = await db.from('sales').select('*, sale_items(*)')
    .eq('business_id', businessId).eq('contact_phone', phone)
    .order('sold_at', { ascending: false }).limit(10)
  return data || []
}

const getSaleCustomers = async (businessId: string) => {
  const { data, error } = await db.from('sales').select('contact_phone, sold_at')
    .eq('business_id', businessId).eq('status', 'completada')
  if (error) throw new Error(error.message)
  return data || []
}

const getCustomerSales = async (businessId: string) => {
  const { data, error } = await db.from('sales')
    .select('contact_phone, contact_name, total, sold_at')
    .eq('business_id', businessId).eq('status', 'completada')
  if (error) throw new Error(error.message)
  return data || []
}

const voidSale = async (businessId: string, id: string) => db.from('sales')
  .update({ status: 'anulada' })
  .eq('business_id', businessId).eq('id', id).eq('status', 'completada')

const getSalesWithItems = async (
  businessId: string,
  from?: unknown,
  to?: unknown,
) => {
  let query = db.from('sales').select('*, sale_items(*)')
    .eq('business_id', businessId).eq('status', 'completada')
  if (from) query = query.gte('sold_at', from)
  if (to) query = query.lte('sold_at', to)
  const { data, error } = await query.order('sold_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

export = {
  getSaleById,
  getSalesByContact,
  getSaleCustomers,
  getCustomerSales,
  voidSale,
  getSalesWithItems,
}
