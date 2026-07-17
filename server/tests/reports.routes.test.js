import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import reportsRouter from '../dist/routes/reports.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const reports = require('../dist/services/reports')
const JWT_SECRET = 'reports-route-test-secret'

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

async function dispatch(path, { auth, query = {} } = {}) {
  const routeLayer = reportsRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.get
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, query }
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

describe('rutas de reportes', () => {
  it('protege los seis endpoints con autenticación y permiso de reportes', async () => {
    const paths = [
      '/api/client/pending-orders',
      '/api/client/reports',
      '/api/client/customers',
      '/api/client/inactive-contacts',
      '/api/client/alerts',
      '/api/client/dashboard',
    ]

    for (const path of paths) {
      const route = reportsRouter.stack.find(layer => layer.route?.path === path)
      expect(route.route.stack).toHaveLength(3)
    }

    expect((await dispatch('/api/client/reports')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: ['citas'] })
    expect((await dispatch('/api/client/reports', { auth: employee })).status).toBe(403)
  })

  it('ignora businessId externo y normaliza periodos inválidos', async () => {
    const getAllReports = vi.spyOn(reports, 'getAllReports').mockResolvedValue({ ok: true })

    const response = await dispatch('/api/client/reports', {
      auth: authorization(),
      query: { period: 'anual', businessId: 'business-b' },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(getAllReports).toHaveBeenCalledWith('business-a', 'mes')
  })

  it('conserva periodo válido y businessId del JWT en el dashboard', async () => {
    const getDashboard = vi.spyOn(reports, 'getDashboard').mockResolvedValue({ total: 25 })

    await dispatch('/api/client/dashboard', {
      auth: authorization(),
      query: { period: 'semana' },
    })

    expect(getDashboard).toHaveBeenCalledWith('business-a', 'semana')
  })

  it('normaliza días y filtra pendientes, clientes y contactos por negocio', async () => {
    const getPendingOrders = vi.spyOn(db, 'getPendingOrders').mockResolvedValue([])
    const getCustomerDirectory = vi.spyOn(reports, 'getCustomerDirectory').mockResolvedValue([])
    const getInactiveContacts = vi.spyOn(reports, 'getInactiveContacts').mockResolvedValue([])
    const auth = authorization()

    await dispatch('/api/client/pending-orders', { auth })
    await dispatch('/api/client/customers', { auth })
    await dispatch('/api/client/inactive-contacts', { auth, query: { days: '-3' } })

    expect(getPendingOrders).toHaveBeenCalledWith('business-a')
    expect(getCustomerDirectory).toHaveBeenCalledWith('business-a')
    expect(getInactiveContacts).toHaveBeenCalledWith('business-a', 1)
  })

  it('no expone detalles internos cuando fallan las alertas', async () => {
    vi.spyOn(reports, 'computeAlerts').mockRejectedValue(new Error('detalle interno de BD'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await dispatch('/api/client/alerts', { auth: authorization() })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudieron cargar las alertas' },
    })
  })

  it('registra fallos internos y devuelve mensajes genéricos en todos los reportes', async () => {
    const internalError = new Error('detalle interno de PostgreSQL')
    vi.spyOn(db, 'getPendingOrders').mockRejectedValue(internalError)
    vi.spyOn(reports, 'getAllReports').mockRejectedValue(internalError)
    vi.spyOn(reports, 'getCustomerDirectory').mockRejectedValue(internalError)
    vi.spyOn(reports, 'getInactiveContacts').mockRejectedValue(internalError)
    vi.spyOn(reports, 'computeAlerts').mockRejectedValue(internalError)
    vi.spyOn(reports, 'getDashboard').mockRejectedValue(internalError)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const auth = authorization()

    const responses = await Promise.all([
      dispatch('/api/client/pending-orders', { auth }),
      dispatch('/api/client/reports', { auth }),
      dispatch('/api/client/customers', { auth }),
      dispatch('/api/client/inactive-contacts', { auth }),
      dispatch('/api/client/alerts', { auth }),
      dispatch('/api/client/dashboard', { auth }),
    ])

    expect(responses).toEqual([
      { status: 500, body: { error: 'No se pudieron cargar los pedidos pendientes' } },
      { status: 500, body: { error: 'No se pudieron cargar los reportes' } },
      { status: 500, body: { error: 'No se pudo cargar el directorio de clientes' } },
      { status: 500, body: { error: 'No se pudieron cargar los contactos inactivos' } },
      { status: 500, body: { error: 'No se pudieron cargar las alertas' } },
      { status: 500, body: { error: 'No se pudo cargar el dashboard' } },
    ])
    expect(responses.every(response => (
      !JSON.stringify(response.body).includes('PostgreSQL')
    ))).toBe(true)
    expect(log).toHaveBeenCalledTimes(6)
    expect(log.mock.calls.every(call => call[1] === internalError.message)).toBe(true)
  })
})
