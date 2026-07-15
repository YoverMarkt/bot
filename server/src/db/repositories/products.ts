import type { SupabaseClient } from '@supabase/supabase-js'

type ProductData = Record<string, unknown>

const db = require('../client') as SupabaseClient

const getProducts = async (businessId: string) => {
  const { data, error } = await db
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('name')
  if (error) throw new Error(error.message)
  return data || []
}

const getProductById = async (businessId: string, id: string) => {
  const { data } = await db
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', id)
    .single()
  return data
}

// Endpoint público de imágenes: devuelve únicamente la URL, nunca el producto completo.
const getProductImageById = async (id: string) => {
  const { data } = await db
    .from('products')
    .select('image_url')
    .eq('id', id)
    .eq('active', true)
    .single()
  return data
}

const createProduct = async (businessId: string, data: ProductData) => {
  const safe = { ...data }
  delete safe.id
  delete safe.business_id
  delete safe.created_at
  return db.from('products').insert({
    ...safe,
    business_id: businessId,
    active: true,
  }).select().single()
}

const updateProduct = async (
  businessId: string,
  id: string,
  data: ProductData,
) => {
  const safe = { ...data }
  delete safe.business_id
  delete safe.id
  delete safe.created_at
  return db
    .from('products')
    .update({ ...safe, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
}

const deleteProduct = async (businessId: string, id: string) => db
  .from('products')
  .update({ active: false })
  .eq('business_id', businessId)
  .eq('id', id)

const countProducts = async (businessId: string) => {
  const { count } = await db
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('active', true)
  return count || 0
}

const setProductEmbedding = async (
  businessId: string,
  id: string,
  embedding: number[],
) => db
  .from('products')
  .update({ embedding })
  .eq('business_id', businessId)
  .eq('id', id)

const getProductsWithoutEmbedding = async (businessId: string) => {
  const { data } = await db
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('active', true)
    .is('embedding', null)
  return data || []
}

const searchProductsByVector = async (
  businessId: string,
  queryEmbedding: number[],
  limit = 12,
) => {
  const { data, error } = await db.rpc('match_products', {
    query_embedding: queryEmbedding,
    biz_id: businessId,
    match_count: limit,
  })
  if (error) {
    console.error('❌ match_products:', error.message)
    return null
  }
  return data || []
}

export = {
  getProducts,
  getProductById,
  getProductImageById,
  createProduct,
  updateProduct,
  deleteProduct,
  countProducts,
  setProductEmbedding,
  getProductsWithoutEmbedding,
  searchProductsByVector,
}
