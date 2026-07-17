import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createBotEntry, imageQuery } = require('../dist/services/bot-entry')

const businessA = { id: 'business-a', name: 'Negocio A', bot_active: true }

function setup(overrides = {}) {
  const database = {
    getBusinessBySlug: vi.fn().mockResolvedValue(businessA),
    getBusinessByPhone: vi.fn().mockResolvedValue(businessA),
    ...overrides.database,
  }
  const conversation = {
    processMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides.conversation,
  }
  const ai = {
    identifyImage: vi.fn().mockResolvedValue('Perfume Floral Intenso'),
    callAI: vi.fn(),
    transcribeAudio: vi.fn(),
    embedText: vi.fn(),
    indexProduct: vi.fn(),
    ...overrides.ai,
  }
  const whatsapp = {
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendVideo: vi.fn().mockResolvedValue(undefined),
    ...overrides.whatsapp,
  }
  const media = {
    getImageBuffer: vi.fn().mockResolvedValue(Buffer.from('imagen')),
    ...overrides.media,
  }
  const logger = { log: vi.fn(), error: vi.fn() }
  const callbacks = []
  const setTimer = vi.fn(callback => {
    callbacks.push(callback)
    return { id: callbacks.length }
  })
  const clearTimer = vi.fn()
  const entry = createBotEntry({
    database,
    conversation,
    ai,
    whatsapp,
    media,
    logger,
    debounceMs: 3000,
    setTimer,
    clearTimer,
  })
  return {
    entry, database, conversation, ai, whatsapp, media, logger,
    callbacks, setTimer, clearTimer,
  }
}

function telegramContext() {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    replyWithVideo: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
  }
}

describe('entrada de canales del bot', () => {
  it('resuelve WhatsApp por número y conserva el negocio en todos los envíos', async () => {
    const current = setup()

    await current.entry.runMessage(
      '0990000001', 'Hola', '+593999999999', { inboundId: 'inbound-a' },
    )

    expect(current.database.getBusinessByPhone).toHaveBeenCalledWith('+593999999999')
    expect(current.database.getBusinessBySlug).not.toHaveBeenCalled()
    const input = current.conversation.processMessage.mock.calls[0][0]
    expect(input.business).toBe(businessA)
    expect(input.phone).toBe('0990000001')
    await input.send('Respuesta')
    await input.sendImage('https://cdn.example/a.jpg', 'Foto')
    await input.sendTyping()
    await input.sendVideo('https://cdn.example/a.mp4', 'Video')
    expect(current.whatsapp.sendText).toHaveBeenCalledWith(
      businessA, '0990000001', 'Respuesta',
    )
    expect(current.whatsapp.sendImage).toHaveBeenCalledWith(
      businessA, '0990000001', 'https://cdn.example/a.jpg', 'Foto',
    )
    expect(current.whatsapp.sendTyping).toHaveBeenCalledWith(businessA, 'inbound-a')
    expect(current.whatsapp.sendVideo).toHaveBeenCalledWith(
      businessA, '0990000001', 'https://cdn.example/a.mp4', 'Video',
    )
  })

  it('resuelve Telegram únicamente por slug y usa su contexto de canal', async () => {
    const current = setup()
    const ctx = telegramContext()

    await current.entry.runMessage('tg_42', 'Hola', null, {
      channel: 'telegram', slug: 'negocio-a', ctx,
    })

    expect(current.database.getBusinessBySlug).toHaveBeenCalledWith('negocio-a')
    expect(current.database.getBusinessByPhone).not.toHaveBeenCalled()
    const input = current.conversation.processMessage.mock.calls[0][0]
    expect(input.business).toBe(businessA)
    await input.send('Respuesta TG')
    await input.sendImage('https://cdn.example/a.jpg', 'Foto TG')
    await input.sendTyping()
    await input.sendVideo('https://cdn.example/a.mp4', 'Video TG')
    expect(ctx.reply).toHaveBeenCalledWith('Respuesta TG')
    expect(current.media.getImageBuffer).toHaveBeenCalledWith({
      image_url: 'https://cdn.example/a.jpg',
    })
    expect(ctx.replyWithPhoto).toHaveBeenCalledWith(
      { source: Buffer.from('imagen') }, { caption: 'Foto TG' },
    )
    expect(ctx.sendChatAction).toHaveBeenCalledWith('typing')
    expect(ctx.replyWithVideo).toHaveBeenCalledWith(
      { url: 'https://cdn.example/a.mp4' }, { caption: 'Video TG' },
    )
  })

  it('agrupa mensajes consecutivos por canal y contacto antes de procesarlos', async () => {
    const current = setup()

    await current.entry.handleMessage(
      '0990000001', 'Primero', '+593999999999', { inboundId: 'old' },
    )
    await current.entry.handleMessage(
      '0990000001', 'Segundo', '+593999999999', { inboundId: 'latest' },
    )

    expect(current.setTimer).toHaveBeenCalledTimes(2)
    expect(current.clearTimer).toHaveBeenCalledTimes(1)
    current.callbacks[1]()
    await vi.waitFor(() => {
      expect(current.conversation.processMessage).toHaveBeenCalledTimes(1)
    })
    const input = current.conversation.processMessage.mock.calls[0][0]
    expect(input.text).toBe('Primero\nSegundo')
    await input.sendTyping()
    expect(current.whatsapp.sendTyping).toHaveBeenCalledWith(businessA, 'latest')
  })

  it('mantiene buffers separados para el mismo contacto en negocios distintos', async () => {
    const current = setup()

    await current.entry.handleMessage('0990000001', 'Negocio A', '+593A')
    await current.entry.handleMessage('0990000001', 'Negocio B', '+593B')
    current.callbacks[0]()
    current.callbacks[1]()

    await vi.waitFor(() => {
      expect(current.conversation.processMessage).toHaveBeenCalledTimes(2)
    })
    expect(current.database.getBusinessByPhone).toHaveBeenCalledWith('+593A')
    expect(current.database.getBusinessByPhone).toHaveBeenCalledWith('+593B')
  })

  it('convierte una imagen identificada en consulta dentro del negocio del canal', async () => {
    const current = setup()
    const buffer = Buffer.from('foto-cliente')

    await current.entry.handleImage(
      '0990000001', buffer, 'image/png', '+593999999999', { inboundId: 'img-a' },
    )

    expect(current.ai.identifyImage).toHaveBeenCalledWith(
      `data:image/png;base64,${buffer.toString('base64')}`,
    )
    expect(current.database.getBusinessByPhone).toHaveBeenCalledWith('+593999999999')
    expect(current.conversation.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        business: businessA,
        phone: '0990000001',
        text: expect.stringContaining('Perfume Floral Intenso'),
      }),
    )
  })

  it('falla de forma segura cuando visión no identifica el producto', async () => {
    const current = setup({
      ai: { identifyImage: vi.fn().mockRejectedValue(new Error('visión caída')) },
    })

    await current.entry.handleImage(
      '0990000001', Buffer.from('foto'), null, '+593999999999',
    )

    expect(current.conversation.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        business: businessA,
        text: expect.stringContaining('no se pudo identificar con claridad'),
      }),
    )
    expect(current.logger.error).toHaveBeenCalledWith('❌ visión:', 'visión caída')
  })

  it('no procesa mensajes cuando el canal no resuelve un negocio', async () => {
    const current = setup({
      database: {
        getBusinessByPhone: vi.fn().mockResolvedValue(null),
        getBusinessBySlug: vi.fn().mockResolvedValue(null),
      },
    })
    const ctx = telegramContext()

    await current.entry.runMessage('0990000001', 'Hola', '+593NO')
    await current.entry.runMessage('tg_42', 'Hola', null, {
      channel: 'telegram', slug: 'no-existe', ctx,
    })

    expect(current.conversation.processMessage).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith('❌ Negocio no encontrado')
  })

  it('conserva los textos exactos de consulta visual', () => {
    expect(imageQuery('Producto A')).toContain('"Producto A"')
    expect(imageQuery('NO_IDENTIFICADO')).toContain(
      'no se pudo identificar con claridad',
    )
  })

  it('conserva la API pública histórica desde TypeScript compilado', () => {
    const service = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    const exported = require('../dist/services/bot-entry')

    expect(service).toContain('database.getBusinessBySlug(options.slug)')
    expect(service).toContain('database.getBusinessByPhone(businessPhone)')
    expect(service).not.toContain('@ts-nocheck')
    for (const name of [
      'handleMessage', 'handleImage', 'processMessage', 'buildPrompt', 'callAI',
      'sendWhatsAppMessage', 'transcribeAudio', 'embedText', 'indexProduct',
      'isOutsideHours', 'buildScheduleMessage',
    ]) {
      expect(exported[name]).toBeTypeOf('function')
    }
  })
})
