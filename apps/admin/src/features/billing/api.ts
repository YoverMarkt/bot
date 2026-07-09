// ── API de facturación (routes/admin.routes.js) ─────────────────────
import { api } from '../../api/client'

export type BillingRow = {
  id: string
  business_id: string
  amount: number | string
  status: 'pending' | 'paid' | 'overdue'
  period_start: string | null
  period_end: string | null
  paid_at: string | null
  notes: string | null
  businesses?: { name: string } | null
}

export const getBilling = () => api<BillingRow[]>('/api/admin/billing')

export const createBilling = (p: {
  business_id: string
  amount: number
  status: string
  period_start: string | null
  period_end: string | null
  notes: string | null
}) => api<BillingRow>('/api/admin/billing', { method: 'POST', body: JSON.stringify(p) })

export const markPaid = (id: string) =>
  api(`/api/admin/billing/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString() }),
  })
