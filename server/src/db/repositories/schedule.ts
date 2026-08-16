import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScheduleRecord } from '../types'

// El horario del negocio. Vivía en el repositorio de citas, pero NO es de
// citas: es lo que decide si la tienda está abierta y si el bot atiende
// (`services/schedule.ts`). Al retirar la agenda se mudó aquí, que es donde
// debió estar desde el principio — un negocio de domicilios sin agenda sigue
// teniendo horario de atención.
type ScheduleData = Record<string, unknown>

const db: SupabaseClient = require('../client') as typeof import('../client')

const getSchedule = async (businessId: string) => {
  const { data, error } = await db
    .from('business_schedule')
    .select('*')
    .eq('business_id', businessId)
    .order('day_of_week')
  if (error) throw new Error(error.message)
  return (data || []) as ScheduleRecord[]
}

const upsertSchedule = async (businessId: string, days: ScheduleData[]) => {
  const rows = days.map((day) => {
    const safe = { ...day }
    delete safe.id
    delete safe.business_id
    delete safe.created_at
    return { ...safe, business_id: businessId }
  })
  return db.from('business_schedule').upsert(rows, {
    onConflict: 'business_id,day_of_week',
  })
}

export = {
  getSchedule,
  upsertSchedule,
}
