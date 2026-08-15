// ── API de facturación (routes/admin.routes.js) ─────────────────────
import { api } from '../../api/client'

export type BillingRow = {
  id: string
  business_id: string
  amount: number | string
  // `amount` es la CUOTA del servicio; la comisión de las ventas va aparte.
  // El total de la factura es la suma de las dos.
  commission_amount?: number | string | null
  commission_orders?: number | null
  status: 'pending' | 'paid' | 'overdue'
  period_start: string | null
  period_end: string | null
  paid_at: string | null
  notes: string | null
  businesses?: { name: string } | null
}

export const getBilling = () => api<BillingRow[]>('/api/admin/billing')

export const markPaid = (id: string) =>
  api(`/api/admin/billing/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'paid' }),
  })
