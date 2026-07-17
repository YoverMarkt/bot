import type { SupabaseClient } from '@supabase/supabase-js'

type BillingData = Record<string, unknown>

interface BillingRow extends BillingData {
  business_id: string
  amount: number
  status: 'pending'
  period_start: string
  period_end: string
}

const db = require('../client') as SupabaseClient

const getBilling = async () => {
  const { data } = await db
    .from('billing')
    .select('*,businesses(name)')
    .order('period_start', { ascending: false })
  return data || []
}

const createBilling = async (data: BillingData) => (
  db.from('billing').insert(data).select().single()
)

const createBillingBatch = async (rows: BillingData[]) => (
  db.from('billing').insert(rows)
)

const updateBillingStatus = async (
  id: string,
  status: unknown,
  paidAt: unknown = null,
) => db.from('billing').update({ status, paid_at: paidAt }).eq('id', id)

const countBilling = async (businessId: string) => {
  const { count } = await db
    .from('billing')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
  return count || 0
}

const updatePendingBilling = async (businessId: string, amount: number) => db
  .from('billing')
  .update({ amount })
  .eq('business_id', businessId)
  .eq('status', 'pending')

function generateYearBilling(businessId: string, amount: number): BillingRow[] {
  const rows: BillingRow[] = []
  const now = new Date()
  for (let index = 0; index < 12; index += 1) {
    const year = now.getFullYear() + Math.floor((now.getMonth() + index) / 12)
    const month = (now.getMonth() + index) % 12
    const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const lastDay = new Date(year, month + 1, 0).getDate()
    const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${lastDay}`
    rows.push({
      business_id: businessId,
      amount,
      status: 'pending',
      period_start: periodStart,
      period_end: periodEnd,
    })
  }
  return rows
}

export = {
  getBilling,
  createBilling,
  createBillingBatch,
  updateBillingStatus,
  countBilling,
  updatePendingBilling,
  generateYearBilling,
}
