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

/**
 * Los horarios de VARIOS negocios de una vez.
 *
 * ⚠️ Existe para no hacer una consulta por local (2026-09-03). El menú del
 * marketplace enseña hasta nueve locales por pantalla, y marcar cuáles están
 * cerrados exige su horario: serían nueve consultas cada vez que alguien abre
 * una categoría, en el camino más transitado de la app.
 *
 * ⚠️ Y por eso el estado se calcula luego en TypeScript con
 * `services/schedule.ts`, en vez de resolverlo dentro de una función SQL: la
 * regla de los horarios —cruces de medianoche, turnos solapados, el cierre a
 * las 23:59— ya costó tres fallos en dos días. Tenerla escrita dos veces
 * garantiza que diverjan, y la copia de SQL no la miraría nadie hasta que un
 * cliente se quejara. Una consulta más es barato por una sola implementación.
 */
const getSchedulesFor = async (businessIds: string[]) => {
  const ids = [...new Set((businessIds || []).filter(Boolean))]
  // Sin ids no se pregunta: un `in ()` vacío es una consulta regalada.
  if (!ids.length) return new Map<string, ScheduleRecord[]>()
  const { data, error } = await db
    .from('business_schedule')
    .select('*')
    .in('business_id', ids)
    .order('day_of_week')
  if (error) throw new Error(error.message)
  const porNegocio = new Map<string, ScheduleRecord[]>()
  for (const fila of (data || []) as ScheduleRecord[]) {
    const clave = String((fila as { business_id?: string }).business_id || '')
    if (!clave) continue
    const filas = porNegocio.get(clave)
    if (filas) filas.push(fila)
    else porNegocio.set(clave, [fila])
  }
  return porNegocio
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
  getSchedulesFor,
  upsertSchedule,
}
