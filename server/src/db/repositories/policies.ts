import type { SupabaseClient } from '@supabase/supabase-js'

type PolicyData = Record<string, unknown>

const db = require('../client') as SupabaseClient

const getPolicies = async (businessId: string) => {
  const { data } = await db
    .from('bot_policies')
    .select('*')
    .eq('business_id', businessId)
    .single()
  return data
}

const upsertPolicies = async (businessId: string, data: PolicyData) => db
  .from('bot_policies')
  .upsert(
    { ...data, business_id: businessId, updated_at: new Date().toISOString() },
    { onConflict: 'business_id' },
  )

export = { getPolicies, upsertPolicies }
