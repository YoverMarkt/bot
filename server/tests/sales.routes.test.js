import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import salesRouter from '../dist/routes/sales.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'sales-routes-test-secret'

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
  const token = jwt.sign({
    role: 'client',
    businessId: 'business-a',
    userId: 'user-a',
    urole: 'owner',
    ...claims,
  }, JWT_SECRET)
  return `Bearer ${token}`
}

async function dispatch(method, path, { auth, body = {}, query = {}, params = {} } = {}) {
  const routeLayer = salesRouter.stack.find(layer => (
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

describe('rutas de ventas', () => {
  it('protege los cuatro endpoints con autenticación y permiso ventas', async () => {
    const routes = [
      ['get', '/api/client/sessions/:phone/quote'],
      ['post', '/api/client/sales'],
      ['post', '/api/client/sales/:id/void'],
      ['get', '/api/client/sales'],
    ]
    for (const [method, path] of routes) {
      const layer = salesRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      ))
      expect(layer.route.stack).toHaveLength(3)
    }

    expect((await dispatch('get', '/api/client/sales')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: ['citas'] })
    expect((await dispatch('get', '/api/client/sales', { auth: employee })).status).toBe(403)
  })

  it('prellena desde el pedido final y catálogo del negocio autenticado', async () => {
    vi.spyOn(db, 'getProducts').mockResolvedValue([
      { id: 'product-1', name: 'Perfume', price: '100', price_sale: '80' },
    ])
    vi.spyOn(db, 'getSession').mockResolvedValue({ contact_name: 'Ana' })
    vi.spyOn(db, 'getOrders').mockResolvedValue([
      {
        contact_phone: '+593999000001',
        status: 'confirmado',
        order_items: [{
          product_id: 'product-1', product_name: 'Perfume', unit_price: '80', quantity: '2',
        }],
      },
    ])

    const response = await dispatch('get', '/api/client/sessions/:phone/quote', {
      auth: authorization(),
      params: { phone: encodeURIComponent('+593999000001') },
      query: { businessId: 'business-b' },
    })

    expect(response.body).toEqual({
      contact_name: 'Ana',
      products: [{ id: 'product-1', name: 'Perfume', price: 80 }],
      suggested: [{
        product_id: 'product-1', product_name: 'Perfume', unit_price: 80, quantity: 2,
      }],
    })
    expect(db.getProducts).toHaveBeenCalledWith('business-a')
    expect(db.getSession).toHaveBeenCalledWith('business-a', '+593999000001')
    expect(db.getOrders).toHaveBeenCalledWith('business-a', 100)
  })

  it('rechaza ventas sin ítems antes de escribir', async () => {
    const createSale = vi.spyOn(db, 'createSaleWithItems').mockResolvedValue({
      data: null, error: null,
    })

    const response = await dispatch('post', '/api/client/sales', {
      auth: authorization(), body: { items: [] },
    })

    expect(response).toEqual({
      status: 400, body: { error: 'La venta necesita al menos un ítem' },
    })
    expect(createSale).not.toHaveBeenCalled()
  })

  it('descarta precios del navegador y registra solo productos/cantidades en la RPC', async () => {
    const sale = { id: 'sale-a', total: 20.42, status: 'completada' }
    const createSale = vi.spyOn(db, 'createSaleWithItems').mockResolvedValue({
      data: sale, error: null,
    })
    const upsertSession = vi.spyOn(db, 'upsertSession').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/client/sales', {
      auth: authorization(),
      body: {
        business_id: 'business-b',
        contact_phone: '+593999000001',
        contact_name: 'Ana',
        items: [
          { product_id: 'p1', product_name: ' A ', quantity: '3', unit_price: '0.10' },
          { product_id: 'p2', product_name: 'B', quantity: '2', unit_price: '10.055' },
        ],
      },
    })

    const items = [
      { product_id: 'p1', quantity: 3 },
      { product_id: 'p2', quantity: 2 },
    ]
    expect(response.status).toBe(201)
    expect(createSale).toHaveBeenCalledWith({
      business_id: 'business-a',
      contact_phone: '+593999000001',
      contact_name: 'Ana',
      created_by: 'user-a',
    }, items)
    expect(upsertSession).toHaveBeenCalledWith(
      'business-a', '+593999000001', { unread_owner: false },
    )
    expect(response.body).toEqual(sale)
  })

  it('no actualiza la sesión cuando la transacción devuelve un error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'createSaleWithItems').mockResolvedValue({
      data: null, error: { message: 'fallo transacción' },
    })
    const upsertSession = vi.spyOn(db, 'upsertSession').mockResolvedValue({})

    const response = await dispatch('post', '/api/client/sales', {
      auth: authorization(),
      body: { items: [{ product_id: 'p1', product_name: 'Producto', quantity: 1, unit_price: 5 }] },
    })

    expect(response).toEqual({
      status: 500, body: { error: 'No se pudo registrar la venta' },
    })
    expect(JSON.stringify(response.body)).not.toContain('transacción')
    expect(upsertSession).not.toHaveBeenCalled()
  })

  it('no necesita rollback compensatorio si la RPC lanza una excepción', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'createSaleWithItems').mockRejectedValue(
      new Error('conexión interrumpida'),
    )
    const upsertSession = vi.spyOn(db, 'upsertSession').mockResolvedValue({})

    const response = await dispatch('post', '/api/client/sales', {
      auth: authorization(),
      body: {
        contact_phone: '+593999000001',
        items: [{ product_id: 'p1', product_name: 'Producto', quantity: 1, unit_price: 5 }],
      },
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo registrar la venta' },
    })
    expect(upsertSession).not.toHaveBeenCalled()
  })

  it('anula y consulta ventas usando únicamente el negocio del JWT', async () => {
    const voidSale = vi.spyOn(db, 'voidSale').mockResolvedValue({ error: null })
    const getSales = vi.spyOn(db, 'getSalesByContact').mockResolvedValue([{ id: 'sale-a' }])
    const auth = authorization()

    await dispatch('post', '/api/client/sales/:id/void', {
      auth, params: { id: 'sale-a' }, body: { businessId: 'business-b' },
    })
    const empty = await dispatch('get', '/api/client/sales', { auth })
    const listed = await dispatch('get', '/api/client/sales', {
      auth,
      query: { phone: encodeURIComponent('+593999000001'), businessId: 'business-b' },
    })

    expect(voidSale).toHaveBeenCalledWith('business-a', 'sale-a')
    expect(empty.body).toEqual([])
    expect(getSales).toHaveBeenCalledOnce()
    expect(getSales).toHaveBeenCalledWith('business-a', '+593999000001')
    expect(listed.body).toEqual([{ id: 'sale-a' }])
  })

  it('no confirma una anulación rechazada por Supabase', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'voidSale').mockResolvedValue({
      error: { message: 'detalle interno PostgreSQL' },
    })

    const response = await dispatch('post', '/api/client/sales/:id/void', {
      auth: authorization(), params: { id: 'sale-a' },
    })

    expect(response).toEqual({
      status: 500, body: { error: 'No se pudo anular la venta' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })
})
