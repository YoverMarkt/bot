import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlatformErrorRow } from '../types'

// Errores de plataforma agrupados por huella. Los escribe
// `services/error-log.ts` (ya saneados) y los lee el panel del superadmin.

const db: SupabaseClient = require('../client') as typeof import('../client')

// Sin `export`: el repositorio se expone con `export =` y no admite mezclar.
// El router declara su propia forma del registro.

const recordPlatformError = async (input: {
  businessId: string | null
  category: string
  code: string | null
  message: string
  context: Record<string, unknown>
  fingerprint: string
}) => {
  const { data, error } = await db.rpc('record_platform_error', {
    p_business_id: input.businessId,
    p_category: input.category,
    p_code: input.code,
    p_message: input.message,
    p_context: input.context,
    p_fingerprint: input.fingerprint,
  })
  if (error) throw new Error(error.message)
  return data as string | null
}

// Listado para el panel. `limit` acotado para que una tabla grande no se
// convierta en una descarga enorme de datos.
const getPlatformErrors = async (options: {
  category?: string
  businessId?: string
  limit?: number
} = {}) => {
  let query = db
    .from('platform_errors')
    .select('id,business_id,category,code,message,context,occurrences,first_seen_at,last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(Math.min(Math.max(options.limit || 100, 1), 1000))
  if (options.category) query = query.eq('category', options.category)
  if (options.businessId) query = query.eq('business_id', options.businessId)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data || []) as PlatformErrorRow[]
}

// Resumen por negocio para pintar el semáforo en la lista de clientes sin
// traerse todos los errores.
const getErrorCountsByBusiness = async () => {
  const { data, error } = await db
    .from('platform_errors')
    .select('business_id,occurrences,last_seen_at')
    .gte('last_seen_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(1000)
  // Permite desplegar antes de correr migration-registro-errores.sql: sin la
  // tabla no hay errores que contar, pero la vigilancia del canal —que es lo
  // que de verdad avisa si el bot está mudo— debe seguir respondiendo.
  if (error?.message && /platform_errors/.test(error.message)) return []
  if (error) throw new Error(error.message)
  const counts = new Map<string, { occurrences: number; lastSeenAt: string }>()
  for (const row of (data || []) as Array<{
    business_id: string | null
    occurrences: number
    last_seen_at: string
  }>) {
    if (!row.business_id) continue
    const previous = counts.get(row.business_id)
    counts.set(row.business_id, {
      occurrences: (previous?.occurrences || 0) + (row.occurrences || 0),
      lastSeenAt: previous && previous.lastSeenAt > row.last_seen_at
        ? previous.lastSeenAt
        : row.last_seen_at,
    })
  }
  return [...counts].map(([businessId, value]) => ({ businessId, ...value }))
}

const cleanupPlatformErrors = async (days = 30) => db.rpc(
  'cleanup_platform_errors',
  { p_days: days },
)

export = {
  recordPlatformError,
  getPlatformErrors,
  getErrorCountsByBusiness,
  cleanupPlatformErrors,
}
