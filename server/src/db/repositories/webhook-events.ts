import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const db = require('../client') as SupabaseClient

const claimWebhookEvent = async (
  businessId: string,
  provider: string,
  messageId: string,
) => {
  const messageIdHash = crypto
    .createHash('sha256')
    .update(String(messageId))
    .digest('hex')
  return db.rpc('claim_webhook_event', {
    p_business_id: businessId,
    p_provider: provider,
    p_message_id_hash: messageIdHash,
  })
}

export = { claimWebhookEvent }
