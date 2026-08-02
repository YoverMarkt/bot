import type { SupabaseClient } from '@supabase/supabase-js'

const db: SupabaseClient = require('../client') as typeof import('../client')

const getAdminStats = async () => {
  const [businesses, active, suspended, messages] = await Promise.all([
    db.from('businesses').select('*', { count: 'exact', head: true }),
    db.from('businesses').select('*', { count: 'exact', head: true })
      .eq('bot_active', true),
    db.from('businesses').select('*', { count: 'exact', head: true })
      .eq('suspended', true),
    db.from('conversation_history').select('*', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
  ])
  return {
    totalClients: businesses.count || 0,
    activeClients: active.count || 0,
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

// Cuándo entró el último mensaje de cada negocio. Alimenta la vigilancia del
// canal (`services/channel-health.ts`): si esto se queda quieto, el bot está
// mudo aunque el servidor siga en pie.
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
  getLastInboundAt,
}
