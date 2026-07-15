import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import webhooksRouter from '../dist/routes/webhooks.routes.js'

const require = createRequire(import.meta.url)
const bot = require('../dist/services/bot-entry')
const db = require('../dist/db')

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  BASE_URL: process.env.BASE_URL,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(db, 'getBusinessByPhone').mockResolvedValue({ id: 'business-a' })
  vi.spyOn(db, 'claimWebhookEvent').mockResolvedValue({ data: true, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function dispatch(method, path, {
  body = {}, headers = {}, query = {}, rawBody,
} = {}) {
  const layer = webhooksRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  const handler = layer.route.stack.at(-1).handle
  const req = { body, headers, query, rawBody }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    send(value) { result.body = value; return this },
    sendStatus(code) { result.status = code; result.body = String(code); return this },
    json(value) { result.body = value; return this },
  }
  let nextError
  await handler(req, res, error => { nextError = error })
  if (nextError) throw nextError
  return result
}

function metaPayload(id = 'meta-message-1') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { display_phone_number: '+593200000001' },
          messages: [{
            id,
            timestamp: Date.now(),
            from: '+593999000001',
            type: 'text',
            text: { body: 'Hola Meta' },
          }],
        },
      }],
    }],
  }
}

describe('webhooks WhatsApp', () => {
  it('conserva los cuatro endpoints y rate limiting en cada POST', () => {
    expect(webhooksRouter.stack).toHaveLength(4)
    const get = webhooksRouter.stack.find(layer => layer.route?.methods?.get)
    const posts = webhooksRouter.stack.filter(layer => layer.route?.methods?.post)
    expect(get.route.path).toBe('/webhook')
    expect(get.route.stack).toHaveLength(1)
    expect(posts.map(layer => layer.route.path).sort()).toEqual([
      '/webhook', '/webhook/kapso', '/webhook/ycloud',
    ])
    expect(posts.every(layer => layer.route.stack.length === 2)).toBe(true)
  })

  it('verifica el challenge de Meta únicamente con el token configurado', async () => {
    process.env.META_VERIFY_TOKEN = 'verify-meta'

    const accepted = await dispatch('get', '/webhook', {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-meta',
        'hub.challenge': 'challenge-a',
      },
    })
    const rejected = await dispatch('get', '/webhook', {
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'incorrecto' },
    })

    expect(accepted).toEqual({ status: 200, body: 'challenge-a' })
    expect(rejected.status).toBe(403)
  })

  it('acepta una firma Meta auténtica y procesa el número del negocio', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.META_APP_SECRET = 'meta-app-secret'
    const body = metaPayload('meta-valid-signature')
    const rawBody = Buffer.from(JSON.stringify(body))
    const signature = `sha256=${crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(rawBody)
      .digest('hex')}`
    const handleMessage = vi.spyOn(bot, 'handleMessage').mockResolvedValue()

    const response = await dispatch('post', '/webhook', {
      body,
      rawBody,
      headers: { 'x-hub-signature-256': signature },
    })

    expect(response.status).toBe(200)
    expect(handleMessage).toHaveBeenCalledWith(
      '+593999000001', 'Hola Meta', '+593200000001',
    )
  })

  it('rechaza Meta con firma manipulada o secreto ausente en producción', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.META_APP_SECRET = 'meta-app-secret'
    const body = metaPayload('meta-invalid-signature')
    const rawBody = Buffer.from(JSON.stringify(body))
    const handleMessage = vi.spyOn(bot, 'handleMessage').mockResolvedValue()

    const invalid = await dispatch('post', '/webhook', {
      body, rawBody, headers: { 'x-hub-signature-256': 'sha256=incorrecta' },
    })
    delete process.env.META_APP_SECRET
    const missing = await dispatch('post', '/webhook', { body, rawBody })

    expect(invalid.status).toBe(401)
    expect(missing.status).toBe(401)
    expect(handleMessage).not.toHaveBeenCalled()
  })

  it('rechaza YCloud sin secreto y deduplica entregas válidas', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.WEBHOOK_SECRET = 'webhook-secret'
    const body = {
      type: 'whatsapp.inbound_message.received',
      whatsappInboundMessage: {
        id: 'ycloud-dedup-1',
        sendTime: Date.now(),
        from: '+593999000001',
        whatsappApiAccountPhoneNumber: '+593200000001',
        type: 'text',
        text: { body: 'Hola YCloud' },
      },
    }
    const handleMessage = vi.spyOn(bot, 'handleMessage').mockResolvedValue()

    const rejected = await dispatch('post', '/webhook/ycloud', { body })
    const accepted = await dispatch('post', '/webhook/ycloud', {
      body, query: { secret: 'webhook-secret' },
    })
    const duplicate = await dispatch('post', '/webhook/ycloud', {
      body, headers: { 'x-webhook-secret': 'webhook-secret' },
    })

    expect(rejected.status).toBe(401)
    expect(accepted.status).toBe(200)
    expect(duplicate.status).toBe(200)
    expect(handleMessage).toHaveBeenCalledOnce()
    expect(handleMessage).toHaveBeenCalledWith(
      '+593999000001',
      'Hola YCloud',
      '+593200000001',
      { inboundId: 'ycloud-dedup-1' },
    )
    expect(db.claimWebhookEvent).toHaveBeenCalledOnce()
    expect(db.claimWebhookEvent).toHaveBeenCalledWith(
      'business-a', 'ycloud', 'ycloud-dedup-1',
    )
  })

  it('respeta duplicados persistidos aunque la memoria local esté vacía', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.WEBHOOK_SECRET = 'webhook-secret'
    db.claimWebhookEvent.mockResolvedValueOnce({ data: false, error: null })
    const handleMessage = vi.spyOn(bot, 'handleMessage').mockResolvedValue()

    const response = await dispatch('post', '/webhook/ycloud', {
      query: { secret: 'webhook-secret' },
      body: {
        type: 'whatsapp.inbound_message.received',
        whatsappInboundMessage: {
          id: 'ycloud-persisted-duplicate-1',
          sendTime: Date.now(),
          from: '+593999000001',
          to: '+593200000001',
          type: 'text',
          text: { body: 'No procesar dos veces' },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(handleMessage).not.toHaveBeenCalled()
  })

  it('responde 503 para que el proveedor reintente si falla la deduplicación', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.WEBHOOK_SECRET = 'webhook-secret'
    db.claimWebhookEvent.mockResolvedValueOnce({
      data: null, error: { message: 'RPC temporalmente no disponible' },
    })
    const handleMessage = vi.spyOn(bot, 'handleMessage').mockResolvedValue()

    const response = await dispatch('post', '/webhook/ycloud', {
      query: { secret: 'webhook-secret' },
      body: {
        type: 'whatsapp.inbound_message.received',
        whatsappInboundMessage: {
          id: 'ycloud-claim-error-1',
          sendTime: Date.now(),
          from: '+593999000001',
          to: '+593200000001',
          type: 'text',
          text: { body: 'Reintentar luego' },
        },
      },
    })

    expect(response.status).toBe(503)
    expect(handleMessage).not.toHaveBeenCalled()
  })

  it('descarta eventos viejos y acepta payload incompleto sin lanzar errores', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.WEBHOOK_SECRET = 'webhook-secret'
    const handleMessage = vi.spyOn(bot, 'handleMessage').mockResolvedValue()
    const query = { secret: 'webhook-secret' }

    const stale = await dispatch('post', '/webhook/ycloud', {
      query,
      body: {
        type: 'whatsapp.inbound_message.received',
        whatsappInboundMessage: {
          id: 'ycloud-stale-1',
          sendTime: Date.now() - 11 * 60 * 1000,
          from: '+593999000001',
          to: '+593200000001',
          type: 'text',
          text: { body: 'Mensaje viejo' },
        },
      },
    })
    const incomplete = await dispatch('post', '/webhook/kapso', {
      query,
      body: { id: 'kapso-incomplete-1' },
    })

    expect(stale.status).toBe(200)
    expect(incomplete.status).toBe(200)
    expect(handleMessage).not.toHaveBeenCalled()
  })
})
