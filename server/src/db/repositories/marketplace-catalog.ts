import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  MarketplaceBusiness, MarketplaceCategory,
} from '../../services/marketplace-menu'

// El catálogo del marketplace: qué categorías tienen locales hoy, y cuáles.
//
// ⚠️ Las dos consultas EXCLUYEN lo que no puede recibir un pedido ahora mismo
// —suspendido, inactivo, sin pedidos o sin tienda—, y lo hacen en la base y no
// aquí. Filtrar en el servidor dejaría el «(3 locales)» del menú contando
// locales cerrados.

const db: SupabaseClient = require('../client') as typeof import('../client')

/** Las categorías con al menos un local disponible. Nunca una vacía. */
const getMarketplaceCategories = async (): Promise<MarketplaceCategory[]> => {
  const { data, error } = await db.rpc('marketplace_categories_disponibles')
  if (error) throw new Error(error.message)
  return (data || []) as MarketplaceCategory[]
}

/** Los locales de una categoría, por nombre. */
const getMarketplaceBusinesses = async (
  code: string,
): Promise<MarketplaceBusiness[]> => {
  const { data, error } = await db.rpc('marketplace_negocios_de_categoria', {
    p_code: code,
  })
  if (error) throw new Error(error.message)
  return (data || []) as MarketplaceBusiness[]
}

/**
 * ¿Esto que escribió el cliente es COMIDA que conocemos, aunque hoy no haya
 * ningún local que la venda?
 *
 * ⚠️ Existe para no llamarle tonto a quien escribió bien. Hasta el 2026-08-25,
 * «pollo» y «asdfghjkl» recibían EXACTAMENTE el mismo «🙏 No te entendí» — y
 * «pollo» sí se entiende: el alias existe y apunta a `asados`, lo que pasa es
 * que no hay ningún asadero dado de alta. Decirle al cliente que no se le
 * entendió cuando se le entendió perfectamente es de las cosas que hacen que
 * una app parezca tonta.
 *
 * Devuelve la etiqueta de la categoría («Asados y parrilladas») o `null`.
 *
 * ⚠️ Se apoya en el diccionario de alias que ya existe, no en una lista nueva:
 * dos listas de sinónimos acabarían contradiciéndose, y esta ya la cura el
 * superadmin. El coste es que solo reconoce lo que esté en ella — «lasaña»
 * caerá en «no te entendí» hasta que alguien la añada, que es un fallo que se
 * corrige con datos y sin desplegar.
 */
const marketplaceKnownTerm = async (
  query: string,
): Promise<string | null> => {
  const palabras = String(query || '')
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(palabra => palabra.length >= 3)
    .slice(0, 8)
  if (!palabras.length) return null

  const { data, error } = await db
    .from('marketplace_search_aliases')
    .select('category_code')
    .in('term', palabras)
    .limit(1)
  if (error || !data?.length) return null

  const code = (data[0] as { category_code?: string }).category_code
  if (!code) return null

  const { data: categoria } = await db
    .from('marketplace_categories')
    .select('label')
    .eq('code', code)
    .maybeSingle()
  return (categoria as { label?: string } | null)?.label || null
}

export interface MarketplaceHit {
  id: string
  slug: string
  name: string
  type: string
  /** Por qué salió: 'categoria' | 'producto' | 'parecido' | 'local'. */
  motivo: string
  orden: number
}

/**
 * Buscar locales en TODO el marketplace. Sin IA.
 *
 * ⚠️ Se usa solo antes de elegir local. Con local elegido el ámbito es ese
 * local y va por `searchMarketplaceProducts`: traerle la Coca Cola de otro
 * negocio metería en el carrito un producto que no puede estar ahí.
 */
const searchMarketplaceBusinesses = async (
  query: string,
  limite = 8,
): Promise<MarketplaceHit[]> => {
  const { data, error } = await db.rpc('marketplace_buscar_negocios', {
    p_query: query,
    p_limite: limite,
  })
  if (error) throw new Error(error.message)
  return (data || []) as MarketplaceHit[]
}

export interface MarketplaceProductHit {
  id: string
  name: string
  price: number
  orden: number
}

/** Buscar DENTRO del local elegido. El filtro por negocio lo pone la base. */
const searchMarketplaceProducts = async (
  businessId: string,
  query: string,
  limite = 8,
): Promise<MarketplaceProductHit[]> => {
  const { data, error } = await db.rpc('marketplace_buscar_productos', {
    p_business_id: businessId,
    p_query: query,
    p_limite: limite,
  })
  if (error) throw new Error(error.message)
  return (data || []) as MarketplaceProductHit[]
}

/** Un cajón del menú tal como lo elige el superadmin: sin contar sus locales. */
export interface CajonDelMenu {
  code: string
  label: string
  emoji: string | null
  sort: number
}

/**
 * Los cajones del menú, TODOS los activos, tengan locales o no.
 *
 * ⚠️ Distinto de `getMarketplaceCategories`, que solo devuelve los que tienen
 * algo detrás: eso es lo que ve el cliente. Esto es para el superadmin, que
 * necesita ver el cajón vacío para poder meter ahí su primer local.
 */
const getAllMarketplaceCategories = async (): Promise<CajonDelMenu[]> => {
  const { data, error } = await db
    .from('marketplace_categories')
    .select('code,label,emoji,sort')
    .eq('active', true)
    .order('sort')
  if (error) throw new Error(error.message)
  return (data || []) as CajonDelMenu[]
}

/**
 * En qué cajones aparece un local hoy: los elegidos, o los de su tipo.
 *
 * ⚠️ Por RPC y no leyendo la vista con un anidado de PostgREST: PostgREST
 * deduce los anidados de las FOREIGN KEYS y una vista no tiene ninguna, así
 * que esa consulta fallaba SIEMPRE — y la ruta, que se tragaba el error,
 * enseñaba «sin elegir» a locales que sí tenían sus cajones puestos. Se vio
 * probando el alta real contra producción (2026-09-17).
 */
const getBusinessMarketplaceCategories = async (
  businessId: string,
): Promise<{ code: string; label: string; emoji: string | null; principal: boolean }[]> => {
  const { data, error } = await db.rpc('marketplace_cajones_del_negocio', {
    p_business_id: businessId,
  })
  if (error) throw new Error(error.message)
  return (data || []) as {
    code: string; label: string; emoji: string | null; principal: boolean
  }[]
}

/**
 * Deja los cajones de un local exactamente en esta lista. El PRIMERO es el
 * principal. Una lista vacía devuelve el local a lo que diga su tipo.
 */
const setBusinessMarketplaceCategories = async (
  businessId: string,
  codes: string[],
): Promise<number> => {
  const { data, error } = await db.rpc('set_business_marketplace_categories', {
    p_business_id: businessId,
    p_codes: codes,
    p_principal: codes[0] ?? null,
  })
  if (error) throw new Error(error.message)
  return Number(data ?? 0)
}

/**
 * Deja constancia de un paso del menú: vio los cajones, entró en uno, buscó
 * algo o eligió un local.
 *
 * ⚠️ Es un registro de PRODUCTO, no de dinero. Nunca lanza hacia arriba: si la
 * base falla, el cliente tiene que recibir su respuesta igual. Lo que se
 * pierde es una fila de un reporte, no una venta.
 */
const logMarketplaceEvent = async (evento: {
  customerId: string | null
  tipo: 'menu' | 'cajon' | 'busqueda' | 'local'
  categoryCode?: string | null
  businessId?: string | null
  consulta?: string | null
  resultados?: number | null
}): Promise<void> => {
  const { error } = await db.from('marketplace_events').insert({
    customer_id: evento.customerId,
    tipo: evento.tipo,
    category_code: evento.categoryCode ?? null,
    business_id: evento.businessId ?? null,
    // El texto ya viene normalizado del menú; aquí solo se recorta a lo que
    // admite la columna.
    consulta: evento.consulta ? String(evento.consulta).slice(0, 80) : null,
    resultados: evento.resultados ?? null,
  })
  if (error) console.error('❌ registrar el paso del menú:', error.message)
}

export {
  getMarketplaceCategories,
  getMarketplaceBusinesses,
  searchMarketplaceBusinesses,
  searchMarketplaceProducts,
  marketplaceKnownTerm,
  getAllMarketplaceCategories,
  logMarketplaceEvent,
  getBusinessMarketplaceCategories,
  setBusinessMarketplaceCategories,
}
