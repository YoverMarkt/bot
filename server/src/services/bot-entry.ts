import { crearBuzonDeComprobantes, textoDelComprobante } from './payment-proof-inbox'
import type { ProcessMessageInput } from './bot-conversation'
import { atiendeSinIA } from './chat-mode'
import type { ScheduleRecord } from '../db/types'
import {
  normalizeChannelIdentifier,
  type WhatsAppChannelAddress,
} from '../types/channels'

// Sin `& Record<string, unknown>`: esa intersección dejaba leer cualquier campo
// inventado del negocio sin que el compilador dijera nada.
type EntryBusiness = ProcessMessageInput['business']
type TimerHandle = ReturnType<typeof setTimeout>

interface EntryDatabase {
  getBusinessBySlug(slug?: string | null): Promise<EntryBusiness | null>
  getBusinessByChannel(
    address: WhatsAppChannelAddress,
  ): Promise<EntryBusiness | null>
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
    deliveryMode?: 'queued' | 'direct',
  ): Promise<void>
  sendVideo(
    business: EntryBusiness,
    to: string,
    url: string,
    caption?: string,
    deliveryMode?: 'queued' | 'direct',
  ): Promise<void>
  // El enlace de la tienda como botón nativo. false = el canal no puede, y
  // quien llama manda el enlace como texto.
  sendLinkButton(
    business: EntryBusiness,
    to: string,
    message: { body: string; url: string; label: string; footer?: string | null },
    deliveryMode?: 'queued' | 'direct',
  ): Promise<boolean>
}

interface EntryMedia {
  getImageBuffer(product: { image_url?: string | null }): Promise<Buffer | null>
}

interface EntryPrompt {
  buildPrompt(...args: unknown[]): string
}

interface EntrySchedule {
  isOutsideHours(schedule: ScheduleRecord[] | null | undefined, now?: Date): boolean
  buildScheduleMessage(business: EntryBusiness, schedule: ScheduleRecord[]): string
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
  businessId?: string | null
  channelAddress?: WhatsAppChannelAddress
  /**
   * Los lotes ya consolidados por el inbox durable no deben esperar otra vez
   * en el buffer local. Es una señal interna del worker, nunca del webhook.
   */
  bypassDebounce?: boolean
  ctx?: TelegramContext
}

interface BufferedMessage {
  texts: string[]
  from: string
  timer?: TimerHandle
  businessPhone?: string | null
  options?: BotEntryOptions
  waiters: Array<{
    resolve(): void
    reject(error: unknown): void
  }>
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
  /**
   * Engancha al pedido la foto que llegó por el chat, si era un comprobante.
   *
   * Opcional a propósito: sin él, `handleImage` se comporta como siempre. Es
   * lo que permite que las pruebas del bot no toquen Cloudinary ni la base.
   */
  attachPaymentProof?: (
    businessId: string,
    contactPhone: string,
    imagen: Buffer,
  ) => Promise<{ adjuntado: boolean; orderNumber?: number | null }>
}

/**
 * El buzón de comprobantes, cableado a las piezas de verdad.
 *
 * Se arma aquí con carga diferida, como el resto de lo que habla con la nube:
 * `require` dentro de la función evita que un ciclo de importaciones tumbe el
 * arranque del bot.
 */
const adjuntarComprobante = crearBuzonDeComprobantes({
  ultimoPedido: (businessId, contactPhone) => {
    const db = require('../db') as typeof import('../db')
    return db.getLastOrderForContact(businessId, contactPhone)
  },
  subirPrivado: (buffer, businessId) => {
    const nube = require('../integrations/cloudinary') as typeof import('../integrations/cloudinary')
    return nube.uploadPrivateMedia(buffer, businessId)
  },
  adjuntar: (input) => {
    const db = require('../db') as typeof import('../db')
    return db.attachStorefrontPaymentProof(input)
  },
  registrarError: (input) => {
    const log = require('./error-log') as typeof import('./error-log')
    return log.recordError(input)
  },
})

function imageQuery(identified: string): string {
  if (!/NO_IDENTIFICADO/i.test(identified)) {
    return `El cliente envió una FOTO de este producto: "${identified}". Dile si lo tenemos disponible (búscalo en el catálogo) y su precio; si no lo tenemos, ofrécele alternativas similares del catálogo.`
  }
  return 'El cliente envió una foto de un producto pero no se pudo identificar con claridad. Pídele amablemente el nombre o la marca para ayudarlo a buscarlo.'
}

function createBotEntry(dependencies: BotEntryDependencies) {
  const { database, conversation, ai, whatsapp, media } = dependencies
  // Inyectable como todo lo demás de este archivo. Sin defecto NO se intenta
  // adjuntar nada: una prueba que no lo pase se comporta como antes, en vez de
  // colgarse llamando a la nube de verdad.
  const buzonDeComprobantes = dependencies.attachPaymentProof
  const logger = dependencies.logger || console
  const debounceMs = dependencies.debounceMs ?? 3000
  const setTimer = dependencies.setTimer || ((callback, milliseconds) => (
    setTimeout(callback, milliseconds)
  ))
  const clearTimer = dependencies.clearTimer || (timer => clearTimeout(timer))
  const messageBuffers = new Map<string, BufferedMessage>()
  const activeRuns = new Set<Promise<void>>()

  async function resolveWhatsAppBusiness(
    options: BotEntryOptions,
  ): Promise<EntryBusiness | null> {
    if (options.businessId) {
      if (!options.channelAddress) return null
      const business = await database.getBusinessByChannel(options.channelAddress)
      return business?.id === options.businessId ? business : null
    }
    if (!options.channelAddress) return null
    return database.getBusinessByChannel(options.channelAddress)
  }

  function bufferChannelKey(
    businessPhone: string | null | undefined,
    options: BotEntryOptions,
  ): string {
    if (options.channel === 'telegram') return `telegram:${options.slug || ''}`
    if (options.businessId) return `business:${options.businessId}`
    const address = options.channelAddress
    if (!address) return `whatsapp:unresolved:${businessPhone || ''}`
    const canonical = normalizeChannelIdentifier(
      address.identifierType,
      address.identifier,
    )
    return `whatsapp:${address.provider}:${address.identifierType}:${canonical || ''}`
  }

  async function processMessage(
    business: EntryBusiness,
    phone: string,
    text: string,
    send: (message: string) => Promise<unknown>,
    sendImage?: (
      url: string,
      caption?: string,
      deliveryMode?: 'queued' | 'direct',
    ) => Promise<unknown>,
    sendTyping?: () => Promise<unknown>,
    sendVideo?: (
      url: string,
      caption?: string,
      deliveryMode?: 'queued' | 'direct',
    ) => Promise<unknown>,
    sendLink?: (
      message: { body: string; url: string; label: string; footer?: string | null },
    ) => Promise<boolean>,
    /** El id del mensaje entrante: evita contar dos veces un reintento. */
    inboundId?: string | null,
  ): Promise<void> {
    return conversation.processMessage({
      business,
      phone,
      text,
      send,
      sendImage,
      sendTyping,
      sendVideo,
      sendLink,
      inboundId,
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
      logger.log(`\n📩 [TG:${options.slug}] mensaje recibido (${text.length} caracteres)`)
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

    const route = options.channelAddress
    logger.log(
      `\n📩 [WA:${route?.provider || 'sin proveedor'}] mensaje recibido (${text.length} caracteres)`,
    )
    const business = await resolveWhatsAppBusiness(options)
    if (!business) {
      logger.log('⚠️  Negocio o contexto de canal no encontrado')
      if (options.businessId) {
        throw new Error('El canal ya no pertenece al negocio que recibió el webhook')
      }
      return undefined
    }
    return processMessage(
      business,
      from,
      text,
      message => whatsapp.sendText(business, from, message),
      (url, caption, deliveryMode) => deliveryMode
        ? whatsapp.sendImage(business, from, url, caption, deliveryMode)
        : whatsapp.sendImage(business, from, url, caption),
      () => whatsapp.sendTyping(business, options.inboundId),
      (url, caption, deliveryMode) => deliveryMode
        ? whatsapp.sendVideo(business, from, url, caption, deliveryMode)
        : whatsapp.sendVideo(business, from, url, caption),
      // El enlace de la tienda va como botón nativo. Solo aquí: es el camino
      // del mensaje de texto entrante, que es el único que lo manda.
      message => whatsapp.sendLinkButton(business, from, message),
      options.inboundId,
    )
  }

  function executeBufferedMessage(
    key: string,
    buffer: BufferedMessage,
  ): Promise<void> {
    if (messageBuffers.get(key) === buffer) messageBuffers.delete(key)
    buffer.timer = undefined
    const combined = buffer.texts.join('\n').trim()
    const execution = runMessage(
      buffer.from,
      combined,
      buffer.businessPhone,
      buffer.options,
    ).then(() => {
      for (const waiter of buffer.waiters) waiter.resolve()
    }).catch((error: unknown) => {
      logger.error('❌ handleMessage:', error instanceof Error ? error.message : error)
      for (const waiter of buffer.waiters) waiter.reject(error)
    })
    activeRuns.add(execution)
    void execution.finally(() => activeRuns.delete(execution))
    return execution
  }

  function handleMessage(
    from: string,
    text: string,
    businessPhone?: string | null,
    options: BotEntryOptions = {},
  ): Promise<void> {
    if (options.bypassDebounce) {
      return runMessage(from, text, businessPhone, options).then(() => undefined)
    }

    const key = `${bufferChannelKey(businessPhone, options)}::${from}`
    const buffer = messageBuffers.get(key) || { texts: [], from, waiters: [] }
    const completion = new Promise<void>((resolve, reject) => {
      buffer.waiters.push({ resolve, reject })
    })
    buffer.texts.push(text)
    buffer.from = from
    buffer.businessPhone = businessPhone
    buffer.options = options
    if (buffer.timer) clearTimer(buffer.timer)
    buffer.timer = setTimer(() => {
      void executeBufferedMessage(key, buffer)
    }, debounceMs)
    messageBuffers.set(key, buffer)
    return completion
  }

  async function drainPendingMessages(): Promise<void> {
    while (messageBuffers.size) {
      const pending = [...messageBuffers.entries()]
      for (const [key, buffer] of pending) {
        if (buffer.timer) clearTimer(buffer.timer)
        void executeBufferedMessage(key, buffer)
      }
      await Promise.all(activeRuns)
    }
    await Promise.all(activeRuns)
  }

  async function handleImage(
    from: string,
    imageBuffer: Buffer,
    mimeType?: string | null,
    businessPhone?: string | null,
    options: BotEntryOptions = {},
  ): Promise<unknown> {
    // MODO MINI APP: la visión no se llega a pedir.
    //
    // `identifyImage` es una llamada a OpenAI, y en este modo su resultado no
    // se usa para nada: la respuesta va a ser el enlace o el recordatorio
    // mandes lo que mandes. El corte de `bot-conversation` llega DESPUÉS, así
    // que sin esto el gasto ya estaría hecho.
    //
    // Se resuelve el negocio antes de mirar la foto, y no al revés como
    // estaba: preguntar a quién pertenece el mensaje cuesta una consulta;
    // describir una imagen cuesta dinero.
    const negocioDeLaFoto = options.channel === 'telegram'
      ? await database.getBusinessBySlug(options.slug)
      : await resolveWhatsAppBusiness(options)
    if (!negocioDeLaFoto) {
      logger.log('⚠️  Negocio o contexto de canal no encontrado antes de mirar la foto')
      if (options.businessId) {
        throw new Error('El canal ya no pertenece al negocio que recibió el webhook')
      }
      if (options.channel === 'telegram') {
        return options.ctx?.reply('❌ Negocio no encontrado')
      }
      return undefined
    }
    const enMiniapp = atiendeSinIA(negocioDeLaFoto?.chat_mode)

    let identified = 'NO_IDENTIFICADO'
    if (enMiniapp) {
      // Se salta la visión y ya está: el flujo sigue igual y `processMessage`
      // corta más abajo mandando el enlace. Cambiar aquí el camino entero
      // obligaría a duplicar los `send` de cada canal para no ganar nada.
      logger.log('🛍️  foto en modo mini app: no se pasa por visión')
    } else {
      const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`
      try {
        identified = await ai.identifyImage(dataUrl)
      } catch (error) {
        logger.error('❌ visión:', error instanceof Error ? error.message : error)
      }
    }
    const wasIdentified = !/NO_IDENTIFICADO/i.test(identified)
    logger.log(`🖼️  imagen procesada: ${wasIdentified ? 'identificada' : 'no identificada'}`)

    // ⚠️ ¿Era el comprobante de un pedido que espera pago? La mayoría de la
    // gente transfiere desde su banco y manda la captura POR EL CHAT, y hasta
    // hoy esa foto se perdía: el dueño la veía en su WhatsApp, el panel nunca
    // activaba «Ver comprobante» y el cliente se quedaba atascado en la
    // pantalla de pago. Si lo era, ya quedó adjunta al pedido y el texto que
    // sigue lo dice — para el dueño que lee su chat y para la respuesta.
    //
    // Solo se intenta si hay un pedido esperando pago; si no, no se sube nada.
    let query = imageQuery(identified)
    if (buzonDeComprobantes && negocioDeLaFoto?.id) {
      const comprobante = await buzonDeComprobantes(
        String(negocioDeLaFoto.id), from, imageBuffer,
      )
      if (comprobante.adjuntado) query = textoDelComprobante(comprobante.orderNumber)
    }

    if (options.channel === 'telegram') {
      const business = negocioDeLaFoto
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

    const business = negocioDeLaFoto
    return processMessage(
      business,
      from,
      query,
      message => whatsapp.sendText(business, from, message),
      (url, caption) => whatsapp.sendImage(business, from, url, caption),
      () => whatsapp.sendTyping(business, options.inboundId),
      (url, caption) => whatsapp.sendVideo(business, from, url, caption),
      message => whatsapp.sendLinkButton(business, from, message),
      options.inboundId,
    )
  }

  const sendWhatsAppMessage = (
    business: EntryBusiness,
    to: string,
    text: string,
  ) => whatsapp.sendText(business, to, text)

  return {
    drainPendingMessages,
    handleImage,
    handleMessage,
    processMessage,
    runMessage,
    sendWhatsAppMessage,
  }
}

const database: EntryDatabase = require('../db') as typeof import('../db')
const conversation: EntryConversation = require('./bot-conversation') as typeof import('./bot-conversation')
const ai: EntryAi = require('./ai') as typeof import('./ai')
const whatsapp: EntryWhatsApp = require('../integrations/whatsapp') as typeof import('../integrations/whatsapp')
const media: EntryMedia = require('./media') as typeof import('./media')
const prompt: EntryPrompt = require('./prompt') as typeof import('./prompt')
const schedule: EntrySchedule = require('./schedule') as typeof import('./schedule')

const entry = createBotEntry({
  database, conversation, ai, whatsapp, media,
  attachPaymentProof: adjuntarComprobante,
})

export const handleImage = entry.handleImage
export const handleMessage = entry.handleMessage
export const drainPendingMessages = entry.drainPendingMessages
export const processMessage = entry.processMessage
export const sendWhatsAppMessage = entry.sendWhatsAppMessage
export const buildPrompt = prompt.buildPrompt
export const buildScheduleMessage = schedule.buildScheduleMessage
export const isOutsideHours = schedule.isOutsideHours
export const callAI = ai.callAI
export const transcribeAudio = ai.transcribeAudio
export const embedText = ai.embedText
export const indexProduct = ai.indexProduct
export { createBotEntry, imageQuery, adjuntarComprobante }
