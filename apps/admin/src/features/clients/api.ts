// ── API del admin (servida por el dominio y compositor TypeScript del superadmin) ──
import { api } from '../../api/client'

export type AdminStats = {
  totalClients: number
  activeClients: number
  suspendedClients: number
  messagesToday: number
}

// Lista resumida (db.getAllBusinesses trae solo columnas básicas — ahorro de egress)
export type BusinessRow = {
  id: string
  slug: string
  name: string
  type: string | null
  whatsapp_number: string | null
  active: boolean
  bot_active: boolean
  suspended: boolean
  plan: string | null
  monthly_contact_limit: number | null
  monthly_outbound_message_limit: number | null
  created_at: string
  notes: string | null
  // Modo real configurado del negocio: el simulador arranca con este
  chat_mode?: 'menu' | 'ai' | null
}

export type MonthlyUsageRow = {
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

export type ChannelStatus = 'ok' | 'silencio' | 'nunca_recibio' | 'sin_canal'

export type ChannelHealth = {
  checkedAt: string
  silenceHours: number
  alert: boolean
  businesses: Array<{
    businessId: string
    name: string
    status: ChannelStatus
    lastInboundAt: string | null
    hoursSinceLastInbound: number | null
    detail: string
  }>
  recentFailures: Array<{
    provider: string
    status: number
    reason: string
    at: string
  }>
  errorsByBusiness: Array<{
    businessId: string
    occurrences: number
    lastSeenAt: string
  }>
}

export type PlatformError = {
  id: string
  business_id: string | null
  category: 'canal' | 'ia' | 'envio' | 'servidor'
  code: string | null
  message: string
  context: Record<string, unknown>
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}

export const getPlatformErrors = (category?: string) => api<PlatformError[]>(
  `/api/admin/errors${category ? `?category=${encodeURIComponent(category)}` : ''}`,
)

export const getStats = () => api<AdminStats>('/api/admin/stats')
export const getChannelHealth = () => api<ChannelHealth>('/api/admin/channel-health')
export const getClients = () => api<BusinessRow[]>('/api/admin/clients')
export const getMonthlyUsage = (month?: string) => api<MonthlyUsageRow[]>(
  `/api/admin/usage${month ? `?month=${encodeURIComponent(month)}` : ''}`,
)

export const suspendClient = (id: string, reason?: string) =>
  api(`/api/admin/clients/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) })

export const reactivateClient = (id: string) =>
  api(`/api/admin/clients/${id}/reactivate`, { method: 'POST' })

/**
 * Enciende o apaga el bot de un negocio SIN tocar su cuenta.
 *
 * No es lo mismo que suspender: un negocio suspendido responde avisando del
 * pago pendiente, mientras que con el bot apagado el cliente escribe y no
 * recibe absolutamente nada. Sirve para pausar mientras se cambia el número o
 * se arregla el canal, no para cobrar.
 */
export const setBotActive = (id: string, active: boolean) =>
  api(`/api/admin/clients/${id}/bot`, {
    method: 'POST',
    body: JSON.stringify({ active }),
  })


// ── Detalle + crear/editar negocio (el corazón del onboarding) ──
export type BusinessDetail = BusinessRow & {
  owner_phone: string | null
  whatsapp_provider: 'ycloud' | 'meta' | 'telegram' | null
  ycloud_number: string | null
  ycloud_webhook_endpoint_id: string | null
  meta_phone_id: string | null
  ai_provider: string | null
  takes_bookings: boolean | null
  takes_orders: boolean | null
  lodging_enabled: boolean | null
  storefront_enabled: boolean | null
  chat_mode: 'menu' | 'ai' | null
  monthly_rate: number | null
  client_email: string
  credential_status: Record<'ycloud_api_key' | 'ycloud_webhook_secret' | 'meta_token' | 'telegram_bot_token', boolean>
}

export type BusinessPayload = Omit<Partial<BusinessDetail>, 'credential_status'> & {
  ycloud_api_key?: string
  ycloud_webhook_secret?: string
  meta_token?: string
  telegram_bot_token?: string
  client_password?: string
  apply_plan_defaults?: boolean
}

export type ProviderVerificationPayload = {
  provider: NonNullable<BusinessDetail['whatsapp_provider']>
  ycloud_api_key?: string
  ycloud_number?: string
  ycloud_webhook_secret?: string
  ycloud_webhook_endpoint_id?: string
  meta_token?: string
  meta_phone_id?: string
  telegram_bot_token?: string
}

export const getClient = (id: string) => api<BusinessDetail>(`/api/admin/clients/${id}`)

export const createClient = (p: BusinessPayload) =>
  api<BusinessRow>('/api/admin/clients', { method: 'POST', body: JSON.stringify(p) })

export const updateClient = (id: string, p: BusinessPayload) =>
  api(`/api/admin/clients/${id}`, { method: 'PUT', body: JSON.stringify(p) })

export const verifyProvider = (payload: ProviderVerificationPayload) =>
  api<{ ok: boolean; info: string }>('/api/admin/verify-provider', { method: 'POST', body: JSON.stringify(payload) })

// ── Herramientas por negocio (paridad con el admin viejo) ──
export type ClientProduct = { id: string; name: string }
export type ClientMsg = { contact_phone: string; role: string; content: string; created_at: string }

export const getClientProducts = (id: string) =>
  api<ClientProduct[]>(`/api/admin/clients/${id}/products`)

export const getClientConversations = (id: string) =>
  api<ClientMsg[]>(`/api/admin/clients/${id}/conversations`)

export const getClientPolicies = (id: string) =>
  api<{ bot_prompt?: string | null; shipping?: string | null }>(`/api/admin/clients/${id}/policies`)

export const saveClientPolicies = (id: string, p: Record<string, string>) =>
  api(`/api/admin/clients/${id}/policies`, { method: 'PUT', body: JSON.stringify(p) })

// Verifica la configuración prospectiva sin revelar los secretos guardados.
// Los valores no enviados se completan exclusivamente dentro del servidor.
export const verifyClient = (id: string, payload?: ProviderVerificationPayload) =>
  api<{ ok: boolean; info: string }>(`/api/admin/clients/${id}/verify`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })

export const deleteClient = (id: string) =>
  api(`/api/admin/clients/${id}`, { method: 'DELETE' })
