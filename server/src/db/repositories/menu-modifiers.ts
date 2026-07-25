import type { SupabaseClient } from '@supabase/supabase-js'

type DataRecord = Record<string, unknown>

const db = require('../client') as SupabaseClient

// Nunca se aceptan estas columnas desde el cliente: las pone el servidor.
function tenantPayload(data: DataRecord): DataRecord {
  const safe = { ...data }
  delete safe.id
  delete safe.business_id
  delete safe.created_at
  delete safe.updated_at
  return safe
}

// Solo los ACTIVOS y opcionalmente de una categoría: lo que consume el bot.
const getMenuModifiers = async (
  businessId: string,
  categoryTag?: string | null,
) => {
  let query = db
    .from('menu_modifiers')
    .select('id, category_tag, group_label, name, description, sort, active')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort')
    .order('name')
  if (categoryTag) query = query.eq('category_tag', categoryTag)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data || []) as DataRecord[]
}

// TODOS (incluye inactivos): para gestionarlos desde el panel del dueño.
const getAllMenuModifiers = async (businessId: string) => {
  const { data, error } = await db
    .from('menu_modifiers')
    .select('id, category_tag, group_label, name, description, sort, active')
    .eq('business_id', businessId)
    .order('category_tag')
    .order('sort')
    .order('name')
  if (error) throw new Error(error.message)
  return (data || []) as DataRecord[]
}

const getMenuModifierById = async (businessId: string, id: string) => {
  const { data, error } = await db
    .from('menu_modifiers')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as DataRecord | null
}

const createMenuModifier = async (businessId: string, data: DataRecord) => db
  .from('menu_modifiers')
  .insert({ ...tenantPayload(data), business_id: businessId })
  .select()
  .single()

const updateMenuModifier = async (
  businessId: string,
  id: string,
  data: DataRecord,
) => db
  .from('menu_modifiers')
  .update({ ...tenantPayload(data), updated_at: new Date().toISOString() })
  .eq('business_id', businessId)
  .eq('id', id)
  .select()
  .maybeSingle()

const deleteMenuModifier = async (businessId: string, id: string) => db
  .from('menu_modifiers')
  .delete()
  .eq('business_id', businessId)
  .eq('id', id)
  .select('id')
  .maybeSingle()

export = {
  getMenuModifiers,
  getAllMenuModifiers,
  getMenuModifierById,
  createMenuModifier,
  updateMenuModifier,
  deleteMenuModifier,
}
