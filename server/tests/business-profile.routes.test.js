import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import profileRouter from '../dist/routes/business-profile.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'business-profile-test-secret'

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
    ...claims,
  }, JWT_SECRET)
  return `Bearer ${signed}`
}

async function dispatch(method, path, { auth, body = {}, query = {} } = {}) {
  const routeLayer = profileRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, query }
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

describe('identidad y políticas del negocio', () => {
  it('protege seis endpoints y reserva las escrituras para el dueño', async () => {
    const routes = [
      ['get', '/api/client/stats', 2],
      ['get', '/api/client/business', 2],
      ['put', '/api/client/business', 3],
      ['get', '/api/client/policies', 3],
      ['put', '/api/client/policies', 3],
      ['put', '/api/client/bot-prompt', 3],
    ]
    for (const [method, path, handlers] of routes) {
      const layer = profileRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      ))
      expect(layer.route.stack).toHaveLength(handlers)
    }

    expect((await dispatch('get', '/api/client/stats')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: [] })
    expect((await dispatch('put', '/api/client/business', { auth: employee })).status).toBe(403)
  })

  it('devuelve únicamente los campos públicos del negocio del JWT', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      name: 'Demo',
      type: 'tienda',
      slogan: 'Compra fácil',
      description: 'Descripción',
      hours: '09:00-18:00',
      address: 'Centro',
      phone: '0999000001',
      social: '@demo',
      payment_methods: 'Efectivo',
      takes_bookings: true,
      takes_orders: false,
      lodging_enabled: true,
      suspended: false,
      bot_active: true,
      ycloud_api_key: 'no-debe-salir',
      meta_token: 'no-debe-salir',
      monthly_rate: 99,
      plan: 'enterprise',
    })

    const response = await dispatch('get', '/api/client/business', {
      auth: authorization(),
      query: { businessId: 'business-b' },
    })

    expect(response.status).toBe(200)
    expect(response.body.id).toBe('business-a')
    expect(response.body).not.toHaveProperty('ycloud_api_key')
    expect(response.body).not.toHaveProperty('meta_token')
    expect(response.body).not.toHaveProperty('monthly_rate')
    expect(response.body).not.toHaveProperty('plan')
    expect(response.body).toMatchObject({
      takes_bookings: true,
      takes_orders: false,
      lodging_enabled: true,
    })
    expect(db.getBusinessById).toHaveBeenCalledWith('business-a')
  })

  it('solo actualiza campos permitidos y usa el negocio del JWT', async () => {
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})

    const response = await dispatch('put', '/api/client/business', {
      auth: authorization(),
      body: {
        name: 'Nuevo nombre',
        slogan: 'Nuevo slogan',
        ycloud_api_key: 'intento-de-cambio',
        plan: 'enterprise',
        businessId: 'business-b',
      },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(updateBusiness).toHaveBeenCalledWith('business-a', {
      name: 'Nuevo nombre',
      slogan: 'Nuevo slogan',
    })
  })

  it('no confirma errores de Supabase al actualizar la identidad', async () => {
    const updateBusiness = vi.spyOn(db, 'updateBusiness')
      .mockResolvedValue({ error: { message: 'detalle interno' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const failed = await dispatch('put', '/api/client/business', {
      auth: authorization(), body: { name: 'Nombre actualizado' },
    })
    expect(failed).toEqual({
      status: 500, body: { error: 'No se pudo actualizar el negocio' },
    })
    expect(JSON.stringify(failed.body)).not.toContain('detalle interno')
    expect(updateBusiness).toHaveBeenCalledWith('business-a', {
      name: 'Nombre actualizado',
    })
  })

  it('lee y guarda políticas únicamente para el negocio autenticado', async () => {
    const policies = { shipping: 'Envíos nacionales' }
    const getPolicies = vi.spyOn(db, 'getPolicies').mockResolvedValue(policies)
    const upsertPolicies = vi.spyOn(db, 'upsertPolicies').mockResolvedValue({})
    const auth = authorization()

    const read = await dispatch('get', '/api/client/policies', { auth })
    await dispatch('put', '/api/client/policies', { auth, body: policies })
    await dispatch('put', '/api/client/bot-prompt', {
      auth,
      body: { bot_prompt: 'Responde brevemente', businessId: 'business-b' },
    })

    expect(read.body).toEqual(policies)
    expect(getPolicies).toHaveBeenCalledWith('business-a')
    expect(upsertPolicies).toHaveBeenNthCalledWith(1, 'business-a', policies)
    expect(upsertPolicies).toHaveBeenNthCalledWith(2, 'business-a', {
      bot_prompt: 'Responde brevemente',
    })
  })
})
