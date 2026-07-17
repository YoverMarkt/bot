interface TelegramBusiness {
  id?: string
  slug?: string | null
  name?: string | null
  active?: boolean | null
}

interface TelegramDatabase {
  getAllBusinesses(): Promise<TelegramBusiness[]>
  getBusinessBySlug(slug: string): Promise<TelegramBusiness | null>
  getBusinessById(id: string): Promise<TelegramBusiness | null>
  getLatestBusinessIdForContact(phone: string): Promise<string | null>
}

interface TelegramMessage {
  text?: string
  voice?: { file_id?: string }
  audio?: { file_id?: string }
  photo?: Array<{ file_id: string }>
}

interface TelegramApi {
  getFileLink(fileId: string): Promise<{ href: string }>
  setWebhook(url: string, options?: { secret_token?: string }): Promise<unknown>
}

interface TelegramContext {
  chat: { id: number }
  message: TelegramMessage
  telegram: TelegramApi
  startPayload?: string
  match: string[]
  updateType?: string
  reply(text: string, options?: Record<string, unknown>): Promise<unknown>
  replyWithPhoto(
    media: { source: Buffer } | { url: string },
    options?: { caption?: string },
  ): Promise<unknown>
  replyWithVideo(
    media: { url: string },
    options?: { caption?: string },
  ): Promise<unknown>
  sendChatAction(action: 'typing'): Promise<unknown>
  answerCbQuery(text?: string): Promise<unknown>
  editMessageText(text: string, options?: Record<string, unknown>): Promise<unknown>
}

type TelegramHandler = (context: TelegramContext) => unknown

interface TelegramBot {
  telegram: TelegramApi & {
    sendMessage?(chatId: string | number, text: string): Promise<unknown>
  }
  catch(handler: (error: unknown, context?: TelegramContext) => void): void
  start(handler: TelegramHandler): void
  action(pattern: RegExp, handler: TelegramHandler): void
  command(command: string, handler: TelegramHandler): void
  on(event: string, handler: TelegramHandler): void
  webhookCallback(path: string, options?: { secretToken?: string }): unknown
  launch(): Promise<unknown>
  stop(reason: string): void
}

interface TelegramMarkup {
  button: { callback(text: string, data: string): unknown }
  inlineKeyboard(buttons: unknown[][]): Record<string, unknown>
}

interface TelegramApp {
  use(handler: unknown): unknown
}

interface DownloadResponse { data: ArrayBuffer }

type HandleBotMessage = (
  from: string,
  text: string,
  businessPhone: null,
  options: { channel: 'telegram'; ctx: TelegramContext; slug: string },
) => Promise<unknown>

interface TelegramBotApi {
  transcribeAudio(buffer: Buffer, filename: string): Promise<string | null | undefined>
  handleImage(
    from: string,
    buffer: Buffer,
    mimeType: string,
    businessPhone: null,
    options: { channel: 'telegram'; ctx: TelegramContext; slug: string },
  ): Promise<unknown>
}

interface TelegramLogger {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
}

export interface TelegramDependencies {
  database: TelegramDatabase
  botApi: TelegramBotApi
  createBot(token: string): TelegramBot
  markup: TelegramMarkup
  download(url: string): Promise<DownloadResponse>
  env?: NodeJS.ProcessEnv
  logger?: TelegramLogger
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error) {
    const value = error as { description?: unknown; message?: unknown }
    if (typeof value.description === 'string') return value.description
    if (typeof value.message === 'string') return value.message
  }
  return String(error || 'Error desconocido')
}

function createTelegramIntegration(dependencies: TelegramDependencies) {
  const {
    database, botApi, createBot, markup, download,
  } = dependencies
  const env = dependencies.env || process.env
  const logger = dependencies.logger || console
  const onSignal = dependencies.onSignal || ((signal, listener) => {
    process.once(signal, listener)
  })
  const sessions = new Map<number, string>()
  let botInstance: TelegramBot | null = null

  async function restoreSession(chatId: number): Promise<string | null> {
    const contact = `tg_${chatId}`
    try {
      const businessId = await database.getLatestBusinessIdForContact(contact)
      if (!businessId) return null
      const business = await database.getBusinessById(businessId)
      if (business?.active && business.slug) {
        sessions.set(chatId, business.slug)
        return business.slug
      }
    } catch { /* una restauración fallida no bloquea la lista de negocios */ }
    return null
  }

  async function showBusinessList(context: TelegramContext): Promise<unknown> {
    const businesses = await database.getAllBusinesses()
    const active = businesses.filter(business => business.active)
    if (!active.length) {
      return context.reply('No hay negocios activos disponibles.')
    }
    const buttons = active.map(business => [
      markup.button.callback(`🏪 ${business.name}`, `select_${business.slug}`),
    ])
    return context.reply(
      '👋 *BotPanel — Modo pruebas*\n\nElige un negocio para chatear:',
      { parse_mode: 'Markdown', ...markup.inlineKeyboard(buttons) },
    )
  }

  async function setupTelegram(
    app: TelegramApp,
    handleMessage: HandleBotMessage,
  ): Promise<TelegramBot | null> {
    const token = env.TELEGRAM_BOT_TOKEN
    if (!token || token.length < 10) {
      logger.log('ℹ️  Telegram: configura TELEGRAM_BOT_TOKEN en .env para activarlo')
      return null
    }

    const bot = createBot(token)
    botInstance = bot
    bot.catch((error, context) => {
      logger.error(
        `❌ [Telegram] error en ${context?.updateType}:`,
        errorMessage(error),
      )
    })

    bot.start(async context => {
      const slug = context.startPayload
      if (slug) {
        const business = await database.getBusinessBySlug(slug)
        if (business?.active) {
          sessions.set(context.chat.id, slug)
          return context.reply(
            `✅ Conectado a *${business.name}*\n\nEscríbeme lo que necesitas.`,
            { parse_mode: 'Markdown' },
          )
        }
      }
      return showBusinessList(context)
    })

    bot.action(/^select_(.+)$/, async context => {
      const slug = context.match[1] || ''
      const business = await database.getBusinessBySlug(slug)
      if (!business?.active) {
        return context.answerCbQuery('Negocio no disponible')
      }
      sessions.set(context.chat.id, slug)
      await context.answerCbQuery()
      try {
        await context.editMessageText(
          `✅ Conectado a *${business.name}*\n\nEscríbeme lo que necesitas.`,
          { parse_mode: 'Markdown' },
        )
      } catch (error) {
        if (!/not modified/.test(errorMessage(error))) throw error
      }
      return undefined
    })

    bot.command('negocios', context => showBusinessList(context))
    bot.command('salir', context => {
      sessions.delete(context.chat.id)
      return context.reply('👋 Desconectado. Usa /negocios para elegir otro.')
    })

    bot.on('text', async context => {
      const chatId = context.chat.id
      let slug = sessions.get(chatId)
      if (!slug) slug = await restoreSession(chatId) || undefined
      if (!slug) return showBusinessList(context)
      const text = context.message.text
      if (!text) return undefined
      return handleMessage(`tg_${chatId}`, text, null, {
        channel: 'telegram', ctx: context, slug,
      })
    })

    const handleVoice: TelegramHandler = async context => {
      const chatId = context.chat.id
      let slug = sessions.get(chatId)
      if (!slug) slug = await restoreSession(chatId) || undefined
      if (!slug) return showBusinessList(context)

      const from = `tg_${chatId}`
      try {
        const fileId = context.message.voice?.file_id
          || context.message.audio?.file_id
        if (!fileId) return undefined
        const link = await context.telegram.getFileLink(fileId)
        const response = await download(link.href)
        const text = await botApi.transcribeAudio(
          Buffer.from(response.data), 'voz.ogg',
        )
        if (!text) {
          return context.reply(
            'No pude entender el audio 🙏 ¿Puedes escribirlo o enviarlo de nuevo?',
          )
        }
        logger.log(`🎙️  [TG] audio de ${from} transcrito: "${text}"`)
        return handleMessage(from, text, null, {
          channel: 'telegram', ctx: context, slug,
        })
      } catch (error) {
        logger.error('❌ TG audio:', errorMessage(error))
        return context.reply('Tuve un problema procesando tu audio 🙏 ¿Puedes escribirlo?')
      }
    }
    bot.on('voice', handleVoice)
    bot.on('audio', handleVoice)

    bot.on('photo', async context => {
      const chatId = context.chat.id
      let slug = sessions.get(chatId)
      if (!slug) slug = await restoreSession(chatId) || undefined
      if (!slug) return showBusinessList(context)
      const from = `tg_${chatId}`
      try {
        const photos = context.message.photo || []
        const fileId = photos[photos.length - 1]?.file_id
        if (!fileId) return undefined
        const link = await context.telegram.getFileLink(fileId)
        const response = await download(link.href)
        return botApi.handleImage(
          from,
          Buffer.from(response.data),
          'image/jpeg',
          null,
          { channel: 'telegram', ctx: context, slug },
        )
      } catch (error) {
        logger.error('❌ TG imagen:', errorMessage(error))
        return context.reply(
          'No pude procesar la imagen 🙏 ¿Puedes decirme el nombre del producto?',
        )
      }
    })

    const baseUrl = env.BASE_URL
    if (baseUrl) {
      const secretToken = env.TELEGRAM_WEBHOOK_SECRET?.trim()
      if (!secretToken) {
        throw new Error(
          'TELEGRAM_WEBHOOK_SECRET es obligatorio cuando Telegram usa webhook',
        )
      }
      const webhookUrl = `${baseUrl}/webhook/telegram`
      await bot.telegram.setWebhook(webhookUrl, { secret_token: secretToken })
      app.use(bot.webhookCallback('/webhook/telegram', { secretToken }))
      logger.log(`🤖 Telegram webhook activo: ${webhookUrl}`)
    } else {
      void bot.launch()
      logger.log('🤖 Telegram bot activo (polling — modo local)')
      onSignal('SIGINT', () => bot.stop('SIGINT'))
      onSignal('SIGTERM', () => bot.stop('SIGTERM'))
    }
    return bot
  }

  const getBotInstance = () => botInstance
  return { getBotInstance, restoreSession, setupTelegram, showBusinessList }
}

const { Telegraf, Markup } = require('telegraf') as {
  Telegraf: new (token: string) => TelegramBot
  Markup: TelegramMarkup
}
const axios = require('axios') as {
  get(url: string, options: Record<string, unknown>): Promise<DownloadResponse>
}

const integration = createTelegramIntegration({
  database: require('../db') as TelegramDatabase,
  botApi: require('../services/bot-entry') as TelegramBotApi,
  createBot: token => new Telegraf(token),
  markup: Markup,
  download: url => axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
  }),
})

export const setupTelegram = integration.setupTelegram
export const getBotInstance = integration.getBotInstance
export { createTelegramIntegration, errorMessage }
