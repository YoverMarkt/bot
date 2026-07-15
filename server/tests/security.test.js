import { afterEach, describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import retell from '../dist/integrations/retell.js'
import secrets from '../dist/services/secrets.js'
import auth from '../dist/middleware/auth.js'
import asyncTools from '../dist/middleware/async.js'

describe('firma de Retell', () => {
  const key = 'retell_test_key'
  const body = '{"event":"call_ended"}'
  const now = 1_750_000_000_000

  const signature = timestamp => {
    const digest = crypto.createHmac('sha256', key).update(body + timestamp).digest('hex')
    return `v=${timestamp},d=${digest}`
  }

  it('acepta una firma auténtica y reciente', () => {
    expect(retell.verifyRetellSignature(body, key, signature(now), now)).toBe(true)
  })

  it('rechaza una firma manipulada', () => {
    expect(retell.verifyRetellSignature(body + 'x', key, signature(now), now)).toBe(false)
  })

  it('rechaza replays con más de cinco minutos', () => {
    const old = now - 5 * 60 * 1000 - 1
    expect(retell.verifyRetellSignature(body, key, signature(old), now)).toBe(false)
  })
})

describe('secreto del Custom LLM de Retell', () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    BASE_URL: process.env.BASE_URL,
    RETELL_LLM_SECRET: process.env.RETELL_LLM_SECRET,
  }

  const run = secret => {
    let status = 200
    let nextCalled = false
    const req = { query: { secret }, headers: {} }
    const res = {
      status(code) { status = code; return this },
      json() { return this },
    }
    retell.verifyRetellLLMRequest(req, res, () => { nextCalled = true })
    return { status, nextCalled }
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('acepta el secreto configurado', () => {
    process.env.NODE_ENV = 'production'
    process.env.RETELL_LLM_SECRET = 'llm-test-secret'
    expect(run('llm-test-secret').nextCalled).toBe(true)
  })

  it('rechaza un secreto incorrecto', () => {
    process.env.NODE_ENV = 'production'
    process.env.RETELL_LLM_SECRET = 'llm-test-secret'
    expect(run('incorrecto').status).toBe(401)
  })
})

describe('credenciales de negocios', () => {
  it('no expone secretos completos al panel admin', () => {
    const business = {
      id: 'biz-1',
      name: 'Demo',
      ycloud_api_key: 'ycloud-secret',
      meta_token: 'meta-secret',
      meta_verify_token: 'meta-verify-secret',
      kapso_api_key: 'kapso-secret',
      kapso_verify_token: 'kapso-verify-secret',
      telegram_bot_token: null,
    }
    const safe = secrets.sanitizeBusinessForAdmin(business)

    expect(safe.id).toBe('biz-1')
    for (const field of secrets.BUSINESS_SECRET_FIELDS) {
      expect(safe).not.toHaveProperty(field)
    }
    expect(safe.credential_status.ycloud_api_key).toBe(true)
    expect(safe.credential_status.meta_token).toBe(true)
    expect(safe.credential_status.meta_verify_token).toBe(true)
    expect(safe.credential_status.kapso_api_key).toBe(true)
    expect(safe.credential_status.kapso_verify_token).toBe(true)
    expect(safe.credential_status.telegram_bot_token).toBe(false)
    expect(business.ycloud_api_key).toBe('ycloud-secret')
    expect(business.telegram_bot_token).toBeNull()
  })

  it('conserva campos públicos y marca credenciales vacías como no configuradas', () => {
    const safe = secrets.sanitizeBusinessForAdmin({
      id: 'biz-2',
      retell_agent_id: 'agent-public-id',
      ycloud_api_key: '',
    })

    expect(safe.retell_agent_id).toBe('agent-public-id')
    expect(safe.credential_status.ycloud_api_key).toBe(false)
    expect(Object.keys(safe.credential_status)).toEqual(secrets.BUSINESS_SECRET_FIELDS)
  })

  it('respeta valores nulos usados por rutas sin negocio', () => {
    expect(secrets.sanitizeBusinessForAdmin(null)).toBeNull()
    expect(secrets.sanitizeBusinessForAdmin(undefined)).toBeUndefined()
  })
})

describe('middleware de cliente', () => {
  const originalSecret = process.env.JWT_SECRET

  const run = token => {
    let status = 200
    let body = null
    let nextCalled = false
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = {
      status(code) { status = code; return this },
      json(data) { body = data; return this },
    }
    auth.authClient(req, res, () => { nextCalled = true })
    return { status, body, nextCalled, req }
  }

  it('acepta solo un token cliente con businessId', () => {
    process.env.JWT_SECRET = 'test-secret'
    const token = jwt.sign({ role: 'client', businessId: 'biz-1' }, process.env.JWT_SECRET)
    const result = run(token)
    expect(result.nextCalled).toBe(true)
    expect(result.req.user.businessId).toBe('biz-1')
    process.env.JWT_SECRET = originalSecret
  })

  it('rechaza un token de administrador en rutas cliente', () => {
    process.env.JWT_SECRET = 'test-secret'
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET)
    const result = run(token)
    expect(result.nextCalled).toBe(false)
    expect(result.status).toBe(403)
    process.env.JWT_SECRET = originalSecret
  })
})

describe('errores asíncronos de Express', () => {
  it('propaga un rechazo al middleware de error', async () => {
    const expected = new Error('fallo controlado')
    let received = null
    const handler = asyncTools.asyncHandler(async () => { throw expected })
    await handler({}, {}, error => { received = error })
    expect(received).toBe(expected)
  })

  it('propaga también errores síncronos', async () => {
    const expected = new Error('fallo síncrono')
    let received = null
    const handler = asyncTools.asyncHandler(() => { throw expected })
    await handler({}, {}, error => { received = error })
    expect(received).toBe(expected)
  })
})
