import type { SupabaseClient } from '@supabase/supabase-js'

// Catálogo tal y como lo ve la mini app: categorías con imagen, productos con
// sus variantes y sus extras. Todo filtrado por business_id.
//
// ⚠️ Estas consultas alimentan una pantalla PÚBLICA, así que piden columnas
// explícitas y nunca `select('*')`: el embedding del producto pesa 1536 números
// y no tiene ningún sentido enviarlo al teléfono de un cliente.

const db: SupabaseClient = require('../client') as typeof import('../client')

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

/**
 * Los grupos de opciones y sus opciones: el motor con el que se arma un plato.
 *
 * Un grupo cuelga de un producto («término de la carne» solo en hamburguesas) o
 * de una categoría entera, que es como 19 sabores los comparten todas las
 * pizzas sin repetirlos en cada una.
 *
 * Es el sustituto de `menu_modifiers` en la mini app. La tabla vieja sigue viva
 * para el modo menú del bot y el panel del dueño, que aún no han migrado.
 */
const getStorefrontOptionGroups = async (businessId: string) => {
  const { data, error } = await db
    .from('option_groups')
    .select('id,product_id,category_id,name,description,selection_type,required,min_selectable,max_selectable,pricing_strategy,free_selections,sort')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort', { ascending: true })
  fail(error, 'No se pudieron leer los grupos de opciones')
  return data || []
}

const getStorefrontOptions = async (businessId: string) => {
  const { data, error } = await db
    .from('options')
    .select('id,option_group_id,name,description,image_url,price_adjustment,references_product_id,default_selected,stock,sort')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort', { ascending: true })
  fail(error, 'No se pudieron leer las opciones')
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

// ── Lo que gestiona el DUEÑO desde su panel ─────────────────────────────────
//
// Las tablas de arriba solo se leían. Estas son las escrituras, y viven aquí
// porque son las mismas tablas: separarlas por dirección obligaría a buscar en
// dos sitios para entender una.
//
// Todas filtran por `business_id`, que en las rutas sale SIEMPRE del JWT.

/** Para el panel: también las inactivas, que el dueño necesita poder reactivar. */
const getCategories = async (businessId: string) => {
  const { data, error } = await db
    .from('product_categories')
    .select('id,name,description,image_url,image_public_id,sort,active')
    .eq('business_id', businessId)
    .order('sort', { ascending: true })
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer las categorías')
  return data || []
}

const createCategory = async (businessId: string, data: Record<string, unknown>) => (
  db.from('product_categories').insert({ ...data, business_id: businessId }).select().single()
)

const updateCategory = async (
  businessId: string,
  categoryId: string,
  data: Record<string, unknown>,
) => (
  db.from('product_categories')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', categoryId)
)

const deleteCategory = async (businessId: string, categoryId: string) => (
  db.from('product_categories').delete().eq('business_id', businessId).eq('id', categoryId)
)

/**
 * ⚠️ Comprueba que el producto sea del negocio ANTES de tocar sus variantes.
 *
 * No es paranoia: `product_variants` lleva `business_id` Y `product_id`, y la
 * clave foránea de `product_id` apunta a `products` sin mirar de quién es. Sin
 * esta comprobación, un dueño podría colgarle una variante —con su precio— al
 * producto de otro negocio mandando un id ajeno en el cuerpo de la petición.
 */
const productBelongsToBusiness = async (businessId: string, productId: string) => {
  const { data, error } = await db
    .from('products')
    .select('id')
    .eq('business_id', businessId)
    .eq('id', productId)
    .maybeSingle()
  fail(error, 'No se pudo verificar el producto')
  return Boolean(data)
}

/** Para el panel: todas las variantes del negocio, activas o no. */
const getVariants = async (businessId: string) => {
  const { data, error } = await db
    .from('product_variants')
    .select('id,product_id,name,price,price_sale,stock,sort,active')
    .eq('business_id', businessId)
    .order('sort', { ascending: true })
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer las variantes')
  return data || []
}

const createVariant = async (businessId: string, data: Record<string, unknown>) => (
  db.from('product_variants').insert({ ...data, business_id: businessId }).select().single()
)

const updateVariant = async (
  businessId: string,
  variantId: string,
  data: Record<string, unknown>,
) => (
  db.from('product_variants')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', variantId)
)

const deleteVariant = async (businessId: string, variantId: string) => (
  db.from('product_variants').delete().eq('business_id', businessId).eq('id', variantId)
)

/**
 * La cuenta activa del negocio, para el panel.
 *
 * Solo hay una a la vez: guardar una nueva desactiva la anterior en vez de
 * borrarla, para no perder el rastro de con qué cuenta se cobró un pedido
 * viejo.
 */
const upsertBankAccount = async (businessId: string, data: Record<string, unknown>) => {
  const { error: desactivar } = await db
    .from('business_bank_accounts')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('active', true)
  if (desactivar) return { error: desactivar }
  return db.from('business_bank_accounts')
    .insert({ ...data, business_id: businessId, active: true })
    .select()
    .single()
}
export = {
  getStorefrontCategories,
  getStorefrontProducts,
  getStorefrontVariants,
  getStorefrontExtras,
  getStorefrontOptionGroups,
  getStorefrontOptions,
  getBusinessBankAccount,
  // Panel del dueño
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  productBelongsToBusiness,
  getVariants,
  createVariant,
  updateVariant,
  deleteVariant,
  upsertBankAccount,
}
