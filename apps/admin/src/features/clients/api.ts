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
