import type { SupabaseClient } from '@supabase/supabase-js'

type SessionData = Record<string, unknown>

const db = require('../client') as SupabaseClient

const getSession = async (businessId: string, phone: string) => {
  const { data } = await db
    .from('conversation_sessions')
    .select('*')
    .eq('business_id', businessId)
    .eq('contact_phone', phone)
    .single()
  return data
}

const getSessions = async (businessId: string) => {
  const { data, error } = await db
    .from('conversation_sessions')
    .select('*')
    .eq('business_id', businessId)
    .order('last_message_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

const upsertSession = async (
  businessId: string,
  phone: string,
  data: SessionData,
) => {
  const safe = { ...data }
  delete safe.id
  delete safe.business_id
  delete safe.contact_phone
  delete safe.created_at

  return db.from('conversation_sessions').upsert(
    {
      ...safe,
      business_id: businessId,
      contact_phone: phone,
    },
    { onConflict: 'business_id,contact_phone' },
  )
}

export = { getSession, getSessions, upsertSession }
