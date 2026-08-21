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

export {
  getMarketplaceCategories,
  getMarketplaceBusinesses,
  searchMarketplaceBusinesses,
  searchMarketplaceProducts,
}
