import type { SupabaseClient } from '@supabase/supabase-js'

type ScheduleData = Record<string, unknown>
type BookingData = Record<string, unknown>

interface BookingRpcResponse {
  result?: 'created' | 'duplicate' | 'conflict'
  booking?: unknown
}

interface ScheduleRecord extends ScheduleData {
  day_of_week: number
  open_time: string
  close_time: string
  slot_duration?: number | null
  is_active?: boolean | null
}

interface OccupiedBooking {
  booking_time: string
  duration_minutes?: number | null
}

const db = require('../client') as SupabaseClient
const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

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

const getBookings = async (
  businessId: string,
  from?: string | null,
  to?: string | null,
) => {
  let query = db
    .from('bookings')
    .select('*')
    .eq('business_id', businessId)
    .order('booking_date')
    .order('booking_time')
  if (from) query = query.gte('booking_date', from)
  if (to) query = query.lte('booking_date', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data || []) as BookingData[]
}

const createBooking = async (businessId: string, data: BookingData) => {
  const safe = { ...data }
  delete safe.id
  delete safe.business_id
  delete safe.created_at

  const parameters = {
    p_business_id: businessId,
    p_contact_phone: safe.contact_phone,
    p_contact_name: safe.contact_name,
    p_service: safe.service,
    p_booking_date: safe.booking_date,
    p_booking_time: safe.booking_time,
    p_duration_minutes: safe.duration_minutes,
    p_notes: safe.notes,
  }
  const { data: rpcData, error } = await db.rpc(
    'create_booking_if_available',
    parameters,
  )
  if (error) {
    return { data: null, error, duplicate: false, conflict: false }
  }

  const result = (rpcData || {}) as BookingRpcResponse
  return {
    data: result.booking || null,
    error: null,
    duplicate: result.result === 'duplicate',
    conflict: result.result === 'conflict',
  }
}

const getBookingById = async (businessId: string, id: string) => {
  const { data, error } = await db
    .from('bookings')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

const updateBookingStatus = async (
  businessId: string,
  id: string,
  status: string,
) => db
  .from('bookings')
  .update({ status })
  .eq('business_id', businessId)
  .eq('id', id)

const getAvailableSlots = async (businessId: string, daysAhead = 7) => {
  const schedule = await getSchedule(businessId)
  if (!schedule.length) return null

  const activeSchedule = schedule.filter(day => day.is_active)
  if (!activeSchedule.length) return null

  const today = new Date()
  const slots: Record<string, { label: string; slots: string[] }> = {}

  for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset += 1) {
    const date = new Date(today)
    date.setDate(today.getDate() + dayOffset)
    const dayOfWeek = date.getDay()
    const dayConfig = activeSchedule.find(day => day.day_of_week === dayOfWeek)
    if (!dayConfig) continue

    const dateString = date.toISOString().split('T')[0]
    const [openHour, openMinute] = dayConfig.open_time.split(':').map(Number)
    const [closeHour, closeMinute] = dayConfig.close_time.split(':').map(Number)
    const duration = dayConfig.slot_duration || 60
    const openMinutes = openHour * 60 + openMinute
    const closeMinutes = closeHour * 60 + closeMinute

    const { data, error } = await db
      .from('bookings')
      .select('booking_time, duration_minutes')
      .eq('business_id', businessId)
      .eq('booking_date', dateString)
      .in('status', ['pending', 'confirmed'])
    if (error) throw new Error(error.message)
    const booked = (data || []) as OccupiedBooking[]
    const occupied = booked.map((booking) => {
      const [hour, minute] = booking.booking_time.split(':').map(Number)
      const start = hour * 60 + minute
      return [start, start + (booking.duration_minutes || duration)]
    })
    const isFree = (minute: number) => !occupied.some(
      ([start, end]) => minute < end && start < minute + duration,
    )

    const daySlots: string[] = []
    for (
      let minute = openMinutes;
      minute + duration <= closeMinutes;
      minute += duration
    ) {
      if (!isFree(minute)) continue
      if (
        dayOffset === 0
        && minute <= today.getHours() * 60 + today.getMinutes()
      ) continue

      const hour = String(Math.floor(minute / 60)).padStart(2, '0')
      const minutes = String(minute % 60).padStart(2, '0')
      daySlots.push(`${hour}:${minutes}`)
    }

    if (daySlots.length) {
      const label = dayOffset === 0
        ? 'Hoy'
        : dayOffset === 1
          ? 'Mañana'
          : `${DAYS_ES[dayOfWeek]} ${date.getDate()}/${date.getMonth() + 1}`
      slots[dateString] = { label, slots: daySlots }
    }
  }

  return Object.keys(slots).length ? slots : null
}

export = {
  getSchedule,
  upsertSchedule,
  getBookings,
  createBooking,
  getBookingById,
  updateBookingStatus,
  getAvailableSlots,
}
