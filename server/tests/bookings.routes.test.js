import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import bookingsRouter from '../dist/routes/bookings.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const notify = require('../dist/services/notify')
const JWT_SECRET = 'bookings-route-test-secret'

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function authorization(claims = {}) {
  const signed = jwt.sign({
    role: 'client',
    businessId: 'business-a',
    urole: 'owner',
    takesBookings: true,
    ...claims,
  }, JWT_SECRET)
  return `Bearer ${signed}`
}

async function dispatch(method, path, { auth, body = {}, query = {}, params = {} } = {}) {
  const routeLayer = bookingsRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, query, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(responseBody) { result.body = responseBody; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

describe('rutas de horarios y reservas', () => {
  it('protege los cuatro endpoints con autenticación y permiso de citas', async () => {
    const routes = [
      ['get', '/api/client/schedule'],
      ['put', '/api/client/schedule'],
      ['get', '/api/client/bookings'],
      ['put', '/api/client/bookings/:id/status'],
    ]
    for (const [method, path] of routes) {
      const layer = bookingsRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      ))
      expect(layer.route.stack).toHaveLength(path.includes('bookings') ? 4 : 3)
    }

    expect((await dispatch('get', '/api/client/bookings')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: ['ventas'] })
    expect((await dispatch('get', '/api/client/bookings', { auth: employee })).status).toBe(403)
  })

  it('lee y actualiza horarios usando solo el negocio del JWT', async () => {
    const days = [{ day_of_week: 1, is_active: true }]
    const getSchedule = vi.spyOn(db, 'getSchedule').mockResolvedValue(days)
    const upsertSchedule = vi.spyOn(db, 'upsertSchedule').mockResolvedValue({ error: null })
    const auth = authorization()

    const read = await dispatch('get', '/api/client/schedule', {
      auth,
      query: { businessId: 'business-b' },
    })
    const update = await dispatch('put', '/api/client/schedule', {
      auth,
      body: { businessId: 'business-b', days },
    })

    expect(read.body).toEqual(days)
    expect(update.body).toEqual({ ok: true })
    expect(getSchedule).toHaveBeenCalledWith('business-a')
    expect(upsertSchedule).toHaveBeenCalledWith('business-a', days)
  })

  it('mantiene horarios para todos pero bloquea reservas en modo normal', async () => {
    const getSchedule = vi.spyOn(db, 'getSchedule').mockResolvedValue([])
    const getBookings = vi.spyOn(db, 'getBookings').mockResolvedValue([])
    const auth = authorization({ takesBookings: false })

    const schedule = await dispatch('get', '/api/client/schedule', { auth })
    const bookings = await dispatch('get', '/api/client/bookings', { auth })

    expect(schedule).toEqual({ status: 200, body: [] })
    expect(bookings).toEqual({
      status: 403,
      body: { error: 'Este negocio no tiene reservas habilitadas' },
    })
    expect(getSchedule).toHaveBeenCalledWith('business-a')
    expect(getBookings).not.toHaveBeenCalled()
  })

  it('lista reservas con rango y negocio provenientes del request correcto', async () => {
    const getBookings = vi.spyOn(db, 'getBookings').mockResolvedValue([])

    await dispatch('get', '/api/client/bookings', {
      auth: authorization(),
      query: { from: '2026-07-01', to: '2026-07-31', businessId: 'business-b' },
    })

    expect(getBookings).toHaveBeenCalledWith('business-a', '2026-07-01', '2026-07-31')
  })

  it('no confirma horarios rechazados por Supabase ni filtra su error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'upsertSchedule').mockResolvedValue({
      error: { message: 'detalle interno PostgreSQL' },
    })

    const response = await dispatch('put', '/api/client/schedule', {
      auth: authorization(), body: { days: [] },
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudieron actualizar los horarios' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })

  it('rechaza un estado inválido antes de consultar la reserva', async () => {
    const getBookingById = vi.spyOn(db, 'getBookingById').mockResolvedValue(null)

    const response = await dispatch('put', '/api/client/bookings/:id/status', {
      auth: authorization(),
      params: { id: 'booking-1' },
      body: { status: 'deleted' },
    })

    expect(response).toEqual({ status: 400, body: { error: 'Estado inválido' } })
    expect(getBookingById).not.toHaveBeenCalled()
  })

  it('impide modificar una reserva de otro negocio', async () => {
    const getBooking = vi.spyOn(db, 'getBookingById').mockResolvedValue({
      id: 'booking-b',
      business_id: 'business-b',
      contact_phone: '+593999000002',
      booking_date: '2026-07-20',
      booking_time: '10:00:00',
      service: 'Consulta',
    })
    const updateBookingStatus = vi.spyOn(db, 'updateBookingStatus').mockResolvedValue({ error: null })
    const sendToContact = vi.spyOn(notify, 'sendToContact').mockResolvedValue(undefined)

    const response = await dispatch('put', '/api/client/bookings/:id/status', {
      auth: authorization(),
      params: { id: 'booking-b' },
      body: { status: 'confirmed' },
    })

    expect(response).toEqual({ status: 404, body: { error: 'Reserva no encontrada' } })
    expect(getBooking).toHaveBeenCalledWith('business-a', 'booking-b')
    expect(updateBookingStatus).not.toHaveBeenCalled()
    expect(sendToContact).not.toHaveBeenCalled()
  })

  it('confirma una reserva propia y registra la notificación simulada', async () => {
    const booking = {
      id: 'booking-a',
      business_id: 'business-a',
      contact_phone: '+593999000001',
      booking_date: '2026-07-20',
      booking_time: '10:30:00',
      service: 'Consulta',
    }
    const business = { id: 'business-a', name: 'Clínica Demo' }
    const getBooking = vi.spyOn(db, 'getBookingById').mockResolvedValue(booking)
    const updateBookingStatus = vi.spyOn(db, 'updateBookingStatus').mockResolvedValue({ error: null })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business)
    const saveMessage = vi.spyOn(db, 'saveMessage').mockResolvedValue({})
    const sendToContact = vi.spyOn(notify, 'sendToContact').mockResolvedValue(undefined)

    const response = await dispatch('put', '/api/client/bookings/:id/status', {
      auth: authorization(),
      params: { id: 'booking-a' },
      body: { status: 'confirmed' },
    })
    await new Promise(resolve => setImmediate(resolve))

    const message = '✅ ¡Tu cita de *Consulta* quedó *confirmada* para el 2026-07-20 a las 10:30! Te esperamos en Clínica Demo 😊'
    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(getBooking).toHaveBeenCalledWith('business-a', 'booking-a')
    expect(updateBookingStatus).toHaveBeenCalledWith('business-a', 'booking-a', 'confirmed')
    expect(sendToContact).toHaveBeenCalledWith(business, booking.contact_phone, message)
    expect(saveMessage).toHaveBeenCalledWith('business-a', booking.contact_phone, 'owner', message)
  })

  it('no notifica ni confirma si Supabase rechaza el cambio de estado', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'getBookingById').mockResolvedValue({
      id: 'booking-a', business_id: 'business-a',
      contact_phone: '+593999000001', booking_date: '2026-07-20',
      booking_time: '10:30:00', service: 'Consulta',
    })
    vi.spyOn(db, 'updateBookingStatus').mockResolvedValue({
      error: { message: 'detalle interno PostgreSQL' },
    })
    const sendToContact = vi.spyOn(notify, 'sendToContact')

    const response = await dispatch('put', '/api/client/bookings/:id/status', {
      auth: authorization(), params: { id: 'booking-a' },
      body: { status: 'confirmed' },
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo actualizar la reserva' },
    })
    expect(sendToContact).not.toHaveBeenCalled()
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })
})
