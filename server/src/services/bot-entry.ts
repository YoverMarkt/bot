import type { ProcessMessageInput } from './bot-conversation'

type EntryBusiness = ProcessMessageInput['business'] & Record<string, unknown>
type TimerHandle = ReturnType<typeof setTimeout>

interface EntryDatabase {
  getBusinessBySlug(slug?: string | null): Promise<EntryBusiness | null>
  getBusinessByPhone(phone?: string | null): Promise<EntryBusiness | null>
}

interface EntryConversation {
  processMessage(input: ProcessMessageInput): Promise<void>
}

interface EntryAi {
  identifyImage(dataUrl: string): Promise<string>
  callAI(...args: unknown[]): Promise<string>
  transcribeAudio(buffer: Buffer, filename?: string): Promise<string>
  embedText(text: string): Promise<number[]>
  indexProduct(product: unknown): Promise<boolean>
}

interface EntryWhatsApp {
  sendTyping(business: EntryBusiness, inboundId?: string | null): Promise<void>
  sendText(business: EntryBusiness, to: string, text: string): Promise<void>
  sendImage(
    business: EntryBusiness,
    to: string,
    url: string,
    caption?: string,
  ): Promise<void>
  sendVideo(
    business: EntryBusiness,
    to: string,
    url: string,
    caption?: string,
  ): Promise<void>
}

interface EntryMedia {
  getImageBuffer(product: { image_url?: string | null }): Promise<Buffer | null>
}

interface EntryPrompt {
  buildPrompt(...args: unknown[]): string
}

interface EntrySchedule {
  isOutsideHours(schedule: unknown[]): boolean
  buildScheduleMessage(business: EntryBusiness, schedule: unknown[]): string
}

interface EntryLogger {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
}

interface TelegramContext {
  reply(text: string): Promise<unknown>
  replyWithPhoto(
    media: { source: Buffer } | { url: string },
    options?: { caption?: string },
  ): Promise<unknown>
  replyWithVideo(
    media: { url: string },
    options?: { caption?: string },
  ): Promise<unknown>
  sendChatAction(action: 'typing'): Promise<unknown>
}

export interface BotEntryOptions {
  channel?: string
  slug?: string | null
  inboundId?: string | null
  ctx?: TelegramContext
}

interface BufferedMessage {
  texts: string[]
  timer?: TimerHandle
  businessPhone?: string | null
  options?: BotEntryOptions
}

export interface BotEntryDependencies {
  database: EntryDatabase
  conversation: EntryConversation
  ai: EntryAi
  whatsapp: EntryWhatsApp
  media: EntryMedia
  logger?: EntryLogger
  debounceMs?: number
  setTimer?: (callback: () => void, milliseconds: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
}

function imageQuery(identified: string): string {
  if (!/NO_IDENTIFICADO/i.test(identified)) {
    return `El cliente envió una FOTO de este producto: "${identified}". Dile si lo tenemos disponible (búscalo en el catálogo) y su precio; si no lo tenemos, ofrécele alternativas similares del catálogo.`
  }
  return 'El cliente envió una foto de un producto pero no se pudo identificar con claridad. Pídele amablemente el nombre o la marca para ayudarlo a buscarlo.'
}

function createBotEntry(dependencies: BotEntryDependencies) {
  const { database, conversation, ai, whatsapp, media } = dependencies
  const logger = dependencies.logger || console
  const debounceMs = dependencies.debounceMs ?? 3000
  const setTimer = dependencies.setTimer || ((callback, milliseconds) => (
    setTimeout(callback, milliseconds)
  ))
  const clearTimer = dependencies.clearTimer || (timer => clearTimeout(timer))
  const messageBuffers = new Map<string, BufferedMessage>()

  async function processMessage(
    business: EntryBusiness,
    phone: string,
    text: string,
    send: (message: string) => Promise<unknown>,
    sendImage?: (url: string, caption?: string) => Promise<unknown>,
    sendTyping?: () => Promise<unknown>,
    sendVideo?: (url: string, caption?: string) => Promise<unknown>,
  ): Promise<void> {
    return conversation.processMessage({
      business,
      phone,
      text,
      send,
      sendImage,
      sendTyping,
      sendVideo,
    })
  }

  async function runMessage(
    from: string,
    text: string,
    businessPhone?: string | null,
    options: BotEntryOptions = {},
  ): Promise<unknown> {
    if (options.channel === 'telegram') {
      const business = await database.getBusinessBySlug(options.slug)
      if (!business) return options.ctx?.reply('❌ Negocio no encontrado')
      logger.log(`\n📩 [TG:${options.slug}] de ${from}: "${text}"`)
      const context = options.ctx
      if (!context) return undefined
      return processMessage(
        business,
        from,
        text,
        message => context.reply(message),
        async (url, caption) => {
          try {
            const buffer = await media.getImageBuffer({ image_url: url })
            if (buffer) {
              await context.replyWithPhoto({ source: buffer }, { caption })
            } else {
              await context.replyWithPhoto({ url }, { caption })
            }
          } catch (error) {
            logger.error(
              '❌ TG foto:', error instanceof Error ? error.message : error,
            )
          }
        },
        () => context.sendChatAction('typing'),
        async (url, caption) => {
          try {
            await context.replyWithVideo({ url }, { caption })
          } catch (error) {
            logger.error(
              '❌ TG video:', error instanceof Error ? error.message : error,
            )
          }
        },
      )
    }

    logger.log(`\n📩 [WA:${businessPhone}] de ${from}: "${text}"`)
    const business = await database.getBusinessByPhone(businessPhone)
    if (!business) {
      logger.log('⚠️  Negocio no encontrado:', businessPhone)
      return undefined
    }
    return processMessage(
      business,
      from,
      text,
      message => whatsapp.sendText(business, from, message),
      (url, caption) => whatsapp.sendImage(business, from, url, caption),
      () => whatsapp.sendTyping(business, options.inboundId),
      (url, caption) => whatsapp.sendVideo(business, from, url, caption),
    )
  }

  async function handleMessage(
    from: string,
    text: string,
    businessPhone?: string | null,
    options: BotEntryOptions = {},
  ): Promise<void> {
    const key = `${options.slug || businessPhone || ''}::${from}`
    const buffer = messageBuffers.get(key) || { texts: [] }
    buffer.texts.push(text)
    buffer.businessPhone = businessPhone
    buffer.options = options
    if (buffer.timer) clearTimer(buffer.timer)
    buffer.timer = setTimer(() => {
      messageBuffers.delete(key)
      const combined = buffer.texts.join('\n').trim()
      void runMessage(
        from, combined, buffer.businessPhone, buffer.options,
      ).catch(error => logger.error(
        '❌ handleMessage:', error instanceof Error ? error.message : error,
      ))
    }, debounceMs)
    messageBuffers.set(key, buffer)
  }

  async function handleImage(
    from: string,
    imageBuffer: Buffer,
    mimeType?: string | null,
    businessPhone?: string | null,
    options: BotEntryOptions = {},
  ): Promise<unknown> {
    const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`
    let identified = 'NO_IDENTIFICADO'
    try {
      identified = await ai.identifyImage(dataUrl)
    } catch (error) {
      logger.error('❌ visión:', error instanceof Error ? error.message : error)
    }
    const wasIdentified = !/NO_IDENTIFICADO/i.test(identified)
    logger.log(`🖼️  imagen de ${from}: ${wasIdentified ? identified : 'no identificado'}`)
    const query = imageQuery(identified)

    if (options.channel === 'telegram') {
      const business = await database.getBusinessBySlug(options.slug)
      if (!business) return options.ctx?.reply('❌ Negocio no encontrado')
      const context = options.ctx
      if (!context) return undefined
      return processMessage(
        business,
        from,
        query,
        message => context.reply(message),
        async (url, caption) => {
          try {
            const buffer = await media.getImageBuffer({ image_url: url })
            if (buffer) {
              await context.replyWithPhoto({ source: buffer }, { caption })
            }
          } catch { /* el envío de foto en Telegram es best-effort */ }
        },
        () => context.sendChatAction('typing'),
        async (url, caption) => {
          try {
            await context.replyWithVideo({ url }, { caption })
          } catch (error) {
            logger.error(
              '❌ TG video:', error instanceof Error ? error.message : error,
            )
          }
        },
      )
    }

    const business = await database.getBusinessByPhone(businessPhone)
    if (!business) {
      logger.log('⚠️  Negocio no encontrado:', businessPhone)
      return undefined
    }
    return processMessage(
      business,
      from,
      query,
      message => whatsapp.sendText(business, from, message),
      (url, caption) => whatsapp.sendImage(business, from, url, caption),
      () => whatsapp.sendTyping(business, options.inboundId),
      (url, caption) => whatsapp.sendVideo(business, from, url, caption),
    )
  }

  const sendWhatsAppMessage = (
    business: EntryBusiness,
    to: string,
    text: string,
  ) => whatsapp.sendText(business, to, text)

  return {
    handleImage,
    handleMessage,
    processMessage,
    runMessage,
    sendWhatsAppMessage,
  }
}

const database = require('../db') as EntryDatabase
const conversation = require('./bot-conversation') as EntryConversation
const ai = require('./ai') as EntryAi
const whatsapp = require('../integrations/whatsapp') as EntryWhatsApp
const media = require('./media') as EntryMedia
const prompt = require('./prompt') as EntryPrompt
const schedule = require('./schedule') as EntrySchedule

const entry = createBotEntry({ database, conversation, ai, whatsapp, media })

export const handleImage = entry.handleImage
export const handleMessage = entry.handleMessage
export const processMessage = entry.processMessage
export const sendWhatsAppMessage = entry.sendWhatsAppMessage
export const buildPrompt = prompt.buildPrompt
export const buildScheduleMessage = schedule.buildScheduleMessage
export const isOutsideHours = schedule.isOutsideHours
export const callAI = ai.callAI
export const transcribeAudio = ai.transcribeAudio
export const embedText = ai.embedText
export const indexProduct = ai.indexProduct
export { createBotEntry, imageQuery }
