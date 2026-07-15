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
  ycloud_number: string | null
  meta_phone_id: string | null
  kapso_number_id: string | null
  retell_agent_id: string | null
  ai_provider: string | null
  takes_bookings: boolean | null
  takes_orders: boolean | null
  lodging_enabled: boolean | null
  monthly_rate: number | null
  client_email: string
  credential_status: Record<'ycloud_api_key' | 'meta_token' | 'meta_verify_token' | 'kapso_api_key' | 'kapso_verify_token' | 'telegram_bot_token', boolean>
}

export type BusinessPayload = Omit<Partial<BusinessDetail>, 'credential_status'> & {
  ycloud_api_key?: string
  meta_token?: string
  meta_verify_token?: string
  kapso_api_key?: string
  kapso_verify_token?: string
  telegram_bot_token?: string
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

// Verificar credenciales GUARDADAS de un negocio (botón de la tabla)
export const verifyClient = (id: string) =>
  api<{ ok: boolean; info: string }>(`/api/admin/clients/${id}/verify`, { method: 'POST' })

export const deleteClient = (id: string) =>
  api(`/api/admin/clients/${id}`, { method: 'DELETE' })
