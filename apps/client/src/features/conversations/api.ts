// ── API de Conversaciones (tipada) ───────────────────────────────────
// Contrato estable servido por src/routes/sessions.routes.ts.
import { api } from '../../api/client'

export type Session = {
  contact_phone: string
  contact_name: string | null
  manual_mode: boolean
  unread_owner: boolean
  last_message: string | null
  last_message_at: string
  tags?: string[]          // ids de conversation_tags
}

export type Msg = {
  contact_phone: string
  role: 'user' | 'assistant' | 'owner'
  content: string
  created_at: string
}

export type Tag = { id: string; name: string; color: string }

export const getSessions      = () => api<Session[]>('/api/client/sessions')
export const getConversations = () => api<Msg[]>('/api/client/conversations')
export const getTags          = () => api<Tag[]>('/api/client/tags')

const enc = encodeURIComponent

export const setMode = (phone: string, manual: boolean) =>
  api(`/api/client/sessions/${enc(phone)}/mode`, { method: 'PUT', body: JSON.stringify({ manual }) })

// "Venta realizada": devuelve el chat al bot + corte de historial (conversación nueva)
export const closeSale = (phone: string) =>
  api(`/api/client/sessions/${enc(phone)}/close`, { method: 'PUT' })

export const markRead = (phone: string) =>
  api(`/api/client/sessions/${enc(phone)}/read`, { method: 'PUT' })

export const renameContact = (phone: string, name: string) =>
  api(`/api/client/sessions/${enc(phone)}/name`, { method: 'PUT', body: JSON.stringify({ name }) })

export const setSessionTags = (phone: string, tags: string[]) =>
  api(`/api/client/sessions/${enc(phone)}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) })

export const sendMessage = (phone: string, message: string) =>
  api(`/api/client/sessions/${enc(phone)}/send`, { method: 'POST', body: JSON.stringify({ message }) })

export const createTag = (name: string, color: string) =>
  api<Tag>('/api/client/tags', { method: 'POST', body: JSON.stringify({ name, color }) })

export const updateTag = (id: string, name: string, color: string) =>
  api(`/api/client/tags/${id}`, { method: 'PUT', body: JSON.stringify({ name, color }) })

export const deleteTag = (id: string) =>
  api(`/api/client/tags/${id}`, { method: 'DELETE' })
