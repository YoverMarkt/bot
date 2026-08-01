import type { SupabaseClient } from '@supabase/supabase-js'

// Catálogo tal y como lo ve la mini app: categorías con imagen, productos con
// sus variantes y sus extras. Todo filtrado por business_id.
//
// ⚠️ Estas consultas alimentan una pantalla PÚBLICA, así que piden columnas
// explícitas y nunca `select('*')`: el embedding del producto pesa 1536 números
// y no tiene ningún sentido enviarlo al teléfono de un cliente.

const db = require('../client') as SupabaseClient

const fail = (error: { message?: string } | null, context: string): void => {
  if (error) throw new Error(`${context}: ${error.message || 'sin detalle'}`)
}

const CAMPOS_PRODUCTO = [
  'id', 'name', 'description', 'brand', 'price', 'price_sale',
  'stock', 'image_url', 'video_url', 'tags', 'category_id', 'duration_minutes',
].join(',')

const getStorefrontCategories = async (businessId: string) => {
  const { data, error } = await db
    .from('product_categories')
    .select('id,name,description,image_url,sort')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort', { ascending: true })
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer las categorías')
  return data || []
}

const getStorefrontProducts = async (businessId: string) => {
  const { data, error } = await db
    .from('products')
    .select(CAMPOS_PRODUCTO)
    .eq('business_id', businessId)
    .eq('active', true)
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer los productos')
  return data || []
}

const getStorefrontVariants = async (businessId: string) => {
  const { data, error } = await db
    .from('product_variants')
    .select('id,product_id,name,price,price_sale,stock,sort')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort', { ascending: true })
  fail(error, 'No se pudieron leer las variantes')
  return data || []
}

/**
 * Extras con precio. Pueden colgar de un producto concreto ("queso extra" solo
 * en pizzas) o de una categoría entera, que es como los usa el modo menú.
 */
const getStorefrontExtras = async (businessId: string) => {
  const { data, error } = await db
    .from('menu_modifiers')
    .select('id,product_id,category_tag,group_label,name,description,price_delta,max_selectable,sort')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort', { ascending: true })
  fail(error, 'No se pudieron leer los extras')
  return data || []
}

/** La cuenta que se le muestra al cliente para transferir. */
const getBusinessBankAccount = async (businessId: string) => {
  const { data, error } = await db
    .from('business_bank_accounts')
    .select('id,bank_name,account_type,account_number,holder_name,holder_id,instructions')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  fail(error, 'No se pudieron leer los datos bancarios')
  return data
}

// ── Autoridad del precio ────────────────────────────────────────────────────

/**
 * Resuelve el precio REAL de una variante, comprobando de paso que pertenezca
 * al negocio y al producto indicados. La app manda ids, nunca precios: lo que
 * el cliente vea en pantalla se confronta aquí antes de cobrar nada.
 */
const getVariantForOrder = async (
  businessId: string,
  productId: string,
  variantId: string,
) => {
  const { data, error } = await db
    .from('product_variants')
    .select('id,product_id,name,price,price_sale,stock,active')
    .eq('business_id', businessId)
    .eq('product_id', productId)
    .eq('id', variantId)
    .maybeSingle()
  fail(error, 'No se pudo verificar la variante')
  return data
}

/** Mismo control para los extras: pertenencia y precio salen de la base. */
const getExtrasForOrder = async (businessId: string, extraIds: string[]) => {
  const ids = [...new Set(extraIds.filter(Boolean))]
  if (!ids.length) return []
  const { data, error } = await db
    .from('menu_modifiers')
    .select('id,product_id,category_tag,name,price_delta,active')
    .eq('business_id', businessId)
    .in('id', ids)
  fail(error, 'No se pudieron verificar los extras')
  return data || []
}

export = {
  getStorefrontCategories,
  getStorefrontProducts,
  getStorefrontVariants,
  getStorefrontExtras,
  getBusinessBankAccount,
  getVariantForOrder,
  getExtrasForOrder,
}
