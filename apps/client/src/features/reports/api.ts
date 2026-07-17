// ── API de Reportes (tipada sobre reports.getAllReports del server) ──
import { api } from '../../api/client'

export type ReportsData = {
  period: string
  summary: { label: string; total: number; orders: number; items: number; avg: number; nuevos: number; recurrentes: number; conversion: number | null }
  trend: { days: number; rows: { date: string; label: string; total: number; orders: number }[]; total: number }
  top: { label: string; rows: { name: string; qty: number; rev: number }[] }
  lowMovement: { label: string; threshold?: number; rows: { name: string; qty: number }[] }
  comparison: { label: string; curTotal: number; curOrders: number; prevTotal: number; prevOrders: number; pct: number | null }
  recurring: { label: string; rows: { name: string; orders: number; total: number }[] }
  lowStock: { rows: { name: string; stock: string }[] }
  pending: { count: number; rows: { name: string; last_message: string }[] }
  bySeller: { label: string; rows: { name: string; total: number }[] }
  mostConsulted: { label: string; rows: { name: string; count: number }[] }
  abandoned: { label: string; rows: { name: string; consultas: number }[] }
  lostCustomers: { label: string; count: number; noRespondio: number; returning: number; nuevos: number; rows: { name: string; returning?: boolean; reason?: string }[] }
  faq: { label: string; analyzed: number; rows: { topic: string; emoji: string; count: number }[] }
  unanswered: { label: string; count: number; unique: number; rows: { question?: string; count: number }[] }
}

export type Alert = { level: 'critical' | 'warning' | 'good' | 'info'; icon: string; text: string }

export const getReports = (period: string) => api<ReportsData>(`/api/client/reports?period=${period}`)
export const getAlerts = () => api<{ count: number; alerts: Alert[] }>('/api/client/alerts')

export const money = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`   // centavos EXACTOS
