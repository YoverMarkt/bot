import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import clientsRouter from '../dist/routes/admin-clients.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const bcrypt = require('bcryptjs')
const JWT_SECRET = 'admin-clients-test-secret'
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

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, businessId: 'business-a' }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = clientsRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
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

describe('clientes y onboarding del superadmin', () => {
  it('protege sus 14 endpoints exclusivamente con autenticación admin', async () => {
    expect(clientsRouter.stack).toHaveLength(14)
    expect(clientsRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('get', '/api/admin/clients')).status).toBe(401)
    expect((await dispatch('get', '/api/admin/clients', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  it('devuelve el detalle sin credenciales y con su estado de configuración', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', name: 'Mas Pura', ycloud_api_key: 'ycloud-secret',
      meta_token: 'meta-secret', kapso_verify_token: '',
    })
    vi.spyOn(db, 'getClientUserByBusiness').mockResolvedValue({ email: 'owner@example.com' })

    const response = await dispatch('get', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
    })

    expect(response.body).toMatchObject({
      id: 'business-a',
      client_email: 'owner@example.com',
      credential_status: {
        ycloud_api_key: true,
        meta_token: true,
        kapso_verify_token: false,
      },
    })
    expect(JSON.stringify(response.body)).not.toContain('ycloud-secret')
    expect(JSON.stringify(response.body)).not.toContain('meta-secret')
  })

  it('crea negocio, políticas, usuario y facturación sin exponer secretos', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-new', name: 'Nueva', ycloud_api_key: 'secret' },
      error: null,
    })

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: ' Nueva ', whatsapp_number: ' +593999 ', monthly_rate: '30',
        client_email: 'owner@example.com', client_password: 'safe-password',
        ycloud_api_key: 'secret',
        lodging_enabled: true,
      },
    })

    expect(response.status).toBe(201)
    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Nueva', whatsapp_number: '+593999', lodging_enabled: true,
      }),
      'owner@example.com',
      expect.any(String),
      30,
    )
    const passwordHash = createOnboarding.mock.calls[0][2]
    expect(passwordHash).not.toBe('safe-password')
    expect(await bcrypt.compare('safe-password', passwordHash)).toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('secret')
  })

  it('no ejecuta escrituras compensatorias si la RPC atómica rechaza el onboarding', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      error: { message: 'detalle interno PostgreSQL' },
    })
    const cleanup = vi.spyOn(db, 'deleteBusiness')

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva',
        whatsapp_number: '+593999',
        monthly_rate: '30',
        client_email: 'owner@example.com',
        client_password: 'safe-password',
        ycloud_api_key: 'secret',
      },
    })

    expect(cleanup).not.toHaveBeenCalled()
    expect(response).toEqual({
      status: 500, body: { error: 'No se pudo crear el cliente' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })

  it('rechaza credenciales incompletas antes de invocar la base', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding')

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva', whatsapp_number: '+593999',
        client_email: 'owner@example.com',
      },
    })

    expect(response).toEqual({
      status: 400,
      body: { error: 'Email y password deben enviarse juntos' },
    })
    expect(createOnboarding).not.toHaveBeenCalled()
  })

  it('rechaza contraseñas nuevas con menos de doce caracteres', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding')

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva',
        whatsapp_number: '+593999',
        client_email: 'owner@example.com',
        client_password: 'corta',
      },
    })

    expect(response).toEqual({
      status: 400,
      body: { error: 'La contraseña debe tener al menos 12 caracteres' },
    })
    expect(createOnboarding).not.toHaveBeenCalled()
  })

  it('acepta un negocio configurado para operar solo por Telegram', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-telegram', name: 'Telegram' }, error: null,
    })

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Telegram', whatsapp_number: '+593000000000', monthly_rate: '20',
        whatsapp_provider: 'telegram', telegram_bot_token: 'bot-token',
        client_email: 'owner@example.com', client_password: 'safe-password',
      },
    })

    expect(response.status).toBe(201)
    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ whatsapp_provider: 'telegram', telegram_bot_token: 'bot-token' }),
      'owner@example.com', expect.any(String), 20,
    )
  })

  it('solo envía campos permitidos y no confirma una facturación rechazada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })
    vi.spyOn(db, 'countBilling').mockResolvedValue(1)
    vi.spyOn(db, 'updatePendingBilling').mockResolvedValue({
      error: { message: 'fallo de base' },
    })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: {
        name: 'Actualizado', monthly_rate: '25', id: 'business-b',
        client_password: 'never-in-business', unknown: 'discard',
      },
    })

    expect(updateBusiness).toHaveBeenCalledWith('business-a', {
      name: 'Actualizado', monthly_rate: 25,
    })
    expect(response).toEqual({
      status: 500, body: { error: 'No se pudo actualizar el cliente' },
    })
  })

  it('explica por qué no puede apagar hospedaje con inventario comprometido', async () => {
    vi.spyOn(db, 'updateBusiness').mockResolvedValue({
      error: {
        message: 'No se puede deshabilitar hospedaje con solicitudes o estadías activas',
      },
    })
    const countBilling = vi.spyOn(db, 'countBilling')

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { lodging_enabled: false },
    })

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'No puedes deshabilitar hospedaje mientras existan solicitudes pendientes o estadías activas.',
      },
    })
    expect(countBilling).not.toHaveBeenCalled()
  })

  it.each([
    ['post', '/api/admin/clients/:id/suspend', 'suspendBusiness'],
    ['post', '/api/admin/clients/:id/reactivate', 'reactivateBusiness'],
    ['put', '/api/admin/clients/:id/policies', 'upsertPolicies'],
  ])('no devuelve éxito cuando %s %s falla', async (method, path, operation) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, operation).mockResolvedValue({ error: { message: 'fallo interno' } })

    const response = await dispatch(method, path, {
      auth: authorization(), params: { id: 'business-a' }, body: {},
    })

    expect(response.status).toBe(500)
    expect(response.body.ok).not.toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('fallo interno')
  })

  it('crea el usuario únicamente dentro del negocio indicado por la ruta', async () => {
    const createClientUser = vi.spyOn(db, 'createClientUser').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/admin/clients/:id/create-user', {
      auth: authorization(), params: { id: 'business-a' },
      body: { business_id: 'business-b', email: 'owner@example.com', password: 'secret-123456' },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(createClientUser).toHaveBeenCalledWith(expect.objectContaining({
      business_id: 'business-a', email: 'owner@example.com',
    }))
  })
})
