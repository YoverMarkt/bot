// ── API del admin (tipada sobre routes/admin.routes.js) ─────────────
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
  plan_expires_at: string | null
  created_at: string
  notes: string | null
}

export const getStats = () => api<AdminStats>('/api/admin/stats')
export const getClients = () => api<BusinessRow[]>('/api/admin/clients')

export const suspendClient = (id: string, reason?: string) =>
  api(`/api/admin/clients/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) })

export const reactivateClient = (id: string) =>
  api(`/api/admin/clients/${id}/reactivate`, { method: 'POST' })

export const setBotActive = (id: string, bot_active: boolean) =>
  api(`/api/admin/clients/${id}`, { method: 'PUT', body: JSON.stringify({ bot_active }) })

// ── Detalle + crear/editar negocio (el corazón del onboarding) ──
export type BusinessDetail = BusinessRow & {
  owner_phone: string | null
  whatsapp_provider: 'ycloud' | 'meta' | 'kapso' | 'telegram' | null
  ycloud_api_key: string | null
  ycloud_number: string | null
  meta_token: string | null
  meta_phone_id: string | null
  meta_verify_token: string | null
  kapso_api_key: string | null
  kapso_number_id: string | null
  kapso_verify_token: string | null
  telegram_bot_token: string | null
  ai_provider: string | null
  takes_bookings: boolean | null
  takes_orders: boolean | null
  monthly_rate: number | null
  client_email: string
}

export type BusinessPayload = Partial<BusinessDetail> & {
  client_password?: string
  plan_expires_at?: string | null
}

export const getClient = (id: string) => api<BusinessDetail>(`/api/admin/clients/${id}`)

export const createClient = (p: BusinessPayload) =>
  api<BusinessRow>('/api/admin/clients', { method: 'POST', body: JSON.stringify(p) })

export const updateClient = (id: string, p: BusinessPayload) =>
  api(`/api/admin/clients/${id}`, { method: 'PUT', body: JSON.stringify(p) })

export const verifyProvider = (payload: Record<string, string | undefined>) =>
  api<{ ok: boolean; info: string }>('/api/admin/verify-provider', { method: 'POST', body: JSON.stringify(payload) })
