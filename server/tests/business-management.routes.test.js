import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import managementRouter from '../dist/routes/business-management.routes.js'

const require = createRequire(import.meta.url)
const bcrypt = require('bcryptjs')
const db = require('../dist/db')
const JWT_SECRET = 'business-management-test-secret'

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

async function dispatch(method, path, { auth, body = {}, query = {}, params = {} } = {}) {
  const routeLayer = managementRouter.stack.find(layer => (
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

describe('onboarding y equipo del negocio', () => {
  it('protege seis endpoints y reserva la gestión del equipo para el dueño', async () => {
    const routes = [
      ['get', '/api/client/onboarding', 2],
      ['get', '/api/client/users', 3],
      ['post', '/api/client/users', 3],
      ['put', '/api/client/users/:id', 3],
      ['delete', '/api/client/users/:id', 3],
      ['get', '/api/client/supabase-config', 2],
    ]
    for (const [method, path, handlers] of routes) {
      const layer = managementRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      ))
      expect(layer.route.stack).toHaveLength(handlers)
    }

    expect((await dispatch('get', '/api/client/onboarding')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: ['reportes'] })
    expect((await dispatch('get', '/api/client/users', { auth: employee })).status).toBe(403)
  })

  it('calcula onboarding únicamente con datos del negocio autenticado', async () => {
    vi.spyOn(db, 'countProducts').mockResolvedValue(2)
    vi.spyOn(db, 'getPolicies').mockResolvedValue({
      bot_prompt: 'Prompt listo',
      shipping: 'Envíos nacionales',
    })
    vi.spyOn(db, 'getSchedule').mockResolvedValue([{ is_active: true }])
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      hours: '09:00-18:00',
      whatsapp_number: '+593999000001',
    })

    const response = await dispatch('get', '/api/client/onboarding', {
      auth: authorization(),
      query: { businessId: 'business-b' },
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ done: 5, total: 5, pct: 100 })
    for (const method of ['countProducts', 'getPolicies', 'getSchedule', 'getBusinessById']) {
      expect(db[method]).toHaveBeenCalledWith('business-a')
    }
  })

  it('mantiene desactivada la configuración Supabase del frontend', async () => {
    const response = await dispatch('get', '/api/client/supabase-config', {
      auth: authorization(),
    })

    expect(response).toEqual({ status: 200, body: {} })
  })

  it('valida, filtra permisos y cifra la contraseña al crear un empleado', async () => {
    const hash = vi.spyOn(bcrypt, 'hash').mockResolvedValue('password-hash')
    const createClientUser = vi.spyOn(db, 'createClientUser').mockResolvedValue({
      data: { id: 'user-1' },
      error: null,
    })
    const auth = authorization()

    const missing = await dispatch('post', '/api/client/users', {
      auth,
      body: { email: 'empleado@example.com' },
    })
    const weak = await dispatch('post', '/api/client/users', {
      auth,
      body: { email: 'empleado@example.com', password: 'corta' },
    })
    const created = await dispatch('post', '/api/client/users', {
      auth,
      body: {
        email: ' empleado@example.com ',
        password: 'clave-segura',
        name: 'Empleado',
        permissions: ['citas', 'ventas', 'hospedaje', 'admin', 10],
        businessId: 'business-b',
      },
    })

    expect(missing.status).toBe(400)
    expect(weak).toEqual({
      status: 400,
      body: { error: 'La contraseña debe tener al menos 12 caracteres' },
    })
    expect(created).toEqual({ status: 201, body: { id: 'user-1' } })
    expect(hash).toHaveBeenCalledWith('clave-segura', 10)
    expect(createClientUser).toHaveBeenCalledWith({
      business_id: 'business-a',
      email: 'empleado@example.com',
      password_hash: 'password-hash',
      name: 'Empleado',
      role: 'employee',
      permissions: ['citas', 'ventas', 'hospedaje'],
    })
  })

  it('actualiza y elimina empleados dentro del negocio del JWT', async () => {
    vi.spyOn(bcrypt, 'hash').mockResolvedValue('new-password-hash')
    const updateClientUserById = vi.spyOn(db, 'updateClientUserById').mockResolvedValue({})
    const deleteClientUserById = vi.spyOn(db, 'deleteClientUserById').mockResolvedValue({})
    const auth = authorization()

    await dispatch('put', '/api/client/users/:id', {
      auth,
      params: { id: 'employee-1' },
      body: {
        email: ' nuevo@example.com ',
        password: 'nueva-clave-segura',
        permissions: ['catalogo', 'owner'],
      },
    })
    await dispatch('delete', '/api/client/users/:id', {
      auth,
      params: { id: 'employee-1' },
    })

    expect(updateClientUserById).toHaveBeenCalledWith('business-a', 'employee-1', {
      email: 'nuevo@example.com',
      password_hash: 'new-password-hash',
      permissions: ['catalogo'],
    })
    expect(deleteClientUserById).toHaveBeenCalledWith('business-a', 'employee-1')
  })
})
