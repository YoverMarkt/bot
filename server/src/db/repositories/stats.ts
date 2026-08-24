import type { SupabaseClient } from '@supabase/supabase-js'

const db: SupabaseClient = require('../client') as typeof import('../client')

// Las cuatro cifras de la portada del superadmin.
//
// ⚠️ Dos de ellas cambiaron de fuente el 2026-08-23, porque contaban un mundo
// que ya no existe: el de «un bot por local».
//
//   · `activeClients` contaba `bot_active`, una columna que hoy no decide
//     NADA: solo la lee `bot-conversation.ts`, y el marketplace no pasa por
//     ahí. Ahora cuenta lo único que se puede comprobar desde fuera —cuántos
//     locales puede ALCANZAR un cliente— con las MISMAS cuatro condiciones que
//     `marketplace_categories_disponibles`. Si divergen, la portada diría que
//     hay locales que el menú no ofrece.
//
//   · `messagesToday` contaba `conversation_history`, donde el marketplace no
//     escribe una sola fila: marcaba 4 mensajes en un día de 55 entrantes
//     reales. Ahora cuenta lo que de verdad ENTRÓ por el número, que es la
//     pregunta que la portada intenta responder.
const getAdminStats = async () => {
  const [businesses, enElMarketplace, suspended, messages] = await Promise.all([
    db.from('businesses').select('*', { count: 'exact', head: true }),
    db.from('businesses').select('*', { count: 'exact', head: true })
      .eq('active', true)
      // ⚠️ `not.is.true` y NO `neq`: `businesses.suspended` es ANULABLE
      // (`boolean default false`, sin `not null`). `suspended <> true` con
      // NULL da NULL y excluye la fila, mientras que el `is not true` de la
      // RPC la INCLUYE — la portada contaría uno menos que el menú, y solo
      // para los negocios que nadie suspendió nunca explícitamente.
      .not('suspended', 'is', true)
      .eq('takes_orders', true)
      .eq('storefront_enabled', true),
    db.from('businesses').select('*', { count: 'exact', head: true })
      .eq('suspended', true),
    db.from('webhook_inbound_events').select('*', { count: 'exact', head: true })
      .gte('received_at', new Date(Date.now() - 86_400_000).toISOString()),
  ])
  return {
    totalClients: businesses.count || 0,
    activeClients: enElMarketplace.count || 0,
    suspendedClients: suspended.count || 0,
    messagesToday: messages.count || 0,
  }
}

const getClientStats = async (businessId: string) => {
  const [products, available, messages, contacts] = await Promise.all([
    db.from('products').select('*', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('active', true),
    db.from('products').select('*', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('stock', 'disponible').eq('active', true),
    db.from('conversation_history').select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
    db.from('conversation_history').select('contact_phone')
      .eq('business_id', businessId).eq('role', 'user'),
  ])
  return {
    totalProducts: products.count || 0,
    availableProducts: available.count || 0,
    messagesToday: messages.count || 0,
    totalContacts: new Set(
      (contacts.data || []).map(contact => contact.contact_phone).filter(Boolean),
    ).size,
  }
}

// Cuándo entró el último mensaje de cada negocio CON CANAL PROPIO.
//
// ⚠️ NO sirve para un local del marketplace, y ese fue el fallo: sus mensajes
// llegan al número de la plataforma y se encolan con `business_id` NULL, así
// que este filtro no encuentra ninguno JAMÁS. El semáforo de Monster Pizza se
// congeló en el minuto exacto en que el número dejó de ser suyo (04:41 del
// 2026-08-23) y a las 12 h habría gritado «silencio» para siempre.
//
// Quinta vez del mismo fallo del NULL en este proyecto. Aquí no se arregla con
// `is not distinct from` —preguntar «¿el último entrante sin local?» por cada
// local daría la misma fecha a todos—: la pregunta correcta es otra, y la
// responde `getPlatformLastInboundAt`.
const getLastInboundByBusiness = async (businessIds: string[]) => {
  const ids = businessIds.filter(Boolean)
  if (!ids.length) return []
  // Una consulta por negocio, pero mínima: una sola fila y dos columnas. Se
  // resuelve con el índice de la cola y mantiene el egress casi en cero.
  return Promise.all(ids.map(async (businessId) => {
    const { data, error } = await db
      .from('webhook_inbound_events')
      .select('received_at')
      .eq('business_id', businessId)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return {
      businessId,
      lastInboundAt: (data?.received_at as string | undefined) || null,
    }
  }))
}

// Cuándo entró el último mensaje POR EL NÚMERO DE LA PLATAFORMA.
//
// `business_id is null` es exactamente «llegó al número de Umbani»: el webhook
// solo deja ese campo vacío cuando `resolveBusinessChannel` no encontró dueño,
// que es el caso del canal compartido. Un negocio con número propio escribe su
// id, así que sus mensajes no se cuelan aquí.
const getPlatformLastInboundAt = async (): Promise<string | null> => {
  const { data, error } = await db
    .from('webhook_inbound_events')
    .select('received_at')
    .is('business_id', null)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data?.received_at as string | undefined) || null
}

// El entrante más reciente de toda la plataforma, para el healthcheck.
const getLastInboundAt = async (): Promise<string | null> => {
  const { data, error } = await db
    .from('webhook_inbound_events')
    .select('received_at')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data?.received_at as string | undefined) || null
}

export = {
  getAdminStats,
  getClientStats,
  getLastInboundByBusiness,
  getPlatformLastInboundAt,
  getLastInboundAt,
}
