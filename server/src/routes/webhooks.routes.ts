import axios from 'axios'
import crypto from 'node:crypto'
import type { Request } from 'express'
import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'

interface BusinessRecord {
  id?: string
  meta_token?: string | null
  kapso_api_key?: string | null
}

interface MediaReference {
  id?: string
  link?: string
  url?: string
}

interface InboundMessage {
  id?: string
  wamid?: string
  from?: string
  to?: string
  type?: string
  timestamp?: string | number
  sendTime?: string | number
  body?: string
  text?: { body?: string }
  interactive?: {
    button_reply?: { title?: string }
    list_reply?: { title?: string }
  }
  audio?: MediaReference
  voice?: MediaReference
  image?: MediaReference
  media?: MediaReference
  whatsappApiAccountPhoneNumber?: string
}

interface MetaWebhookBody {
  object?: string
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: InboundMessage[]
        metadata?: { display_phone_number?: string }
      }
    }>
  }>
}

interface KapsoWebhookBody {
  id?: string
  from?: string
  to?: string
  number_id?: string
  text?: string
  message?: InboundMessage
  messages?: InboundMessage[]
  audio?: MediaReference
}

interface YCloudWebhookBody {
  type?: string
  whatsappInboundMessage?: InboundMessage
}

interface MessageOptions {
  inboundId?: string
}

const db = require('../db') as {
  getBusinessByPhone(phone: string | undefined): Promise<BusinessRecord | null>
  claimWebhookEvent(
    businessId: string,
    provider: WebhookProvider,
    messageId: string,
  ): Promise<{ data?: boolean | null; error?: { message?: string } | null }>
}
const bot = require('../services/bot-entry') as {
  handleMessage(
    from: string | undefined,
    message: string | undefined,
    businessPhone: string | undefined,
    options?: MessageOptions,
  ): Promise<unknown>
  transcribeAudio(data: Buffer, filename: string): Promise<string | null | undefined>
  handleImage(
    from: string,
    data: Buffer,
    mimeType: string,
    businessPhone: string,
    options: MessageOptions,
  ): Promise<unknown>
}

const router = createRouter()
type WebhookProvider = 'meta' | 'ycloud' | 'kapso'

const isProduction = () => process.env.NODE_ENV === 'production' || Boolean(process.env.BASE_URL)

function verifyMetaSignature(req: Request): boolean {
  const secret = process.env.META_APP_SECRET
  if (!secret) return !isProduction()
  const signature = req.headers['x-hub-signature-256']
  if (typeof signature !== 'string' || !req.rawBody) return false
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex')}`
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

function verifyWebhookSecret(req: Request): boolean {
  const secret = process.env.WEBHOOK_SECRET
  if (!secret) return !isProduction()
  const received = req.query.secret || req.headers['x-webhook-secret']
  try {
    return Boolean(received) && crypto.timingSafeEqual(
      Buffer.from(String(received)),
      Buffer.from(secret),
    )
  } catch {
    return false
  }
}

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit' },
})

const seenInbound = new Map<string, number>()
const SEEN_TTL = 15 * 60 * 1000

function isDuplicateInMemory(cacheKey: string): boolean {
  const now = Date.now()
  if (seenInbound.size > 5000) {
    for (const [key, timestamp] of seenInbound) {
      if (now - timestamp > SEEN_TTL) seenInbound.delete(key)
    }
  }
  return seenInbound.has(cacheKey)
}

function rememberInbound(cacheKey: string): void {
  seenInbound.set(cacheKey, Date.now())
}

async function claimInbound(
  provider: WebhookProvider,
  messageId: string | undefined,
  businessPhone: string | undefined,
): Promise<boolean> {
  if (!messageId || !businessPhone) return true
  const business = await db.getBusinessByPhone(businessPhone)
  if (!business?.id) return true
  const cacheKey = `${business.id}:${provider}:${messageId}`
  if (isDuplicateInMemory(cacheKey)) return false

  const { data, error } = await db.claimWebhookEvent(business.id, provider, messageId)
  if (error) throw new Error(error.message || 'No se pudo reclamar el webhook')
  rememberInbound(cacheKey)
  if (!data) return false
  return true
}

function isStaleInbound(timestamp?: string | number): boolean {
  if (!timestamp) return false
  const parsed = typeof timestamp === 'number'
    ? (timestamp > 1e12 ? timestamp : timestamp * 1000)
    : Date.parse(timestamp)
  if (Number.isNaN(parsed)) return false
  return Date.now() - parsed > 10 * 60 * 1000
}

function loggedError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

router.get('/webhook', (req, res) => {
  const {
    'hub.mode': mode,
    'hub.verify_token': token,
    'hub.challenge': challenge,
  } = req.query
  const expectedToken = process.env.META_VERIFY_TOKEN
  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    console.log('✅ Webhook Meta verificado')
    return res.status(200).send(challenge || 'OK')
  }
  res.sendStatus(403)
})

router.post('/webhook', webhookLimiter, async (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn('⚠️  Webhook Meta: firma inválida — rechazado')
    return res.sendStatus(401)
  }
  const body = req.body as MetaWebhookBody
  if (body.object !== 'whatsapp_business_account') return res.sendStatus(200)
  const value = body.entry?.[0]?.changes?.[0]?.value
  if (!value?.messages?.length) return res.sendStatus(200)
  const message = value.messages[0]
  const from = message.from
  const businessPhone = value.metadata?.display_phone_number
  if (isStaleInbound(message.timestamp)) {
    console.log(`🔁 [Meta] mensaje viejo ignorado (${message.id || 'sin id'})`)
    return res.sendStatus(200)
  }
  try {
    if (!await claimInbound('meta', message.id, businessPhone)) {
      console.log(`🔁 [Meta] mensaje duplicado ignorado (${message.id || 'sin id'})`)
      return res.sendStatus(200)
    }
  } catch (error) {
    console.error('❌ Webhook Meta deduplicación:', loggedError(error))
    return res.sendStatus(503)
  }

  res.sendStatus(200)
  try {
    if (message.type === 'text') {
      await bot.handleMessage(from, message.text?.body, businessPhone)
    }
    if (message.type === 'interactive') {
      const reply = message.interactive?.button_reply?.title
        || message.interactive?.list_reply?.title
        || ''
      if (reply) await bot.handleMessage(from, reply, businessPhone)
    }
    if ((message.type === 'audio' || message.type === 'voice') && message.audio?.id) {
      const business = await db.getBusinessByPhone(businessPhone)
      if (business?.meta_token) {
        const media = await axios.get<{ url: string }>(
          `https://graph.facebook.com/v19.0/${message.audio.id}`,
          {
            headers: { Authorization: `Bearer ${business.meta_token}` },
            timeout: 15000,
          },
        )
        const audioResponse = await axios.get<ArrayBuffer>(media.data.url, {
          headers: { Authorization: `Bearer ${business.meta_token}` },
          responseType: 'arraybuffer',
          timeout: 20000,
        })
        const text = await bot.transcribeAudio(Buffer.from(audioResponse.data), 'audio.ogg')
        if (text) {
          console.log(`🎙️  [Meta] audio transcrito: "${text}"`)
          await bot.handleMessage(from, text, businessPhone)
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook Meta:', loggedError(error))
  }
})

router.post('/webhook/kapso', webhookLimiter, async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.sendStatus(401)
  const body = req.body as KapsoWebhookBody
  const message = body.message || body.messages?.[0]
  const messageId = message?.id || body.id
  const from = message?.from || body.from
  const text = message?.text?.body || message?.body || body.text
  const businessPhone = body.to || body.number_id
  try {
    if (!await claimInbound('kapso', messageId, businessPhone)) {
      console.log(`🔁 [Kapso] mensaje duplicado ignorado (${messageId})`)
      return res.sendStatus(200)
    }
  } catch (error) {
    console.error('❌ Webhook Kapso deduplicación:', loggedError(error))
    return res.sendStatus(503)
  }

  res.sendStatus(200)
  try {
    if (from && text && businessPhone) {
      console.log(`📡 Kapso: de ${from} → ${businessPhone}: "${text}"`)
      await bot.handleMessage(from, text, businessPhone)
    } else if (from && businessPhone) {
      const audioUrl = message?.audio?.url
        || message?.audio?.link
        || message?.media?.url
        || body.audio?.url
      if (audioUrl) {
        const business = await db.getBusinessByPhone(businessPhone)
        const apiKey = business?.kapso_api_key || process.env.KAPSO_API_KEY
        const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
        const audioResponse = await axios.get<ArrayBuffer>(audioUrl, {
          headers,
          responseType: 'arraybuffer',
          timeout: 20000,
        })
        const transcript = await bot.transcribeAudio(
          Buffer.from(audioResponse.data),
          'audio.ogg',
        )
        if (transcript) {
          console.log(`🎙️  [Kapso] audio transcrito: "${transcript}"`)
          await bot.handleMessage(from, transcript, businessPhone)
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook Kapso:', loggedError(error))
  }
})

router.post('/webhook/ycloud', webhookLimiter, async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.sendStatus(401)
  const body = req.body as YCloudWebhookBody
  console.log(`📨 [YCloud webhook] recibido — type: ${body.type || '(sin type)'}`)
  if (body.type !== 'whatsapp.inbound_message.received') return res.sendStatus(200)
  const message = body.whatsappInboundMessage
  if (!message) return res.sendStatus(200)
  const from = message.from
  const businessPhone = message.whatsappApiAccountPhoneNumber || message.to
  const inboundId = message.id || message.wamid
  if (!from || !businessPhone) return res.sendStatus(200)
  if (isStaleInbound(message.sendTime)) {
    console.log(`🔁 [YCloud] mensaje viejo ignorado (${inboundId || 'sin id'})`)
    return res.sendStatus(200)
  }
  try {
    if (!await claimInbound('ycloud', inboundId, businessPhone)) {
      console.log(`🔁 [YCloud] mensaje duplicado ignorado (${inboundId || 'sin id'})`)
      return res.sendStatus(200)
    }
  } catch (error) {
    console.error('❌ Webhook YCloud deduplicación:', loggedError(error))
    return res.sendStatus(503)
  }

  res.sendStatus(200)
  try {
    if (message.type === 'text' && message.text?.body) {
      console.log(`📡 YCloud: de ${from} → ${businessPhone}: "${message.text.body}"`)
      await bot.handleMessage(from, message.text.body, businessPhone, { inboundId })
    } else if (message.type === 'audio' || message.type === 'voice') {
      const audioUrl = message.audio?.link || message.audio?.url || message.voice?.link
      if (audioUrl) {
        const audioResponse = await axios.get<ArrayBuffer>(audioUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
        })
        const transcript = await bot.transcribeAudio(
          Buffer.from(audioResponse.data),
          'audio.ogg',
        )
        if (transcript) {
          console.log(`🎙️  [YCloud] audio transcrito: "${transcript}"`)
          await bot.handleMessage(from, transcript, businessPhone, { inboundId })
        }
      }
    } else if (message.type === 'image') {
      const imageUrl = message.image?.link || message.image?.url
      if (imageUrl) {
        const imageResponse = await axios.get<ArrayBuffer>(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
        })
        const contentType = imageResponse.headers['content-type']
        const mime = typeof contentType === 'string' ? contentType : 'image/jpeg'
        console.log(`🖼️  [YCloud] imagen recibida de ${from}`)
        await bot.handleImage(
          from,
          Buffer.from(imageResponse.data),
          mime,
          businessPhone,
          { inboundId },
        )
      }
    }
  } catch (error) {
    console.error('❌ Webhook YCloud:', loggedError(error))
  }
})

export = router
