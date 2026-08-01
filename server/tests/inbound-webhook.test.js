import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createInboundWebhookProcessor,
  inboundConversationKey,
  parseInboundWebhookPayload,
} = require('../dist/services/inbound-webhook')

const metaAddress = {
  provider: 'meta', identifierType: 'account_id', identifier: 'meta-phone-a',
}
const ycloudAddress = {
  provider: 'ycloud', identifierType: 'phone', identifier: '593999000001',
}

function payload(overrides = {}) {
  return {
    version: 1,
    provider: 'meta',
    businessId: 'business-a',
    from: '+593988000001',
    inboundId: 'inbound-a',
    channelAddress: metaAddress,
    content: { kind: 'text', text: 'Hola' },
    ...overrides,
  }
}

function setup(overrides = {}) {
  const database = {
    getBusinessByChannel: vi.fn().mockResolvedValue({
      id: 'business-a',
      meta_token: 'meta-token-a',
      ycloud_api_key: 'ycloud-key-a',
    }),
    ...overrides.database,
  }
  const bot = {
    handleMessage: vi.fn().mockResolvedValue(undefined),
    handleImage: vi.fn().mockResolvedValue(undefined),
    transcribeAudio: vi.fn().mockResolvedValue('Audio transcrito'),
    ...overrides.bot,
  }
  const http = {
    get: vi.fn(),
    ...overrides.http,
  }
  const logger = { log: vi.fn() }
  return {
    database,
    bot,
    http,
    logger,
    process: createInboundWebhookProcessor({ database, bot, http, logger }),
  }
}

describe('procesador durable de webhooks', () => {
  it('valida el payload y genera una clave estable de conversación', () => {
    const parsed = parseInboundWebhookPayload(payload())
    expect(parsed.content).toEqual({ kind: 'text', text: 'Hola' })
    expect(inboundConversationKey(parsed)).toBe(
      'meta:business-a:+593988000001',
    )
    expect(() => parseInboundWebhookPayload(payload({
      provider: 'meta/../../otro',
    }))).toThrow(/Proveedor durable/)
  })

  it('mide el texto como PostgreSQL para aceptar lotes Unicode dentro del límite', () => {
    const unicodeText = '😀'.repeat(9_000)
    const parsed = parseInboundWebhookPayload(payload({
      content: { kind: 'text', text: unicodeText },
    }))

    expect(parsed.content.text).toBe(unicodeText)
    expect(unicodeText.length).toBeGreaterThan(16_384)
  })

  it('rechaza una fila cuyo envelope SQL no coincide con el payload', async () => {
    const current = setup()

    await expect(current.process(payload(), {
      businessId: 'business-b',
      provider: 'meta',
    })).rejects.toThrow(/no coincide con el tenant/)
    expect(current.database.getBusinessByChannel).not.toHaveBeenCalled()
    expect(current.bot.handleMessage).not.toHaveBeenCalled()
  })

  it('espera a que el bot termine un mensaje de texto antes de completar', async () => {
    let finish
    const completion = new Promise(resolve => { finish = resolve })
    const current = setup({
      bot: { handleMessage: vi.fn().mockReturnValue(completion) },
    })
    let completed = false

    const processing = current.process(payload()).then(() => { completed = true })
    await vi.waitFor(() => {
      expect(current.bot.handleMessage).toHaveBeenCalledOnce()
    })
    expect(completed).toBe(false)
    finish()
    await processing
    expect(current.bot.handleMessage).toHaveBeenCalledWith(
      '+593988000001',
      'Hola',
      'meta-phone-a',
      {
        inboundId: 'inbound-a',
        businessId: 'business-a',
        channelAddress: metaAddress,
      },
    )
  })

  it('propaga al bot el bypass solo para un lote durable validado y consolidado', async () => {
    const current = setup()
    const headId = '11111111-1111-4111-8111-111111111111'
    const latestId = '22222222-2222-4222-8222-222222222222'

    await current.process(
      payload({
        inboundId: 'inbound-latest',
        content: { kind: 'text', text: 'Uno\nDos\nTres' },
        _inboxBatch: { version: 1, eventIds: [headId, latestId] },
      }),
      { businessId: 'business-a', provider: 'meta', eventId: headId },
    )

    expect(current.bot.handleMessage).toHaveBeenCalledWith(
      '+593988000001',
      'Uno\nDos\nTres',
      'meta-phone-a',
      {
        inboundId: 'inbound-latest',
        businessId: 'business-a',
        channelAddress: metaAddress,
        bypassDebounce: true,
      },
    )
  })

  it('rechaza metadatos de lote falsificados, incongruentes o aplicados a media', async () => {
    const current = setup()
    const headId = '11111111-1111-4111-8111-111111111111'
    const otherId = '22222222-2222-4222-8222-222222222222'

    await expect(current.process(payload({
      _inboxBatch: { version: 1, eventIds: [headId, headId] },
    }), {
      businessId: 'business-a',
      provider: 'meta',
      eventId: headId,
    })).rejects.toThrow(/lote durable inválidos/)

    await expect(current.process(payload({
      _inboxBatch: { version: 2, eventIds: [headId] },
    }), {
      businessId: 'business-a',
      provider: 'meta',
      eventId: headId,
    })).rejects.toThrow(/lote durable inválidos/)

    await expect(current.process(payload({
      _inboxBatch: { version: 1, eventIds: [otherId] },
    }), {
      businessId: 'business-a',
      provider: 'meta',
      eventId: headId,
    })).rejects.toThrow(/no coincide con el evento/)

    await expect(current.process(payload({
      content: { kind: 'image', media: { id: 'media-a' } },
      _inboxBatch: { version: 1, eventIds: [headId] },
    }), {
      businessId: 'business-a',
      provider: 'meta',
      eventId: headId,
    })).rejects.toThrow(/solo puede contener mensajes de texto/)

    expect(current.database.getBusinessByChannel).not.toHaveBeenCalled()
    expect(current.bot.handleMessage).not.toHaveBeenCalled()
    expect(current.bot.handleImage).not.toHaveBeenCalled()
  })

  it('descarga una imagen Meta con pertenencia, límites y sin redirecciones', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=a'
    const current = setup()
    current.http.get
      .mockResolvedValueOnce({
        data: { url: mediaUrl, mime_type: 'image/jpeg' }, headers: {},
      })
      .mockResolvedValueOnce({
        data: new Uint8Array([1, 2, 3]).buffer,
        headers: { 'content-type': 'image/jpeg' },
      })

    await current.process(payload({
      content: { kind: 'image', media: { id: 'media-a' } },
    }))

    expect(current.http.get).toHaveBeenNthCalledWith(
      1,
      'https://graph.facebook.com/v25.0/media-a',
      expect.objectContaining({ params: { phone_number_id: 'meta-phone-a' } }),
    )
    expect(current.http.get).toHaveBeenNthCalledWith(
      2,
      mediaUrl,
      expect.objectContaining({
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
      }),
    )
    expect(current.bot.handleImage).toHaveBeenCalledWith(
      '+593988000001', expect.any(Buffer), 'image/jpeg', 'meta-phone-a',
      expect.any(Object),
    )
  })

  it('descarga y transcribe audio YCloud solo desde el endpoint oficial', async () => {
    const current = setup()
    current.http.get.mockResolvedValue({
      data: new Uint8Array([4, 5, 6]).buffer,
      headers: { 'content-type': 'audio/mpeg' },
    })
    const audioUrl = 'https://api.ycloud.com/v2/whatsapp/media/download/media-a?sig=a'

    await current.process(payload({
      provider: 'ycloud',
      channelAddress: ycloudAddress,
      content: { kind: 'audio', media: { url: audioUrl, mimeType: 'audio/mpeg' } },
    }))

    expect(current.http.get).toHaveBeenCalledWith(
      audioUrl,
      expect.objectContaining({
        headers: { 'X-API-Key': 'ycloud-key-a' },
        maxRedirects: 0,
        maxContentLength: 20 * 1024 * 1024,
      }),
    )
    expect(current.bot.transcribeAudio).toHaveBeenCalledWith(
      expect.any(Buffer), 'audio.mp3',
    )
    expect(current.bot.handleMessage).toHaveBeenCalledWith(
      '+593988000001', 'Audio transcrito', '593999000001', expect.any(Object),
    )
  })

  it('falla para que el worker reintente si cambió el tenant o la media es insegura', async () => {
    const changed = setup({
      database: { getBusinessByChannel: vi.fn().mockResolvedValue({ id: 'business-b' }) },
    })
    await expect(changed.process(payload())).rejects.toThrow(/negocio original/)

    const insecure = setup()
    await expect(insecure.process(payload({
      provider: 'ycloud',
      channelAddress: ycloudAddress,
      content: {
        kind: 'image',
        media: { url: 'https://attacker.example/internal' },
      },
    }))).rejects.toThrow(/YCloud no permitida/)
    expect(insecure.http.get).not.toHaveBeenCalled()
  })
})
