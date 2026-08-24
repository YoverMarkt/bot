// ── API de Clientes (tipada sobre reports.js del server) ─────────────
import { api } from '../../api/client'

// Directorio: quien COMPRÓ (tabla sales), con estado calculado
export type Customer = {
  name: string
  phone: string
  orders: number
  total: number
  lastPurchase: string
  daysSince: number
  status: 'nuevo' | 'frecuente' | 'activo' | 'inactivo'
}

// Reactivar: quien lleva tiempo SIN ESCRIBIR (haya comprado o no)
export type InactiveContact = {
  name: string
  phone: string
  daysSince: number
  lastMessageAt?: string
  lastMessage?: string
  hasPurchased: boolean
  orders: number
  total: number
}

export const getCustomers = () => api<Customer[]>('/api/client/customers')

// ── Bloqueo de contactos ────────────────────────────────────────────────────
//
// ⚠️ Vivía en Conversaciones, retirada el 2026-08-23. Se muda aquí porque
// bloquear es una decisión sobre un CLIENTE, no sobre un chat, y porque es la
// única defensa del dueño frente a quien pide para molestar: sin este
// interruptor, `blocked_at` no lo escribe nadie y las comprobaciones que ya
// existen —el 403 de la tienda y el disparador `orders_reject_blocked`— se
// quedan puestas sin poder dispararse nunca.
//
// ⚠️ Lo que HOY no hace: no calla al bot del marketplace. Ese camino no
// consulta el bloqueo, y cerrarlo es una decisión pendiente — con un número
// compartido, «bloqueado por quién» no tiene respuesta hasta que el cliente
// elige local.
export const getBlocked = () => api<string[]>('/api/client/blocked')

/**
 * Bloquear impide PEDIR: `POST /api/store/:slug/orders` responde 403 y el
 * disparador lo rechaza dentro de la misma transacción que la inserción.
 *
 * Al bloqueado NUNCA se le avisa: quien lo hace por molestar busca una
 * reacción, y avisar cuesta justo el mensaje que se está ahorrando.
 */
export const setBlocked = (phone: string, blocked: boolean) =>
  api<{ blocked: boolean }>(`/api/client/blocked/${encodeURIComponent(phone)}`, {
    method: 'PUT', body: JSON.stringify({ blocked }),
  })
export const getInactive = (days: number) => api<InactiveContact[]>(`/api/client/inactive-contacts?days=${days}`)

export const money = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`

// Exportar a Excel/CSV (con BOM para que Excel respete tildes — igual que el panel viejo)
export function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const csv = '﻿' + [headers, ...rows].map(r => r.map(esc).join(';')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
