import type { SupabaseClient } from '@supabase/supabase-js'

type SaleData = Record<string, unknown>
type SaleItemData = Record<string, unknown>

const db = require('../client') as SupabaseClient

const createSaleWithItems = async (sale: SaleData, items: SaleItemData[]) => db.rpc(
  'create_sale_with_items',
  {
    p_business_id: sale.business_id,
    p_contact_phone: sale.contact_phone,
    p_contact_name: sale.contact_name,
    p_created_by: sale.created_by,
    p_items: items,
  },
)

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
  createSaleWithItems,
  getSaleById,
  getSalesByContact,
  getSaleCustomers,
  getCustomerSales,
  voidSale,
  getSalesWithItems,
}
