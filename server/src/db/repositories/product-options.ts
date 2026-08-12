import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  RecommendationRow,
  OptionGroupRow,
  OptionRow,
  OptionTemplateItemRow,
  OptionTemplateRow,
} from '../types'

// Grupos de opciones, opciones y plantillas, tal y como los administra el DUEÑO
// desde su panel. Es la otra cara de `catalog.ts`, que solo lee para la tienda.
//
// ⚠️ TODAS las consultas filtran por `business_id`, y ese id sale SIEMPRE del
// JWT en las rutas —nunca del cuerpo de la petición—. Las foráneas compuestas
// de la base son la segunda cerradura: aunque una ruta se despistara, no se
// puede colgar un grupo del producto de otro negocio.

const db: SupabaseClient = require('../client') as typeof import('../client')

const fail = (error: { message?: string } | null, context: string): void => {
  if (error) throw new Error(`${context}: ${error.message || 'sin detalle'}`)
}

const CAMPOS_GRUPO = [
  'id', 'product_id', 'category_id', 'name', 'description', 'selection_type',
  'required', 'min_selectable', 'max_selectable', 'max_total_quantity',
  'pricing_strategy', 'free_selections', 'option_template_id', 'sort', 'active',
].join(',')

const CAMPOS_OPCION = [
  'id', 'option_group_id', 'name', 'description', 'image_url', 'image_public_id',
  'price_adjustment', 'references_product_id', 'default_selected', 'stock',
  'sort', 'active',
].join(',')

const CAMPOS_PLANTILLA = ['id', 'name', 'description', 'active'].join(',')

const CAMPOS_ITEM_PLANTILLA = [
  'id', 'option_template_id', 'name', 'description', 'image_url', 'image_public_id',
  'price_adjustment', 'references_product_id', 'default_selected', 'stock',
  'sort', 'active',
].join(',')

// ── Grupos de opciones ──────────────────────────────────────────────────────

/**
 * Todos los grupos del negocio. El panel los pinta agrupados por producto o
 * categoría, así que se traen de una vez en lugar de una consulta por producto:
 * un catálogo de 200 platos serían 200 viajes.
 */
const getOptionGroups = async (businessId: string) => {
  const { data, error } = await db
    .from('option_groups')
    .select(CAMPOS_GRUPO)
    .eq('business_id', businessId)
    .order('sort', { ascending: true })
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer los grupos de opciones')
  return (data || []) as unknown as OptionGroupRow[]
}

const getOptionGroupById = async (businessId: string, id: string) => {
  const { data } = await db
    .from('option_groups')
    .select(CAMPOS_GRUPO)
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  return (data || null) as unknown as OptionGroupRow | null
}

const createOptionGroup = async (businessId: string, data: Record<string, unknown>) => (
  db.from('option_groups').insert({ ...data, business_id: businessId }).select().single()
)

const updateOptionGroup = async (
  businessId: string,
  id: string,
  data: Record<string, unknown>,
) => (
  db.from('option_groups')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
)

const deleteOptionGroup = async (businessId: string, id: string) => (
  db.from('option_groups').delete().eq('business_id', businessId).eq('id', id)
)

/**
 * Reordena los grupos según la lista que llega, y en UNA sola operación.
 *
 * Va por RPC y no con un update por grupo porque reordenar es una decisión
 * sola: a mitad de camino, media lista movida es peor que la lista intacta.
 * La función comprueba el `business_id` de cada fila, así que un id de otro
 * local simplemente no se mueve.
 */
const reorderOptionGroups = async (businessId: string, ids: string[]) => {
  const { data, error } = await db.rpc('reorder_option_groups', {
    p_business_id: businessId,
    p_ids: ids,
  })
  if (error) throw new Error(error.message)
  return Number(data) || 0
}

/** Lo mismo dentro de un grupo. Lleva el grupo además del negocio: sin él, una
 *  opción de otro grupo del mismo local se colaría en la lista. */
const reorderOptions = async (businessId: string, groupId: string, ids: string[]) => {
  const { data, error } = await db.rpc('reorder_options', {
    p_business_id: businessId,
    p_group_id: groupId,
    p_ids: ids,
  })
  if (error) throw new Error(error.message)
  return Number(data) || 0
}

// ── Opciones ────────────────────────────────────────────────────────────────

const getOptions = async (businessId: string) => {
  const { data, error } = await db
    .from('options')
    .select(CAMPOS_OPCION)
    .eq('business_id', businessId)
    .order('sort', { ascending: true })
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer las opciones')
  return (data || []) as unknown as OptionRow[]
}

const getOptionById = async (businessId: string, id: string) => {
  const { data } = await db
    .from('options')
    .select(CAMPOS_OPCION)
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  return (data || null) as unknown as OptionRow | null
}

const createOption = async (businessId: string, data: Record<string, unknown>) => (
  db.from('options').insert({ ...data, business_id: businessId }).select().single()
)

const updateOption = async (
  businessId: string,
  id: string,
  data: Record<string, unknown>,
) => (
  db.from('options')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
)

const deleteOption = async (businessId: string, id: string) => (
  db.from('options').delete().eq('business_id', businessId).eq('id', id)
)

// ── Plantillas reutilizables ────────────────────────────────────────────────

const getOptionTemplates = async (businessId: string) => {
  const { data, error } = await db
    .from('option_templates')
    .select(CAMPOS_PLANTILLA)
    .eq('business_id', businessId)
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer las plantillas')
  return (data || []) as unknown as OptionTemplateRow[]
}

const getOptionTemplateById = async (businessId: string, id: string) => {
  const { data } = await db
    .from('option_templates')
    .select(CAMPOS_PLANTILLA)
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  return (data || null) as unknown as OptionTemplateRow | null
}

const createOptionTemplate = async (businessId: string, data: Record<string, unknown>) => (
  db.from('option_templates').insert({ ...data, business_id: businessId }).select().single()
)

const updateOptionTemplate = async (
  businessId: string,
  id: string,
  data: Record<string, unknown>,
) => (
  db.from('option_templates')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
)

/**
 * Borrar una plantilla NO rompe los grupos que la usaban: la foránea los deja
 * con `option_template_id` nulo y el producto se sigue pudiendo pedir. Es
 * deliberado — una plantilla se referencia desde varios sitios y borrarla no
 * puede tumbar media carta.
 */
const deleteOptionTemplate = async (businessId: string, id: string) => (
  db.from('option_templates').delete().eq('business_id', businessId).eq('id', id)
)

/** Cuántos grupos se sirven de cada plantilla: el panel avisa antes de borrar. */
const getOptionTemplateUsage = async (businessId: string) => {
  const { data, error } = await db
    .from('option_groups')
    .select('option_template_id')
    .eq('business_id', businessId)
    .not('option_template_id', 'is', null)
  fail(error, 'No se pudo leer el uso de las plantillas')
  return (data || []) as unknown as { option_template_id: string | null }[]
}

// ── Ítems de plantilla ──────────────────────────────────────────────────────

const getOptionTemplateItems = async (businessId: string) => {
  const { data, error } = await db
    .from('option_template_items')
    .select(CAMPOS_ITEM_PLANTILLA)
    .eq('business_id', businessId)
    .order('sort', { ascending: true })
    .order('name', { ascending: true })
  fail(error, 'No se pudieron leer las opciones de las plantillas')
  return (data || []) as unknown as OptionTemplateItemRow[]
}

const getOptionTemplateItemById = async (businessId: string, id: string) => {
  const { data } = await db
    .from('option_template_items')
    .select(CAMPOS_ITEM_PLANTILLA)
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  return (data || null) as unknown as OptionTemplateItemRow | null
}

const createOptionTemplateItem = async (businessId: string, data: Record<string, unknown>) => (
  db.from('option_template_items').insert({ ...data, business_id: businessId }).select().single()
)

const updateOptionTemplateItem = async (
  businessId: string,
  id: string,
  data: Record<string, unknown>,
) => (
  db.from('option_template_items')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
)

const deleteOptionTemplateItem = async (businessId: string, id: string) => (
  db.from('option_template_items').delete().eq('business_id', businessId).eq('id', id)
)

// ── Adicionales que el dueño ofrece «además» ───────────────────────────────

const CAMPOS_RECOMENDACION = [
  'id', 'source_product_id', 'source_category_id', 'recommended_product_id',
  'section', 'sort', 'active',
].join(',')

const getRecommendations = async (businessId: string) => {
  const { data, error } = await db
    .from('product_recommendations')
    .select(CAMPOS_RECOMENDACION)
    .eq('business_id', businessId)
    .order('sort', { ascending: true })
  fail(error, 'No se pudieron leer los adicionales')
  return (data || []) as unknown as RecommendationRow[]
}

const getRecommendationById = async (businessId: string, id: string) => {
  const { data } = await db
    .from('product_recommendations')
    .select(CAMPOS_RECOMENDACION)
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  return (data || null) as unknown as RecommendationRow | null
}

const createRecommendation = async (businessId: string, data: Record<string, unknown>) => (
  db.from('product_recommendations')
    .insert({ ...data, business_id: businessId }).select().single()
)

const updateRecommendation = async (
  businessId: string, id: string, data: Record<string, unknown>,
) => (
  db.from('product_recommendations')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
)

const deleteRecommendation = async (businessId: string, id: string) => (
  db.from('product_recommendations').delete().eq('business_id', businessId).eq('id', id)
)

export = {
  getRecommendations,
  getRecommendationById,
  createRecommendation,
  updateRecommendation,
  deleteRecommendation,
  getOptionGroups,
  getOptionGroupById,
  createOptionGroup,
  updateOptionGroup,
  deleteOptionGroup,
  reorderOptionGroups,
  getOptions,
  getOptionById,
  createOption,
  updateOption,
  deleteOption,
  reorderOptions,
  getOptionTemplates,
  getOptionTemplateById,
  createOptionTemplate,
  updateOptionTemplate,
  deleteOptionTemplate,
  getOptionTemplateUsage,
  getOptionTemplateItems,
  getOptionTemplateItemById,
  createOptionTemplateItem,
  updateOptionTemplateItem,
  deleteOptionTemplateItem,
}
