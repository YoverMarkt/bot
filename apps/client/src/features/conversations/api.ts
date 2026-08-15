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

/**
 * Los números que este negocio tiene bloqueados.
 *
 * Van aparte de la lista de chats porque son pocos —y en casi todos los
 * negocios, ninguno—, mientras que la lista se pide cada diez segundos.
 */
export const getBlocked = () => api<string[]>('/api/client/sessions/blocked')

/**
 * Bloquear es TOTAL: el bot deja de contestarle en todos los modos y la mini
 * app le rechaza el pedido aunque tenga su enlace guardado.
 *
 * Al bloqueado NUNCA se le avisa: quien escribe para molestar busca una
 * reacción, y además cada aviso es un mensaje que se paga.
 */
export const setBlocked = (phone: string, blocked: boolean) =>
  api<{ blocked: boolean }>(`/api/client/sessions/${enc(phone)}/blocked`, {
    method: 'PUT', body: JSON.stringify({ blocked }),
  })

export const setMode = (phone: string, manual: boolean) =>
  api(`/api/client/sessions/${enc(phone)}/mode`, { method: 'PUT', body: JSON.stringify({ manual }) })


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
