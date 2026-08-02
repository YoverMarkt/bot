import type { SupabaseClient } from '@supabase/supabase-js'

const db: SupabaseClient = require('../client') as typeof import('../client')

const getBilling = async () => {
  const { data } = await db
    .from('billing')
    .select('*,businesses(name)')
    .order('period_start', { ascending: false })
  return data || []
}

// La RPC usa una clave única auxiliar por negocio/mes. Así, dos instancias del
// servidor pueden ejecutar la tarea al mismo tiempo sin emitir dos cuotas.
const ensureCurrentMonthBilling = async () => (
  db.rpc('ensure_current_month_billing')
)

const updateBillingStatus = async (
  id: string,
  status: unknown,
  paidAt: unknown = null,
) => db.from('billing').update({ status, paid_at: paidAt }).eq('id', id)

export = {
  getBilling,
  ensureCurrentMonthBilling,
  updateBillingStatus,
}
