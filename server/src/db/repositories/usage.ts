import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppProvider } from '../../types/channels'

const db = require('../client') as SupabaseClient

export type OutboundMessageType = 'text' | 'image' | 'video' | 'interactive'

export interface MonthlyUsageRow {
  business_id: string
  period_start: string
  period_end: string
  active_contacts: number
  inbound_messages: number
  outbound_messages: number
  outbound_text_messages: number
  outbound_image_messages: number
  outbound_video_messages: number
  outbound_interactive_messages: number
  contact_limit: number | null
  outbound_message_limit: number | null
  contact_overage: number
  outbound_message_overage: number
  includes_history_estimate: boolean
}

let warnedAboutUsagePersistence = false
const USAGE_WRITE_TIMEOUT_MS = 2_000

function warnOnce(message: string): void {
  if (warnedAboutUsagePersistence) return
  warnedAboutUsagePersistence = true
  console.warn(`⚠️  Consumo mensual: ${message}`)
}

const sha256 = (value: string): string => crypto
  .createHash('sha256')
  .update(value)
  .digest('hex')

export async function recordOutboundUsage(
  businessId: string | null | undefined,
  provider: WhatsAppProvider,
  contact: string,
  messageType: OutboundMessageType,
): Promise<boolean> {
  const normalizedBusinessId = String(businessId || '').trim()
  const normalizedContact = String(contact || '').trim()
  if (!normalizedBusinessId || !normalizedContact) return false

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), USAGE_WRITE_TIMEOUT_MS)
  try {
    const { error } = await db
      .from('message_usage_events')
      .insert({
        business_id: normalizedBusinessId,
        provider,
        direction: 'outbound',
        message_type: messageType,
        contact_key_hash: sha256(
          `${provider}:${normalizedBusinessId}:${normalizedContact}`,
        ),
        source_kind: 'send',
        source_key: `outbound:${crypto.randomUUID()}`,
        occurred_at: new Date().toISOString(),
      })
      .abortSignal(abortController.signal)
    if (error) {
      warnOnce('no se pudo guardar un envío aceptado; revisa que la migración esté aplicada')
      return false
    }
    return true
  } catch {
    // El mensaje ya fue aceptado por el proveedor. Un fallo del contador nunca
    // debe provocar que el bot lo reintente y lo envíe dos veces.
    warnOnce('la base no respondió al registrar un envío aceptado')
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function numericRow(row: Record<string, unknown>): MonthlyUsageRow {
  const numberValue = (key: string): number => Number(row[key] || 0)
  const nullableNumber = (key: string): number | null => (
    row[key] === null || row[key] === undefined ? null : Number(row[key])
  )
  return {
    business_id: String(row.business_id || ''),
    period_start: String(row.period_start || ''),
    period_end: String(row.period_end || ''),
    active_contacts: numberValue('active_contacts'),
    inbound_messages: numberValue('inbound_messages'),
    outbound_messages: numberValue('outbound_messages'),
    outbound_text_messages: numberValue('outbound_text_messages'),
    outbound_image_messages: numberValue('outbound_image_messages'),
    outbound_video_messages: numberValue('outbound_video_messages'),
    outbound_interactive_messages: numberValue('outbound_interactive_messages'),
    contact_limit: nullableNumber('contact_limit'),
    outbound_message_limit: nullableNumber('outbound_message_limit'),
    contact_overage: numberValue('contact_overage'),
    outbound_message_overage: numberValue('outbound_message_overage'),
    includes_history_estimate: row.includes_history_estimate === true,
  }
}

export async function getAdminMonthlyUsage(
  month: string | null = null,
): Promise<MonthlyUsageRow[]> {
  const { data, error } = await db.rpc('get_admin_monthly_usage', {
    p_month: month,
  })
  if (error) throw new Error(error.message)
  return ((data || []) as Record<string, unknown>[]).map(numericRow)
}
