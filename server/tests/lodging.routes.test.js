import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import lodgingRouter from '../dist/routes/lodging.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const notify = require('../dist/services/notify')
const JWT_SECRET = 'lodging-route-test-secret'
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
  return `Bearer ${jwt.sign({
    role: 'client',
    businessId: 'business-a',
    userId: 'user-a',
    urole: 'owner',
    lodgingEnabled: true,
    ...claims,
  }, JWT_SECRET)}`
}

async function dispatch(method, path, {
  auth, body = {}, query = {}, params = {},
} = {}) {
  const routeLayer = lodgingRouter.stack.find(layer => (
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

describe('rutas cliente de hospedaje', () => {
  it('protege todas las rutas con auth, permiso y capacidad independiente', async () => {
    for (const layer of lodgingRouter.stack.filter(item => item.route)) {
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(4)
    }

    expect((await dispatch('get', '/api/client/lodging/settings')).status).toBe(401)
    const withoutPermission = authorization({ urole: 'employee', perms: ['citas'] })
    expect((await dispatch('get', '/api/client/lodging/settings', {
      auth: withoutPermission,
    })).status).toBe(403)
    expect((await dispatch('get', '/api/client/lodging/settings', {
      auth: authorization({ lodgingEnabled: false }),
    })).body).toEqual({ error: 'Este negocio no tiene hospedaje habilitado' })
  })

  it('lee y actualiza settings usando exclusivamente el negocio del JWT', async () => {
    const getSettings = vi.spyOn(db, 'getLodgingSettings').mockResolvedValue({
      business_id: 'business-a', currency: 'USD', hold_minutes: 45,
    })
    const upsert = vi.spyOn(db, 'upsertLodgingSettings').mockResolvedValue({
      data: { business_id: 'business-a', currency: 'USD', hold_minutes: 60 },
      error: null,
    })
    const auth = authorization()

    const read = await dispatch('get', '/api/client/lodging/settings', {
      auth, query: { businessId: 'business-b' },
    })
    const update = await dispatch('put', '/api/client/lodging/settings', {
      auth,
      body: { businessId: 'business-b', currency: 'usd', hold_minutes: 60 },
    })

    expect(read.body).toMatchObject({ business_id: 'business-a', hold_minutes: 45 })
    expect(update.body).toMatchObject({ business_id: 'business-a', hold_minutes: 60 })
    expect(getSettings).toHaveBeenCalledWith('business-a')
    expect(upsert).toHaveBeenCalledWith('business-a', {
      currency: 'USD', hold_minutes: 60,
    })
  })

  it('devuelve configuración operativa completa aunque aún no exista una fila', async () => {
    vi.spyOn(db, 'getLodgingSettings').mockResolvedValue(null)

    const response = await dispatch('get', '/api/client/lodging/settings', {
      auth: authorization(),
    })

    expect(response.body).toEqual({
      currency: 'USD',
      tax_rate: 0,
      service_fee: 0,
      quote_expiry_minutes: 15,
      hold_minutes: 45,
      check_in_time: '15:00',
      check_out_time: '11:00',
      prices_include_tax: true,
    })
  })

  it('normaliza horas TIME de PostgREST y permite guardarlas sin editarlas', async () => {
    vi.spyOn(db, 'getLodgingSettings').mockResolvedValue({
      currency: 'USD', check_in_time: '15:00:00', check_out_time: '11:00:00',
    })
    const upsert = vi.spyOn(db, 'upsertLodgingSettings').mockResolvedValue({
      data: { check_in_time: '15:00', check_out_time: '11:00' }, error: null,
    })
    const auth = authorization()

    const read = await dispatch('get', '/api/client/lodging/settings', { auth })
    const written = await dispatch('put', '/api/client/lodging/settings', {
      auth, body: read.body,
    })

    expect(read.body).toMatchObject({
      check_in_time: '15:00', check_out_time: '11:00',
    })
    expect(written.status).toBe(200)
    expect(written.body).toMatchObject({
      check_in_time: '15:00', check_out_time: '11:00',
    })
    expect(upsert).toHaveBeenCalledWith('business-a', expect.objectContaining({
      check_in_time: '15:00', check_out_time: '11:00',
    }))
  })

  it('rechaza monedas fuera del contrato soportado', async () => {
    const upsert = vi.spyOn(db, 'upsertLodgingSettings')

    const response = await dispatch('put', '/api/client/lodging/settings', {
      auth: authorization(),
      body: { currency: 'JPY' },
    })

    expect(response).toEqual({ status: 400, body: { error: 'Moneda inválida' } })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('valida tipos de habitación antes de escribir y conserva sus modelos de precio', async () => {
    const create = vi.spyOn(db, 'createLodgingRoomType').mockResolvedValue({
      data: { id: 'room-a' }, error: null,
    })
    const auth = authorization()

    const invalid = await dispatch('post', '/api/client/lodging/room-types', {
      auth,
      body: {
        name: 'Doble', total_units: 5, max_guests: 2,
        pricing_model: 'per_unit', base_rate: null,
      },
    })
    const valid = await dispatch('post', '/api/client/lodging/room-types', {
      auth,
      body: {
        business_id: 'business-b', name: 'Doble', total_units: 5,
        max_guests: 2, base_occupancy: 2, pricing_model: 'per_unit',
        base_rate: 30, weekend_rate: 35, amenities: ['WiFi'],
        media_urls: ['https://cdn.example.com/doble.jpg'],
      },
    })

    expect(invalid).toEqual({
      status: 400,
      body: { error: 'La tarifa base debe ser mayor a cero' },
    })
    expect(valid.status).toBe(201)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('business-a', expect.objectContaining({
      name: 'Doble', total_units: 5, pricing_model: 'per_unit', base_rate: 30,
    }))
  })

  it('normaliza las tarifas manuales al crear y actualizar', async () => {
    const create = vi.spyOn(db, 'createLodgingRoomType').mockResolvedValue({
      data: { id: 'room-manual' }, error: null,
    })
    vi.spyOn(db, 'getLodgingRoomTypeById').mockResolvedValue({
      id: 'room-manual', name: 'Suite', total_units: 2, max_guests: 3,
      base_occupancy: 2, pricing_model: 'per_unit', base_rate: 80,
      weekend_rate: 100, extra_adult_rate: 15, child_rate: 8,
      amenities: [], media_urls: [], active: true,
    })
    const update = vi.spyOn(db, 'updateLodgingRoomType').mockResolvedValue({
      data: { id: 'room-manual' }, error: null,
    })
    const stalePrices = {
      name: 'Suite', total_units: 2, max_guests: 3, base_occupancy: 2,
      pricing_model: 'manual', base_rate: 80, weekend_rate: 100,
      extra_adult_rate: 15, child_rate: 8,
    }

    const created = await dispatch('post', '/api/client/lodging/room-types', {
      auth: authorization(), body: stalePrices,
    })
    const updated = await dispatch('put', '/api/client/lodging/room-types/:id', {
      auth: authorization(), params: { id: 'room-manual' },
      body: { pricing_model: 'manual' },
    })

    expect(created.status).toBe(201)
    expect(updated.status).toBe(200)
    const neutralRates = {
      base_rate: null, weekend_rate: null, extra_adult_rate: 0, child_rate: 0,
    }
    expect(create).toHaveBeenCalledWith(
      'business-a', expect.objectContaining(neutralRates),
    )
    expect(update).toHaveBeenCalledWith(
      'business-a', 'room-manual', expect.objectContaining(neutralRates),
    )
  })

  it('rechaza tarifa de fin de semana igual a cero antes de PostgreSQL', async () => {
    const create = vi.spyOn(db, 'createLodgingRoomType')

    const response = await dispatch('post', '/api/client/lodging/room-types', {
      auth: authorization(),
      body: {
        name: 'Doble', total_units: 2, max_guests: 2,
        pricing_model: 'per_unit', base_rate: 50, weekend_rate: 0,
      },
    })

    expect(response).toEqual({
      status: 400,
      body: { error: 'Tarifa de fin de semana debe ser mayor a cero' },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('guarda de forma idempotente una tarifa para la misma habitación y fecha', async () => {
    const save = vi.spyOn(db, 'createLodgingRateOverride').mockResolvedValue({
      data: { id: 'rate-a', base_rate: 75 }, error: null,
    })
    const body = {
      room_type_id: 'room-a', rate_date: '2026-12-24', base_rate: 75,
      extra_adult_rate: null, child_rate: null, closed: false,
    }

    const first = await dispatch('post', '/api/client/lodging/rate-overrides', {
      auth: authorization(), body,
    })
    const retry = await dispatch('post', '/api/client/lodging/rate-overrides', {
      auth: authorization(), body,
    })

    expect(first.body).toEqual(retry.body)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(1, 'business-a', expect.objectContaining(body))
    expect(save).toHaveBeenNthCalledWith(2, 'business-a', expect.objectContaining(body))
  })

  it('impide editar un tipo de habitación perteneciente a otro negocio', async () => {
    const getRoomType = vi.spyOn(db, 'getLodgingRoomTypeById').mockResolvedValue(null)
    const update = vi.spyOn(db, 'updateLodgingRoomType')

    const response = await dispatch('put', '/api/client/lodging/room-types/:id', {
      auth: authorization(),
      params: { id: 'room-business-b' },
      body: { business_id: 'business-b', name: 'Ajena' },
    })

    expect(response).toEqual({
      status: 404,
      body: { error: 'Tipo de habitación no encontrado' },
    })
    expect(getRoomType).toHaveBeenCalledWith('business-a', 'room-business-b')
    expect(update).not.toHaveBeenCalled()
  })

  it('consulta disponibilidad y devuelve solo totales oficiales de la RPC', async () => {
    const createQuote = vi.spyOn(db, 'createLodgingQuote').mockResolvedValue({
      data: {
        result: 'quoted',
        quote: {
          id: 'quote-a', check_in: '2026-12-24', check_out: '2026-12-27',
          adults: 2, children: 0, rooms_count: 2, nights: 3,
          expires_at: '2099-01-01T00:00:00Z',
        },
        options: [{
          room_type_id: 'room-a', name: 'Doble', max_guests: 2,
          available_units: 2, units_required: 1, pricing_model: 'per_unit',
          currency: 'USD', subtotal: '90.00', tax: '0', fees: '0', total: '90.00',
        }],
      },
      error: null,
    })

    const response = await dispatch('post', '/api/client/lodging/availability', {
      auth: authorization(),
      body: {
        businessId: 'business-b',
        check_in: '2026-12-24', check_out: '2026-12-27',
        adults: 2, children: 0, rooms_count: 2,
      },
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      quoteId: 'quote-a', roomsCount: 2, nights: 3,
      options: [{ roomTypeId: 'room-a', total: 90 }],
    })
    expect(createQuote).toHaveBeenCalledWith(expect.objectContaining({
      business_id: 'business-a', contact_phone: 'panel-preview:user-a', rooms_count: 2,
    }))
  })

  it('cambia estado y crea bloqueos mediante RPC filtradas por tenant', async () => {
    vi.spyOn(db, 'getLodgingRequestById').mockResolvedValue({
      id: 'request-a', business_id: 'business-a', contact_phone: '+593999000001',
      room_type_name: 'Doble', check_in: '2026-12-24', check_out: '2026-12-27',
      total: 90, currency: 'USD', status: 'pending_owner',
    })
    const setStatus = vi.spyOn(db, 'setLodgingRequestStatus').mockResolvedValue({
      data: {
        result: 'updated',
        changed: true,
        request: {
          id: 'request-a', status: 'confirmed', contact_phone: '+593999000001',
          room_type_name: 'Doble', check_in: '2026-12-24', check_out: '2026-12-27',
          total: 90, currency: 'USD',
        },
      },
      error: null,
    })
    const business = { id: 'business-a', name: 'Hostal Demo' }
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business)
    vi.spyOn(db, 'getLodgingSettings').mockResolvedValue({
      check_in_time: '15:00:00', check_out_time: '11:00:00',
    })
    const saveMessage = vi.spyOn(db, 'saveMessage').mockResolvedValue({})
    const send = vi.spyOn(notify, 'sendToContact').mockResolvedValue(undefined)
    const saveBlock = vi.spyOn(db, 'upsertLodgingBlock').mockResolvedValue({
      data: { result: 'created', block: { id: 'block-a' } }, error: null,
    })
    const auth = authorization()

    const status = await dispatch('put', '/api/client/lodging/requests/:id/status', {
      auth, params: { id: 'request-a' }, body: { status: 'confirmed' },
    })
    const block = await dispatch('post', '/api/client/lodging/blocks', {
      auth,
      body: {
        business_id: 'business-b', room_type_id: 'room-a', kind: 'maintenance',
        start_date: '2026-12-24', end_date: '2026-12-27', quantity: 1,
      },
    })
    expect(status.body).toMatchObject({
      request: { id: 'request-a', status: 'confirmed' },
      changed: true,
      notificationSent: true,
    })
    expect(block).toEqual({ status: 201, body: { id: 'block-a' } })
    expect(setStatus).toHaveBeenCalledWith('business-a', 'request-a', 'confirmed')
    expect(saveBlock).toHaveBeenCalledWith('business-a', null, expect.objectContaining({
      room_type_id: 'room-a', kind: 'maintenance', quantity: 1,
    }))
    const message = '✅ Tu solicitud de hospedaje para *Doble*, con entrada el *2026-12-24* desde *15:00* y salida el *2026-12-27* hasta *11:00* en *Hostal Demo* quedó confirmada. Total del alojamiento: *$90.00 USD*. El equipo continuará contigo para coordinar los detalles.'
    expect(send).toHaveBeenCalledWith(business, '+593999000001', message)
    expect(saveMessage).toHaveBeenCalledWith(
      'business-a', '+593999000001', 'owner', message,
    )
  })

  it('conserva la confirmación si WhatsApp falla y lo declara al panel', async () => {
    vi.spyOn(db, 'getLodgingRequestById').mockResolvedValue({
      id: 'request-a', contact_phone: '+593999000001', status: 'pending_owner',
    })
    vi.spyOn(db, 'setLodgingRequestStatus').mockResolvedValue({
      data: {
        result: 'updated', changed: true,
        request: {
          id: 'request-a', contact_phone: '+593999000001', status: 'confirmed',
        },
      },
      error: null,
    })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', name: 'Hostal Demo',
    })
    vi.spyOn(db, 'getLodgingSettings').mockResolvedValue({
      check_in_time: '15:00:00', check_out_time: '11:00:00',
    })
    const save = vi.spyOn(db, 'saveMessage')
    vi.spyOn(notify, 'sendToContact').mockRejectedValue(new Error('canal caído'))

    const response = await dispatch('put', '/api/client/lodging/requests/:id/status', {
      auth: authorization(), params: { id: 'request-a' }, body: { status: 'confirmed' },
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      request: { id: 'request-a', status: 'confirmed' },
      changed: true,
      notificationSent: false,
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('no duplica notificaciones al reintentar el mismo estado', async () => {
    vi.spyOn(db, 'getLodgingRequestById').mockResolvedValue({
      id: 'request-a', contact_phone: '+593999000001', status: 'confirmed',
    })
    vi.spyOn(db, 'setLodgingRequestStatus').mockResolvedValue({
      data: {
        result: 'unchanged', changed: false,
        request: {
          id: 'request-a', contact_phone: '+593999000001', status: 'confirmed',
        },
      },
      error: null,
    })
    const send = vi.spyOn(notify, 'sendToContact')
    const getBusiness = vi.spyOn(db, 'getBusinessById')

    const response = await dispatch('put', '/api/client/lodging/requests/:id/status', {
      auth: authorization(), params: { id: 'request-a' }, body: { status: 'confirmed' },
    })

    expect(response.body).toMatchObject({
      request: { id: 'request-a', status: 'confirmed' },
      changed: false,
      notificationSent: false,
    })
    expect(send).not.toHaveBeenCalled()
    expect(getBusiness).not.toHaveBeenCalled()
  })

  it('expira y libera holds vencidos antes de alimentar la lista pendiente', async () => {
    const expire = vi.spyOn(db, 'expireLodgingHolds').mockResolvedValue({
      data: { result: 'expired', count: 1 }, error: null,
    })
    const getRequests = vi.spyOn(db, 'getLodgingRequests').mockResolvedValue([])

    const response = await dispatch('get', '/api/client/lodging/requests', {
      auth: authorization(), query: { status: 'pending_owner' },
    })

    expect(response).toEqual({ status: 200, body: [] })
    expect(expire).toHaveBeenCalledWith('business-a')
    expect(getRequests).toHaveBeenCalledWith(
      'business-a', 'pending_owner', null, null,
    )
    expect(expire.mock.invocationCallOrder[0]).toBeLessThan(
      getRequests.mock.invocationCallOrder[0],
    )
  })

  it('no avisa una confirmación si el hold venció durante la transición', async () => {
    vi.spyOn(db, 'getLodgingRequestById').mockResolvedValue({
      id: 'request-a', business_id: 'business-a', contact_phone: '+593999000001',
    })
    vi.spyOn(db, 'setLodgingRequestStatus').mockResolvedValue({
      data: { result: 'expired' }, error: null,
    })
    const send = vi.spyOn(notify, 'sendToContact')

    const response = await dispatch('put', '/api/client/lodging/requests/:id/status', {
      auth: authorization(), params: { id: 'request-a' }, body: { status: 'confirmed' },
    })

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'La solicitud venció y ya no se puede confirmar',
        code: 'expired',
      },
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('no permite que CRUD de bloque libere cupos ligados a una solicitud', async () => {
    const release = vi.spyOn(db, 'releaseLodgingBlock').mockResolvedValue({
      data: { result: 'forbidden' }, error: null,
    })

    const response = await dispatch('delete', '/api/client/lodging/blocks/:id', {
      auth: authorization(), params: { id: 'request-block-a' },
    })

    expect(response).toEqual({
      status: 403,
      body: {
        error: 'Los cupos de una solicitud solo se liberan cambiando su estado',
      },
    })
    expect(release).toHaveBeenCalledWith('business-a', 'request-block-a')
  })
})
