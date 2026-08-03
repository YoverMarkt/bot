import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'
import { sendToContact, type BusinessRecord } from '../services/notify'

// «Atendida» es distinto de «confirmada»: confirmar es decir «te espero»,
// atender es que la persona vino. Solo lo segundo es dinero, y solo lo
// segundo genera la venta (lo hace la RPC set_booking_status).
type BookingStatus = 'pending' | 'confirmed' | 'attended' | 'cancelled' | 'no_show'

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

interface ModuloDb {
  getSchedule(businessId: string): Promise<unknown>
  upsertSchedule(businessId: string, days: unknown): Promise<DatabaseResult>
  getBookings(businessId: string, from: unknown, to: unknown): Promise<unknown>
  getBookingById(businessId: string, bookingId: string): Promise<BookingRecord | null>
  updateBookingStatus(
    businessId: string,
    bookingId: string,
    status: BookingStatus,
    price?: number | null,
  ): Promise<{ data?: unknown; error?: { message?: string } | null }>
  getBusinessById(businessId: string): Promise<Business | null>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'owner',
    content: string,
  ): Promise<unknown>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const canManageBookings = auth.requirePermission('citas')
const requireBookingCapability: RequestHandler = (req, res, next) => {
  const user = req.user as Express.ClientUserClaims | undefined
  if (user?.takesBookings === true) return next()
  return res.status(403).json({ error: 'Este negocio no tiene reservas habilitadas' })
}
const bookingStatuses: BookingStatus[] = ['pending', 'confirmed', 'attended', 'cancelled', 'no_show']

function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && bookingStatuses.includes(value as BookingStatus)
}

router.get('/api/client/schedule', auth.authClient, canManageBookings, async (req, res) => {
  res.json(await db.getSchedule(getClientBusinessId(req)))
})

router.put('/api/client/schedule', auth.authClient, canManageBookings, async (req, res) => {
  // `req.body.days` llegaba directo a `upsertSchedule`, que hace `.map()` sobre
  // él. Un cuerpo sin `days` reventaba con «Cannot read properties of undefined»
  // y devolvía 500: un fallo del cliente contado como fallo del servidor, que
  // además ensucia el registro de errores y tapa los de verdad.
  const { days } = (req.body ?? {}) as { days?: unknown }
  if (!Array.isArray(days) || days.length === 0) {
    return res.status(400).json({ error: 'Falta el horario' })
  }
  if (days.length > 7 || days.some(dia => !dia || typeof dia !== 'object')) {
    return res.status(400).json({ error: 'El horario no es válido' })
  }
  const { error } = await db.upsertSchedule(getClientBusinessId(req), days as never)
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
    const { status, price } = req.body as { status?: unknown; price?: unknown }
    if (!isBookingStatus(status)) {
      return res.status(400).json({ error: 'Estado inválido' })
    }
    // El precio solo tiene sentido al atender: es lo que se cobró.
    let importe: number | null = null
    if (price !== undefined && price !== null && price !== '') {
      importe = Number(price)
      if (!Number.isFinite(importe) || importe < 0 || importe > 99999) {
        return res.status(400).json({ error: 'El precio debe estar entre 0 y 99999' })
      }
      importe = Math.round(importe * 100) / 100
    }

    try {
      const businessId = getClientBusinessId(req)
      const booking = await db.getBookingById(businessId, req.params.id)
      if (!booking || booking.business_id !== businessId) {
        return res.status(404).json({ error: 'Reserva no encontrada' })
      }

      const { data, error } = await db.updateBookingStatus(
        businessId,
        req.params.id,
        status,
        importe,
      )
      if (error) {
        console.error('❌ actualizar reserva:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No se pudo actualizar la reserva' })
      }
      const resultado = (data || {}) as { result?: string }
      if (resultado.result === 'not_found') {
        return res.status(404).json({ error: 'Reserva no encontrada' })
      }
      // Una cita cerrada no se reabre: se agenda otra.
      if (resultado.result === 'invalid_transition') {
        return res.status(409).json({ error: 'Esa cita ya está cerrada y no se puede reabrir' })
      }

      if (booking.contact_phone) {
        const business = await db.getBusinessById(businessId)
        // Si el negocio ya no existe, no hay a quién avisar: la reserva queda
        // igual y se omite la notificación en vez de reventar con un 500.
        const isLodging = /hotel|hostal|alojamiento/i.test(business?.type || '')
        const bookingName = isLodging ? 'reserva' : 'cita'
        const date = booking.booking_date
        const time = (booking.booking_time || '').slice(0, 5)
        const service = booking.service ? ` de *${booking.service}*` : ''
        let message: string | null = null

        if (status === 'confirmed') {
          message = `✅ ¡Tu ${bookingName}${service} quedó *confirmada* para el ${date} a las ${time}! Te esperamos en ${business?.name || 'nuestro local'} 😊`
        } else if (status === 'cancelled') {
          message = `⚠️ Lamentamos informarte que tu ${bookingName}${service} del ${date} a las ${time} fue *cancelada*. Si deseas, podemos agendarte en otro horario disponible. Escríbenos cuándo te conviene 🙏`
        }

        // Sin negocio no hay canal por el que avisar. La reserva ya quedó
        // guardada; solo se omite el mensaje al cliente.
        if (message && business) {
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
