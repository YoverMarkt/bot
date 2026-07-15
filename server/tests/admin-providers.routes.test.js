import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import providersRouter from '../dist/routes/admin-providers.routes.js'

const require = createRequire(import.meta.url)
const axios = require('axios')
const db = require('../dist/db')
const JWT_SECRET = 'admin-providers-test-secret'
const originalEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  YCLOUD_API_KEY: process.env.YCLOUD_API_KEY,
  KAPSO_API_KEY: process.env.KAPSO_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  RETELL_API_KEY: process.env.RETELL_API_KEY,
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, businessId: 'business-a' }, JWT_SECRET)}`
}

async function dispatch(path, { auth, body = {}, params = {} } = {}) {
  const layer = providersRouter.stack.find(item => item.route?.path === path)
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

describe('verificación de proveedores del superadmin', () => {
  it('protege ambos endpoints exclusivamente con autenticación admin', async () => {
    expect(providersRouter.stack).toHaveLength(2)
    expect(providersRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('/api/admin/verify-provider')).status).toBe(401)
    expect((await dispatch('/api/admin/verify-provider', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  it('valida campos requeridos sin realizar llamadas externas', async () => {
    delete process.env.YCLOUD_API_KEY
    const get = vi.spyOn(axios, 'get')

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: { provider: 'ycloud' },
    })

    expect(response.body).toEqual({ ok: false, info: 'Falta YCloud API Key' })
    expect(get).not.toHaveBeenCalled()
  })

  it('confirma que el número YCloud pertenece a la cuenta verificada', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        items: [{
          phoneNumber: '+593999000001',
          displayName: 'Negocio Demo',
        }],
      },
    })

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: {
        provider: 'ycloud',
        ycloud_api_key: 'ycloud-test-secret',
        ycloud_number: '0999000001',
      },
    })

    expect(response.body).toEqual({
      ok: true,
      info: '✅ Conectado: +593999000001 — Negocio Demo',
    })
    expect(get).toHaveBeenCalledWith(
      'https://api.ycloud.com/v2/whatsapp/phoneNumbers',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'ycloud-test-secret' }),
        timeout: 10000,
      }),
    )
  })

  it('verifica credenciales guardadas únicamente desde el negocio solicitado', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      whatsapp_provider: 'meta',
      meta_token: 'meta-test-secret',
      meta_phone_id: 'phone-a',
    })
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        verified_name: 'Empresa A',
        display_phone_number: '+593200000001',
        code_verification_status: 'VERIFIED',
      },
    })

    const response = await dispatch('/api/admin/clients/:id/verify', {
      auth: authorization(),
      params: { id: 'business-a' },
    })

    expect(db.getBusinessById).toHaveBeenCalledWith('business-a')
    expect(response.body).toEqual({
      ok: true,
      info: 'Empresa A — +593200000001 (VERIFIED)',
    })
    expect(JSON.stringify(response.body)).not.toContain('meta-test-secret')
  })

  it('elimina secretos de los errores devueltos por proveedores', async () => {
    const secret = 'kapso-super-secret'
    const error = new Error('Request failed')
    error.isAxiosError = true
    error.response = {
      status: 401,
      data: { message: `Credencial ${secret} inválida` },
    }
    vi.spyOn(axios, 'get').mockRejectedValue(error)

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: { provider: 'kapso', kapso_api_key: secret },
    })

    expect(response.body.ok).toBe(false)
    expect(response.body.info).toContain('[HTTP 401]')
    expect(response.body.info).toContain('API Key inválida o sin permisos')
    expect(response.body.info).not.toContain(secret)
  })
})
