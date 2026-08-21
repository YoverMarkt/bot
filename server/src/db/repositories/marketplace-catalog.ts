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

export { getMarketplaceCategories, getMarketplaceBusinesses }
