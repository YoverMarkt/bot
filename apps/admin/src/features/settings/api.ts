// ── API de configuración del servidor (routes/admin.routes.js) ──────
// El GET devuelve las keys ENMASCARADAS (el server nunca expone el valor
// completo); el POST solo envía campos con valor (no pisa keys con '').
import { api } from '../../api/client'

export type ServerSettings = Record<string, string>

export const getServerSettings = () => api<ServerSettings>('/api/admin/server-settings')

export const saveServerSettings = (payload: Record<string, string>) =>
  api<{ ok: boolean }>('/api/admin/server-settings', { method: 'POST', body: JSON.stringify(payload) })

export const verifyAI = (payload: Record<string, string | undefined>) =>
  api<{ ok: boolean; info: string }>('/api/admin/server-settings/verify-ai', { method: 'POST', body: JSON.stringify(payload) })

export const verifyCloudinary = (payload: Record<string, string | undefined>) =>
  api<{ ok: boolean; info: string }>('/api/admin/server-settings/verify-cloudinary', { method: 'POST', body: JSON.stringify(payload) })

// ── Túnel público + URLs de webhooks ──
export type TunnelState = {
  url: string | null
  active: boolean
  provider: string | null
  startedAt: string | null
  webhookSecret?: string
}

export const getTunnel = () => api<TunnelState>('/api/admin/tunnel')
export const startTunnel = () => api<TunnelState>('/api/admin/tunnel/start', { method: 'POST' })
export const stopTunnel = () => api('/api/admin/tunnel/stop', { method: 'POST' })
