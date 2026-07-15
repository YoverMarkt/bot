import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import ordersRouter from '../dist/routes/orders.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'orders-route-test-secret'

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

function token(claims) {
  return jwt.sign(claims, JWT_SECRET)
}

async function dispatch({ authorization, query = {} } = {}) {
  const routeLayer = ordersRouter.stack.find(layer => (
    layer.route?.path === '/api/client/orders' && layer.route?.methods?.get
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: authorization ? { authorization } : {}, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
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

async function dispatchStatus({ authorization, status, id = 'order-a' } = {}) {
  const routeLayer = ordersRouter.stack.find(layer => (
    layer.route?.path === '/api/client/orders/:id/status' && layer.route?.methods?.put
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = {
    headers: authorization ? { authorization } : {},
    body: { status },
    params: { id },
  }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
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

describe('GET /api/client/orders', () => {
  it('rechaza solicitudes sin token', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])

    const response = await dispatch()

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'No autorizado' })
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('usa únicamente el businessId del JWT del dueño', async () => {
    const orders = [{ id: 'order-a', business_id: 'business-a', total: 10 }]
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue(orders)
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    const response = await dispatch({
      authorization,
      query: { businessId: 'business-b' },
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual(orders)
    expect(getOrders).toHaveBeenCalledOnce()
    expect(getOrders).toHaveBeenCalledWith('business-a')
  })

  it('rechaza empleados sin permiso de ventas', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'employee',
      perms: ['citas'],
    })}`

    const response = await dispatch({ authorization })

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'No tienes permiso para esta sección' })
    expect(getOrders).not.toHaveBeenCalled()
  })
})

describe('PUT /api/client/orders/:id/status', () => {
  const authorization = () => `Bearer ${token({
    role: 'client', businessId: 'business-a', urole: 'owner',
  })}`

  it('usa la RPC atómica con el negocio del JWT', async () => {
    const setOrderStatus = vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'updated', order: { id: 'order-a', status: 'completado' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'completado' })

    expect(response).toEqual({
      status: 200, body: { id: 'order-a', status: 'completado' },
    })
    expect(setOrderStatus).toHaveBeenCalledWith('business-a', 'order-a', 'completado')
  })

  it('rechaza estados desconocidos antes de tocar la base', async () => {
    const setOrderStatus = vi.spyOn(db, 'setOrderStatus')

    const response = await dispatchStatus({ authorization: authorization(), status: 'pagado' })

    expect(response.status).toBe(400)
    expect(setOrderStatus).not.toHaveBeenCalled()
  })

  it('devuelve conflicto cuando el pedido ya está en un estado final', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'invalid_transition', order: { id: 'order-a', status: 'cancelado' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'confirmado' })

    expect(response.status).toBe(409)
  })
})
