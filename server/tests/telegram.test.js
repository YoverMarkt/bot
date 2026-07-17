import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createTelegramIntegration } = require('../dist/integrations/telegram')

const businessA = {
  id: 'business-a', slug: 'negocio-a', name: 'Negocio A', active: true,
}

function createContext(overrides = {}) {
  return {
    chat: { id: 42 },
    message: { text: 'Hola' },
    telegram: {
      getFileLink: vi.fn().mockResolvedValue({ href: 'https://telegram/file' }),
      setWebhook: vi.fn().mockResolvedValue(undefined),
    },
    startPayload: '',
    match: [],
    updateType: 'message',
    reply: vi.fn().mockResolvedValue(undefined),
    answerCbQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function setup(overrides = {}) {
  const handlers = { commands: {}, events: {} }
  const telegram = {
    getFileLink: vi.fn().mockResolvedValue({ href: 'https://telegram/file' }),
    setWebhook: vi.fn().mockResolvedValue(undefined),
  }
  const fakeBot = {
    telegram,
    catch: vi.fn(handler => { handlers.error = handler }),
    start: vi.fn(handler => { handlers.start = handler }),
    action: vi.fn((pattern, handler) => {
      handlers.actionPattern = pattern
      handlers.action = handler
    }),
    command: vi.fn((name, handler) => { handlers.commands[name] = handler }),
    on: vi.fn((event, handler) => { handlers.events[event] = handler }),
    webhookCallback: vi.fn().mockReturnValue('telegram-middleware'),
    launch: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  }
  const database = {
    getAllBusinesses: vi.fn().mockResolvedValue([businessA]),
    getBusinessBySlug: vi.fn().mockResolvedValue(businessA),
    getBusinessById: vi.fn().mockResolvedValue(businessA),
    getLatestBusinessIdForContact: vi.fn().mockResolvedValue('business-a'),
    ...overrides.database,
  }
  const botApi = {
    transcribeAudio: vi.fn().mockResolvedValue('Texto transcrito'),
    handleImage: vi.fn().mockResolvedValue(undefined),
    ...overrides.botApi,
  }
  const createBot = vi.fn().mockReturnValue(fakeBot)
  const markup = {
    button: { callback: vi.fn((text, data) => ({ text, data })) },
    inlineKeyboard: vi.fn(buttons => ({ reply_markup: { inline_keyboard: buttons } })),
  }
  const download = vi.fn().mockResolvedValue({
    data: Uint8Array.from([1, 2, 3]).buffer,
  })
  const logger = { log: vi.fn(), error: vi.fn() }
  const signals = {}
  const onSignal = vi.fn((signal, listener) => { signals[signal] = listener })
  const env = {
    TELEGRAM_BOT_TOKEN: 'telegram-token-valid',
    ...overrides.env,
  }
  const integration = createTelegramIntegration({
    database, botApi, createBot, markup, download, logger, onSignal, env,
  })
  const app = { use: vi.fn() }
  const handleMessage = vi.fn().mockResolvedValue(undefined)
  return {
    integration, database, botApi, createBot, markup, download, logger,
    signals, onSignal, env, fakeBot, handlers, telegram, app, handleMessage,
  }
}

describe('integración Telegram', () => {
  it('no inicia sin un token válido', async () => {
    const current = setup({ env: { TELEGRAM_BOT_TOKEN: '' } })

    await expect(current.integration.setupTelegram(
      current.app, current.handleMessage,
    )).resolves.toBeNull()

    expect(current.createBot).not.toHaveBeenCalled()
    expect(current.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('configura TELEGRAM_BOT_TOKEN'),
    )
  })

  it('restaura una sesión solo después de validar que el negocio siga activo', async () => {
    const current = setup()

    await expect(current.integration.restoreSession(42)).resolves.toBe('negocio-a')
    expect(current.database.getLatestBusinessIdForContact).toHaveBeenCalledWith('tg_42')
    expect(current.database.getBusinessById).toHaveBeenCalledWith('business-a')

    const inactive = setup({
      database: { getBusinessById: vi.fn().mockResolvedValue({ ...businessA, active: false }) },
    })
    await expect(inactive.integration.restoreSession(42)).resolves.toBeNull()
  })

  it('lista únicamente negocios activos con botones por slug', async () => {
    const inactive = { id: 'business-b', slug: 'negocio-b', name: 'Negocio B', active: false }
    const current = setup({
      database: { getAllBusinesses: vi.fn().mockResolvedValue([businessA, inactive]) },
    })
    const context = createContext()

    await current.integration.showBusinessList(context)

    expect(current.markup.button.callback).toHaveBeenCalledTimes(1)
    expect(current.markup.button.callback).toHaveBeenCalledWith(
      '🏪 Negocio A', 'select_negocio-a',
    )
    expect(context.reply).toHaveBeenCalledWith(
      expect.stringContaining('Elige un negocio'),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    )
  })

  it('conecta por /start y entrega texto con el mismo slug del negocio', async () => {
    const current = setup()
    await current.integration.setupTelegram(current.app, current.handleMessage)
    const startContext = createContext({ startPayload: 'negocio-a' })
    await current.handlers.start(startContext)

    const textContext = createContext({
      message: { text: 'Quiero un producto' },
    })
    await current.handlers.events.text(textContext)

    expect(current.database.getBusinessBySlug).toHaveBeenCalledWith('negocio-a')
    expect(current.handleMessage).toHaveBeenCalledWith(
      'tg_42',
      'Quiero un producto',
      null,
      { channel: 'telegram', ctx: textContext, slug: 'negocio-a' },
    )
  })

  it('descarga y transcribe voz antes de enviarla al flujo del mismo tenant', async () => {
    const current = setup()
    await current.integration.setupTelegram(current.app, current.handleMessage)
    await current.handlers.start(createContext({ startPayload: 'negocio-a' }))
    const context = createContext({
      message: { voice: { file_id: 'voice-high' } },
    })

    await current.handlers.events.voice(context)

    expect(current.download).toHaveBeenCalledWith('https://telegram/file')
    expect(current.botApi.transcribeAudio).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]), 'voz.ogg',
    )
    expect(current.handleMessage).toHaveBeenCalledWith(
      'tg_42', 'Texto transcrito', null,
      { channel: 'telegram', ctx: context, slug: 'negocio-a' },
    )
  })

  it('usa la foto de mayor resolución y conserva slug y chat', async () => {
    const current = setup()
    await current.integration.setupTelegram(current.app, current.handleMessage)
    await current.handlers.start(createContext({ startPayload: 'negocio-a' }))
    const context = createContext({
      message: { photo: [{ file_id: 'small' }, { file_id: 'large' }] },
    })

    await current.handlers.events.photo(context)

    expect(context.telegram.getFileLink).toHaveBeenCalledWith('large')
    expect(current.botApi.handleImage).toHaveBeenCalledWith(
      'tg_42', Buffer.from([1, 2, 3]), 'image/jpeg', null,
      { channel: 'telegram', ctx: context, slug: 'negocio-a' },
    )
  })

  it('configura webhook en producción y polling con cierre limpio en local', async () => {
    const production = setup({ env: {
      BASE_URL: 'https://bot.example.com',
      TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret-value',
    } })
    await production.integration.setupTelegram(
      production.app, production.handleMessage,
    )
    expect(production.telegram.setWebhook).toHaveBeenCalledWith(
      'https://bot.example.com/webhook/telegram',
      { secret_token: 'telegram-webhook-secret-value' },
    )
    expect(production.fakeBot.webhookCallback).toHaveBeenCalledWith(
      '/webhook/telegram',
      { secretToken: 'telegram-webhook-secret-value' },
    )
    expect(production.app.use).toHaveBeenCalledWith('telegram-middleware')
    expect(production.fakeBot.launch).not.toHaveBeenCalled()

    const local = setup()
    await local.integration.setupTelegram(local.app, local.handleMessage)
    expect(local.fakeBot.launch).toHaveBeenCalled()
    local.signals.SIGINT()
    local.signals.SIGTERM()
    expect(local.fakeBot.stop).toHaveBeenNthCalledWith(1, 'SIGINT')
    expect(local.fakeBot.stop).toHaveBeenNthCalledWith(2, 'SIGTERM')
  })

  it('falla cerrado si un webhook de Telegram no tiene secreto', async () => {
    const production = setup({ env: { BASE_URL: 'https://bot.example.com' } })

    await expect(production.integration.setupTelegram(
      production.app, production.handleMessage,
    )).rejects.toThrow('TELEGRAM_WEBHOOK_SECRET es obligatorio')
    expect(production.telegram.setWebhook).not.toHaveBeenCalled()
  })

  it('mantiene la integración tipada sin acceso directo a Supabase', () => {
    const service = fs.readFileSync(new URL('../src/integrations/telegram.ts', import.meta.url), 'utf8')

    expect(service).toContain('database.getLatestBusinessIdForContact(contact)')
    expect(service).not.toContain("require('@supabase/supabase-js')")
    expect(service).not.toContain(".from('conversation_history')")
    expect(service).not.toContain('@ts-nocheck')
  })
})
