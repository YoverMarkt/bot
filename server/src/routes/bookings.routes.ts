import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'
import { sendToContact, type BusinessRecord } from '../services/notify'

type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'no_show'

interface DatabaseResult {
  error?: { message?: string } | null
}

interface BookingRecord {
  id: string
  business_id: string
  contact_phone: string | null
  booking_date: string
  booking_time: string | null
  service: string | null
}

type Business = BusinessRecord & {
  id: string
  name: string
  type?: string | null
  takes_bookings?: boolean | null
}

const db = require('../db') as {
  getSchedule(businessId: string): Promise<unknown>
  upsertSchedule(businessId: string, days: unknown): Promise<DatabaseResult>
  getBookings(businessId: string, from: unknown, to: unknown): Promise<unknown>
  getBookingById(businessId: string, bookingId: string): Promise<BookingRecord | null>
  updateBookingStatus(
    businessId: string,
    bookingId: string,
    status: BookingStatus,
  ): Promise<DatabaseResult>
  getBusinessById(businessId: string): Promise<Business>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'owner',
    content: string,
  ): Promise<unknown>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}

const router = createRouter()
const canManageBookings = auth.requirePermission('citas')
const requireBookingCapability: RequestHandler = (req, res, next) => {
  const user = req.user as Express.ClientUserClaims | undefined
  if (user?.takesBookings === true) return next()
  return res.status(403).json({ error: 'Este negocio no tiene reservas habilitadas' })
}
const bookingStatuses: BookingStatus[] = ['pending', 'confirmed', 'cancelled', 'no_show']

function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && bookingStatuses.includes(value as BookingStatus)
}

router.get('/api/client/schedule', auth.authClient, canManageBookings, async (req, res) => {
  res.json(await db.getSchedule(getClientBusinessId(req)))
})

router.put('/api/client/schedule', auth.authClient, canManageBookings, async (req, res) => {
  const { error } = await db.upsertSchedule(getClientBusinessId(req), req.body.days)
  if (error) {
    console.error('❌ actualizar horarios:', error.message || 'Error desconocido')
    return res.status(500).json({ error: 'No se pudieron actualizar los horarios' })
  }
  res.json({ ok: true })
})

router.get('/api/client/bookings', auth.authClient, canManageBookings, requireBookingCapability, async (req, res) => {
  res.json(await db.getBookings(
    getClientBusinessId(req),
    req.query.from,
    req.query.to,
  ))
})

router.put(
  '/api/client/bookings/:id/status',
  auth.authClient,
  canManageBookings,
  requireBookingCapability,
  async (req, res) => {
    const { status } = req.body as { status?: unknown }
    if (!isBookingStatus(status)) {
      return res.status(400).json({ error: 'Estado inválido' })
    }

    try {
      const businessId = getClientBusinessId(req)
      const booking = await db.getBookingById(businessId, req.params.id)
      if (!booking || booking.business_id !== businessId) {
        return res.status(404).json({ error: 'Reserva no encontrada' })
      }

      const { error } = await db.updateBookingStatus(
        businessId,
        req.params.id,
        status,
      )
      if (error) {
        console.error('❌ actualizar reserva:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No se pudo actualizar la reserva' })
      }

      if (booking.contact_phone) {
        const business = await db.getBusinessById(businessId)
        const isLodging = /hotel|hostal|alojamiento/i.test(business.type || '')
        const bookingName = isLodging ? 'reserva' : 'cita'
        const date = booking.booking_date
        const time = (booking.booking_time || '').slice(0, 5)
        const service = booking.service ? ` de *${booking.service}*` : ''
        let message: string | null = null

        if (status === 'confirmed') {
          message = `✅ ¡Tu ${bookingName}${service} quedó *confirmada* para el ${date} a las ${time}! Te esperamos en ${business.name} 😊`
        } else if (status === 'cancelled') {
          message = `⚠️ Lamentamos informarte que tu ${bookingName}${service} del ${date} a las ${time} fue *cancelada*. Si deseas, podemos agendarte en otro horario disponible. Escríbenos cuándo te conviene 🙏`
        }

        if (message) {
          void sendToContact(business, booking.contact_phone, message)
            .then(() => db.saveMessage(business.id, booking.contact_phone as string, 'owner', message))
            .catch((error: Error) => console.error('❌ Notificación de reserva:', error.message))
        }
      }

      res.json({ ok: true })
    } catch (error) {
      console.error(
        '❌ actualizar reserva:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      res.status(500).json({ error: 'No se pudo actualizar la reserva' })
    }
  },
)

export = router
