import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import clientsRouter from '../dist/routes/admin-clients.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const bcrypt = require('bcryptjs')
const JWT_SECRET = 'admin-clients-test-secret'
let originalJwtSecret
let originalYCloudWebhookSecret
let originalYCloudWebhookEndpointId

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  originalYCloudWebhookSecret = process.env.YCLOUD_WEBHOOK_SECRET
  originalYCloudWebhookEndpointId = process.env.YCLOUD_WEBHOOK_ENDPOINT_ID
  process.env.JWT_SECRET = JWT_SECRET
  process.env.YCLOUD_WEBHOOK_SECRET = 'ycloud-signing-secret-test'
  process.env.YCLOUD_WEBHOOK_ENDPOINT_ID = 'ycloud-endpoint-test'
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
  if (originalYCloudWebhookSecret === undefined) delete process.env.YCLOUD_WEBHOOK_SECRET
  else process.env.YCLOUD_WEBHOOK_SECRET = originalYCloudWebhookSecret
  if (originalYCloudWebhookEndpointId === undefined) {
    delete process.env.YCLOUD_WEBHOOK_ENDPOINT_ID
  } else {
    process.env.YCLOUD_WEBHOOK_ENDPOINT_ID = originalYCloudWebhookEndpointId
  }
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
      ycloud_webhook_secret: 'ycloud-signing-secret',
      ycloud_webhook_endpoint_id: 'endpoint-a',
      meta_token: 'meta-secret',
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
        ycloud_webhook_secret: true,
        meta_token: true,
      },
    })
    expect(JSON.stringify(response.body)).not.toContain('ycloud-secret')
    expect(JSON.stringify(response.body)).not.toContain('ycloud-signing-secret')
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
        name: ' Nueva ', whatsapp_number: ' +593999000001 ', monthly_rate: '30',
        client_email: 'owner@example.com', client_password: 'safe-password',
        ycloud_api_key: 'secret',
        ycloud_webhook_endpoint_id: 'endpoint-new',
        ycloud_webhook_secret: 'signing-secret-new',
        lodging_enabled: true,
      },
    })

    expect(response.status).toBe(201)
    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Nueva', whatsapp_number: '+593999000001', lodging_enabled: true,
        ycloud_webhook_endpoint_id: 'endpoint-new',
        ycloud_webhook_secret: 'signing-secret-new',
      }),
      'owner@example.com',
      expect.any(String),
      30,
    )
    const passwordHash = createOnboarding.mock.calls[0][2]
    expect(passwordHash).not.toBe('safe-password')
    expect(await bcrypt.compare('safe-password', passwordHash)).toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('"ycloud_api_key":"secret"')
    expect(JSON.stringify(response.body)).not.toContain('signing-secret-new')
  })

  it('rechaza teléfonos locales antes de crear o actualizar el negocio', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding')
    const updateBusiness = vi.spyOn(db, 'updateBusiness')

    const creation = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva', whatsapp_number: '0999000001', monthly_rate: '30',
        client_email: 'owner@example.com', client_password: 'safe-password',
        ycloud_api_key: 'secret',
      },
    })
    const update = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_number: '0999000001' },
    })

    expect(creation.status).toBe(400)
    expect(update.status).toBe(400)
    expect(creation.body.error).toContain('E.164')
    expect(update.body.error).toContain('E.164')
    expect(createOnboarding).not.toHaveBeenCalled()
    expect(updateBusiness).not.toHaveBeenCalled()
  })

  it('explica que el número de WhatsApp ya es de otro negocio en vez de fallar en genérico', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Negocio ya configurado: la ruta valida el estado final, no solo el formulario
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      name: 'Hostal',
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'clave-ycloud',
      ycloud_webhook_secret: 'secreto-webhook',
      ycloud_webhook_endpoint_id: '6a41a4f44de0392666e757f4',
    })
    vi.spyOn(db, 'updateBusiness').mockResolvedValue({
      error: {
        message: 'duplicate key value violates unique constraint "businesses_whatsapp_number_key"',
      },
    })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_number: '+593991716574' },
    })

    // El número identifica al negocio dentro del bot: la base lo bloquea y el
    // panel debe decir POR QUÉ, no un "no se pudo actualizar" a ciegas
    expect(response.status).toBe(409)
    expect(response.body.error).toContain('ya está asignado a otro negocio')
    expect(response.body.error).not.toContain('duplicate key')
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
        whatsapp_number: '+593999000001',
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
        name: 'Nueva', whatsapp_number: '+593999000001',
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
        whatsapp_number: '+593999000001',
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
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001', ycloud_api_key: 'stored-secret',
    })
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
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001', ycloud_api_key: 'stored-secret',
    })
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

  it('rechaza proveedores no permitidos antes de consultar o modificar el negocio', async () => {
    const getBusiness = vi.spyOn(db, 'getBusinessById')
    const updateBusiness = vi.spyOn(db, 'updateBusiness')

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_provider: 'legacy-provider' },
    })

    expect(response).toEqual({
      status: 400,
      body: { error: 'Proveedor de mensajería no válido' },
    })
    expect(getBusiness).not.toHaveBeenCalled()
    expect(updateBusiness).not.toHaveBeenCalled()
  })

  it('valida un cambio de proveedor con los secretos guardados y el payload nuevo', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001', ycloud_api_key: 'ycloud-stored',
      meta_token: 'meta-stored', meta_phone_id: 'phone-old',
    })
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_provider: 'meta', meta_phone_id: 'phone-new' },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(updateBusiness).toHaveBeenCalledWith('business-a', {
      whatsapp_provider: 'meta', meta_phone_id: 'phone-new',
    })
    expect(JSON.stringify(response.body)).not.toContain('meta-stored')
  })

  it('no cambia a Meta cuando la configuración efectiva no tiene token', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001', ycloud_api_key: 'ycloud-stored',
    })
    const updateBusiness = vi.spyOn(db, 'updateBusiness')

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_provider: 'meta', meta_phone_id: 'phone-new' },
    })

    expect(response.status).toBe(400)
    expect(response.body.error).toContain('Meta requiere Token y Phone ID')
    expect(updateBusiness).not.toHaveBeenCalled()
    expect(JSON.stringify(response.body)).not.toContain('ycloud-stored')
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
