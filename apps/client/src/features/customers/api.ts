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
