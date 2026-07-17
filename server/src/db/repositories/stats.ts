import type { SupabaseClient } from '@supabase/supabase-js'

const db = require('../client') as SupabaseClient

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

export = { getAdminStats, getClientStats }
