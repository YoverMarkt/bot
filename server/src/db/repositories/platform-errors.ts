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

// ⚠️ Aquí vivía `getErrorCountsByBusiness`, retirado el 2026-08-23.
//
// Resumía los errores de las últimas 24 h POR NEGOCIO para pintar un semáforo
// en la lista de clientes. Se va por dos motivos que se refuerzan:
//
//   · Nadie lo pintaba. Viajaba en la respuesta de `/api/admin/channel-health`
//     y el panel lo declaraba en su tipo (`errorsByBusiness`) sin renderizarlo
//     en ningún sitio.
//   · Y ya no podría: descartaba las filas con `business_id` NULL, que hoy son
//     CINCO DE CADA SEIS — los errores del canal del marketplace no pertenecen
//     a ningún local. El resumen habría enseñado ceros mientras el registro
//     acumulaba fallos reales del webhook.
//
// Los errores se leen enteros, con su negocio o con «plataforma», en la
// pantalla de Errores (`getPlatformErrors`).

const cleanupPlatformErrors = async (days = 30) => db.rpc(
  'cleanup_platform_errors',
  { p_days: days },
)

export = {
  recordPlatformError,
  getPlatformErrors,
  cleanupPlatformErrors,
}
