import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import webhooksRouter from '../dist/routes/webhooks.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  BASE_URL: process.env.BASE_URL,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  YCLOUD_WEBHOOK_SECRET: process.env.YCLOUD_WEBHOOK_SECRET,
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(db, 'getBusinessByChannel').mockResolvedValue({
    id: 'business-a',
    ycloud_api_key: 'ycloud-api-key',
    ycloud_webhook_endpoint_id: 'ycloud-endpoint-a',
    ycloud_webhook_secret: 'ycloud-signing-secret-a',
  })
  vi.spyOn(db, 'enqueueWebhookEvent').mockResolvedValue({ data: true, error: null })
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
          metadata: {
            display_phone_number: '+593200000001',
            phone_number_id: 'meta-phone-id-a',
          },
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

function ycloudPayload(eventId = 'ycloud-event-1', messageId = 'ycloud-message-1') {
  return {
    id: eventId,
    type: 'whatsapp.inbound_message.received',
    createTime: new Date().toISOString(),
    whatsappInboundMessage: {
      id: messageId,
      sendTime: new Date().toISOString(),
      from: '+593999000001',
      to: '+593200000001',
      whatsappApiAccountPhoneNumber: '+593200000001',
      type: 'text',
      text: { body: 'Hola YCloud' },
    },
  }
}

function signedYCloudRequest(body, {
  secret = 'ycloud-signing-secret-a',
  timestamp = Math.floor(Date.now() / 1000),
  endpointId = 'ycloud-endpoint-a',
} = {}) {
  const rawBody = Buffer.from(JSON.stringify(body))
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex')
  return {
    rawBody,
    headers: {
      'ycloud-signature': `t=${timestamp},s=${signature}`,
      'x-webhook-endpoint-id': endpointId,
    },
  }
}

describe('webhooks WhatsApp', () => {
  it('conserva los endpoints Meta/YCloud y rate limiting en cada POST', () => {
    expect(webhooksRouter.stack).toHaveLength(3)
    const get = webhooksRouter.stack.find(layer => layer.route?.methods?.get)
    const posts = webhooksRouter.stack.filter(layer => layer.route?.methods?.post)
    expect(get.route.path).toBe('/webhook')
    expect(get.route.stack).toHaveLength(1)
    expect(posts.map(layer => layer.route.path).sort()).toEqual([
      '/webhook', '/webhook/ycloud',
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

  it('acepta una firma Meta auténtica y prioriza el phone ID exacto', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.META_APP_SECRET = 'meta-app-secret'
    const body = metaPayload('meta-valid-signature')
    const rawBody = Buffer.from(JSON.stringify(body))
    const signature = `sha256=${crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(rawBody)
      .digest('hex')}`
    const response = await dispatch('post', '/webhook', {
      body,
      rawBody,
      headers: { 'x-hub-signature-256': signature },
    })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledWith(
      'business-a',
      'meta',
      'meta-valid-signature',
      'meta:business-a:+593999000001',
      {
        version: 1,
        provider: 'meta',
        businessId: 'business-a',
        from: '+593999000001',
        inboundId: 'meta-valid-signature',
        channelAddress: {
          provider: 'meta', identifierType: 'account_id', identifier: 'meta-phone-id-a',
        },
        content: { kind: 'text', text: 'Hola Meta' },
      },
    )
    expect(db.getBusinessByChannel).toHaveBeenCalledWith({
      provider: 'meta',
      identifierType: 'account_id',
      identifier: 'meta-phone-id-a',
    })
    expect(db.getBusinessByChannel).toHaveBeenCalledOnce()
  })

  it('procesa todos los entries, changes y mensajes de un lote Meta', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.META_APP_SECRET = 'meta-app-secret'
    const first = metaPayload('meta-batch-1').entry[0].changes[0]
    const second = metaPayload('meta-batch-2').entry[0].changes[0]
    second.value.messages.push({
      id: 'meta-batch-3',
      timestamp: String(Math.floor(Date.now() / 1000)),
      from: '+593999000002',
      type: 'button',
      button: { text: 'Confirmar', payload: 'confirmar' },
    })
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        { changes: [{ value: { statuses: [{ id: 'status-only' }] } }, first] },
        { changes: [second] },
      ],
    }
    const rawBody = Buffer.from(JSON.stringify(body))
    const signature = `sha256=${crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(rawBody)
      .digest('hex')}`
    const response = await dispatch('post', '/webhook', {
      body,
      rawBody,
      headers: { 'x-hub-signature-256': signature },
    })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledTimes(3)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledWith(
      'business-a',
      'meta',
      'meta-batch-3',
      'meta:business-a:+593999000002',
      expect.objectContaining({
        content: { kind: 'text', text: 'Confirmar' },
      }),
    )
  })

  it('rechaza Meta con firma manipulada o secreto ausente en producción', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.META_APP_SECRET = 'meta-app-secret'
    const body = metaPayload('meta-invalid-signature')
    const rawBody = Buffer.from(JSON.stringify(body))
    const invalid = await dispatch('post', '/webhook', {
      body, rawBody, headers: { 'x-hub-signature-256': 'sha256=incorrecta' },
    })
    delete process.env.META_APP_SECRET
    const missing = await dispatch('post', '/webhook', { body, rawBody })

    expect(invalid.status).toBe(401)
    expect(missing.status).toBe(401)
    expect(db.enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  it('usa el teléfono completo como fallback Meta si no llega phone_number_id', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.BASE_URL
    delete process.env.META_APP_SECRET
    const body = metaPayload('meta-phone-fallback-a')
    delete body.entry[0].changes[0].value.metadata.phone_number_id
    const response = await dispatch('post', '/webhook', { body })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledWith(
      'business-a',
      'meta',
      'meta-phone-fallback-a',
      'meta:business-a:+593999000001',
      expect.objectContaining({
        channelAddress: {
          provider: 'meta', identifierType: 'phone', identifier: '593200000001',
        },
      }),
    )
  })

  it('persiste referencias de media Meta sin descargar dentro de la petición', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.BASE_URL
    delete process.env.META_APP_SECRET
    const body = metaPayload('meta-image-message-a')
    const message = body.entry[0].changes[0].value.messages[0]
    message.type = 'image'
    delete message.text
    message.image = { id: 'meta-media-image-a', mime_type: 'image/jpeg' }

    const response = await dispatch('post', '/webhook', { body })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledWith(
      'business-a', 'meta', 'meta-image-message-a',
      'meta:business-a:+593999000001',
      expect.objectContaining({
        content: {
          kind: 'image',
          media: { id: 'meta-media-image-a', mimeType: 'image/jpeg' },
        },
      }),
    )
  })

  it('exige la firma oficial YCloud y deduplica por ID del evento', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    const body = ycloudPayload('ycloud-event-dedup-1', 'ycloud-message-dedup-1')
    const signed = signedYCloudRequest(body)
    db.enqueueWebhookEvent
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null })

    const rejected = await dispatch('post', '/webhook/ycloud', {
      body,
      query: { secret: 'el-secreto-en-url-ya-no-es-valido' },
      rawBody: signed.rawBody,
    })
    const accepted = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signed,
    })
    const duplicate = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signed,
    })

    expect(rejected.status).toBe(401)
    expect(accepted.status).toBe(200)
    expect(duplicate.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledTimes(2)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledWith(
      'business-a',
      'ycloud',
      'ycloud-event-dedup-1',
      'ycloud:business-a:+593999000001',
      {
        version: 1,
        provider: 'ycloud',
        businessId: 'business-a',
        from: '+593999000001',
        inboundId: 'ycloud-message-dedup-1',
        channelAddress: {
          provider: 'ycloud', identifierType: 'phone', identifier: '593200000001',
        },
        content: { kind: 'text', text: 'Hola YCloud' },
      },
    )
  })

  it('rechaza firma o Endpoint ID YCloud incorrectos y falla cerrado sin secret', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    delete process.env.YCLOUD_WEBHOOK_SECRET
    const body = ycloudPayload('ycloud-event-security-1', 'ycloud-message-security-1')

    const invalidSignature = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body, { secret: 'secreto-incorrecto' }),
    })
    const invalidEndpoint = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body, { endpointId: 'otro-endpoint' }),
    })
    db.getBusinessByChannel.mockResolvedValueOnce({
      id: 'business-a',
      ycloud_webhook_endpoint_id: 'ycloud-endpoint-a',
    })
    const missingSecret = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body),
    })

    expect(invalidSignature.status).toBe(401)
    expect(invalidEndpoint.status).toBe(401)
    expect(missingSecret.status).toBe(503)
    expect(db.enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  it('procesa respuestas button e interactive de YCloud como texto', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    const button = ycloudPayload('ycloud-event-button-1', 'ycloud-message-button-1')
    button.whatsappInboundMessage.type = 'button'
    delete button.whatsappInboundMessage.text
    button.whatsappInboundMessage.button = { text: 'Ver catálogo', payload: 'catalogo' }
    const interactive = ycloudPayload(
      'ycloud-event-interactive-1',
      'ycloud-message-interactive-1',
    )
    interactive.whatsappInboundMessage.type = 'interactive'
    delete interactive.whatsappInboundMessage.text
    interactive.whatsappInboundMessage.interactive = {
      list_reply: { title: 'Perfumes' },
    }
    const buttonResponse = await dispatch('post', '/webhook/ycloud', {
      body: button,
      ...signedYCloudRequest(button),
    })
    const interactiveResponse = await dispatch('post', '/webhook/ycloud', {
      body: interactive,
      ...signedYCloudRequest(interactive),
    })

    expect(buttonResponse.status).toBe(200)
    expect(interactiveResponse.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledTimes(2)
    expect(db.enqueueWebhookEvent).toHaveBeenNthCalledWith(
      1, 'business-a', 'ycloud', 'ycloud-event-button-1',
      'ycloud:business-a:+593999000001',
      expect.objectContaining({ content: { kind: 'text', text: 'Ver catálogo' } }),
    )
    expect(db.enqueueWebhookEvent).toHaveBeenNthCalledWith(
      2, 'business-a', 'ycloud', 'ycloud-event-interactive-1',
      'ycloud:business-a:+593999000001',
      expect.objectContaining({ content: { kind: 'text', text: 'Perfumes' } }),
    )
  })

  it('persiste la referencia YCloud y deja la descarga fuera de la petición', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    const body = ycloudPayload('ycloud-event-image-1', 'ycloud-message-image-1')
    body.whatsappInboundMessage.type = 'image'
    delete body.whatsappInboundMessage.text
    body.whatsappInboundMessage.image = {
      link: 'https://api.ycloud.com/v2/whatsapp/media/download/media-a?sig=firma',
      mime_type: 'image/jpeg',
    }
    const response = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body),
    })

    expect(response.status).toBe(200)
    expect(console.error).not.toHaveBeenCalled()
    expect(db.enqueueWebhookEvent).toHaveBeenCalledWith(
      'business-a', 'ycloud', 'ycloud-event-image-1',
      'ycloud:business-a:+593999000001',
      expect.objectContaining({
        content: {
          kind: 'image',
          media: {
            url: body.whatsappInboundMessage.image.link,
            mimeType: 'image/jpeg',
          },
        },
      }),
    )
  })

  it('ignora referencias de media YCloud incompletas sin encolarlas', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    const body = ycloudPayload('ycloud-event-ssrf-1', 'ycloud-message-ssrf-1')
    body.whatsappInboundMessage.type = 'image'
    delete body.whatsappInboundMessage.text
    body.whatsappInboundMessage.image = { mime_type: 'image/jpeg' }

    const response = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body),
    })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  it('respeta duplicados persistidos aunque la memoria local esté vacía', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    db.enqueueWebhookEvent.mockResolvedValueOnce({ data: false, error: null })
    const body = ycloudPayload(
      'ycloud-event-persisted-duplicate-1',
      'ycloud-message-persisted-duplicate-1',
    )

    const response = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body),
    })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledOnce()
  })

  it('responde 503 para que el proveedor reintente si falla la persistencia', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    db.enqueueWebhookEvent.mockResolvedValueOnce({
      data: null, error: { message: 'RPC temporalmente no disponible' },
    })
    const body = ycloudPayload('ycloud-event-claim-error-1', 'ycloud-message-claim-error-1')

    const response = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body),
    })

    expect(response.status).toBe(503)
    expect(console.error).toHaveBeenCalledWith(
      '❌ Webhook YCloud persistencia:',
      'RPC temporalmente no disponible',
    )
  })

  it('acepta reintentos tardíos válidos y tolera payload incompleto', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    const delayed = ycloudPayload('ycloud-event-delayed-1', 'ycloud-message-delayed-1')
    delayed.whatsappInboundMessage.sendTime = new Date(Date.now() - 6 * 60 * 60 * 1000)

    const accepted = await dispatch('post', '/webhook/ycloud', {
      body: delayed,
      ...signedYCloudRequest(delayed),
    })
    const incomplete = await dispatch('post', '/webhook/ycloud', {
      body: { id: 'ycloud-incomplete-1' },
    })

    expect(accepted.status).toBe(200)
    expect(incomplete.status).toBe(200)
    expect(db.enqueueWebhookEvent).toHaveBeenCalledOnce()
  })

  it('no sustituye un phone ID Meta desconocido por el teléfono secundario', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    process.env.META_APP_SECRET = 'meta-app-secret'
    const body = metaPayload('meta-conflict-a')
    const rawBody = Buffer.from(JSON.stringify(body))
    const signature = `sha256=${crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(rawBody)
      .digest('hex')}`
    db.getBusinessByChannel.mockImplementation(async address => (
      address.identifierType === 'account_id' ? null : { id: 'business-b' }
    ))
    const response = await dispatch('post', '/webhook', {
      body,
      rawBody,
      headers: { 'x-hub-signature-256': signature },
    })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).not.toHaveBeenCalled()
    expect(db.getBusinessByChannel).not.toHaveBeenCalledWith(
      expect.objectContaining({ identifierType: 'phone' }),
    )
  })

  it('ignora de forma segura un canal que no pertenece a ningún negocio', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BASE_URL
    db.getBusinessByChannel.mockResolvedValue(null)
    const body = ycloudPayload('ycloud-event-unresolved-a', 'ycloud-message-unresolved-a')
    body.whatsappInboundMessage.to = '+593200000099'

    const response = await dispatch('post', '/webhook/ycloud', {
      body,
      ...signedYCloudRequest(body),
    })

    expect(response.status).toBe(200)
    expect(db.enqueueWebhookEvent).not.toHaveBeenCalled()
  })
})
