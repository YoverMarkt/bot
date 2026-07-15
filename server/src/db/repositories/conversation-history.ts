import type { SupabaseClient } from '@supabase/supabase-js'

type MessageRole = 'user' | 'assistant' | 'owner'

const db = require('../client') as SupabaseClient

const getConversations = async (businessId: string, limit = 100) => {
  const { data } = await db
    .from('conversation_history')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return data || []
}

const getContactHistory = async (
  businessId: string,
  phone: string,
  limit = 24,
  sinceTimestamp: string | null = null,
) => {
  let query = db
    .from('conversation_history')
    .select('role,content,created_at')
    .eq('business_id', businessId)
    .eq('contact_phone', phone)
  if (sinceTimestamp) query = query.gt('created_at', sinceTimestamp)

  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data || []).reverse()
}

// Resolución de tenant para Telegram: solo recupera el business_id más reciente
// asociado al chat. El negocio se valida después mediante getBusinessById.
const getLatestBusinessIdForContact = async (phone: string): Promise<string | null> => {
  const { data, error } = await db
    .from('conversation_history')
    .select('business_id')
    .eq('contact_phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return typeof data?.business_id === 'string' ? data.business_id : null
}

const saveMessage = async (
  businessId: string,
  phone: string,
  role: MessageRole,
  content: string,
) => {
  const result = await db.from('conversation_history').insert({
    business_id: businessId,
    contact_phone: phone,
    role,
    content,
  })

  // Compatibilidad con bases antiguas cuya restricción todavía no permite owner.
  if (result.error && role === 'owner') {
    return db.from('conversation_history').insert({
      business_id: businessId,
      contact_phone: phone,
      role: 'assistant',
      content,
    })
  }
  return result
}

const clearSimHistory = async (businessId: string) => db
  .from('conversation_history')
  .delete()
  .eq('business_id', businessId)
  .eq('contact_phone', 'sim_admin')

export = {
  getConversations,
  getContactHistory,
  getLatestBusinessIdForContact,
  saveMessage,
  clearSimHistory,
}
