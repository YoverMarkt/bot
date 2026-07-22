import crypto from 'node:crypto'
import type { Request } from 'express'
import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import { resolveBusinessChannel } from '../services/channel-resolution'
import {
  inboundConversationKey,
  type InboundWebhookPayload,
} from '../services/inbound-webhook'
import { verifyYCloudSignature } from '../services/webhook-signatures'
import type {
  ChannelAddress,
  ChannelIdentifierType,
  WhatsAppChannelAddress,
  WhatsAppProvider,
} from '../types/channels'

interface BusinessRecord {
  id: string
  ycloud_webhook_endpoint_id?: string | null
  ycloud_webhook_secret?: string | null
}

interface MediaReference {
  id?: string
  link?: string
  url?: string
  mime_type?: string
}

interface InboundMessage {
  id?: string
  wamid?: string
  from?: string
  to?: string
  type?: string
  timestamp?: string | number
  sendTime?: string | number
  text?: { body?: string }
  button?: { text?: string; payload?: string }
  interactive?: {
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string }
  }
  audio?: MediaReference
  voice?: MediaReference
  image?: MediaReference
  whatsappApiAccountPhoneNumber?: string
}

interface MetaWebhookBody {
  object?: string
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: InboundMessage[]
        metadata?: {
          display_phone_number?: string
          phone_number_id?: string
        }
      }
    }>
  }>
}

interface YCloudWebhookBody {
  id?: string
  type?: string
  createTime?: string
  whatsappInboundMessage?: InboundMessage
}

const db = require('../db') as {
  getBusinessByChannel(address: ChannelAddress): Promise<BusinessRecord | null>
  enqueueWebhookEvent(
    businessId: string,
    provider: WebhookProvider,
    messageId: string,
    conversationKey: string,
    payload: InboundWebhookPayload,
  ): Promise<{ data?: boolean | null; error?: { message?: string } | null }>
}

const router = createRouter()
type WebhookProvider = WhatsAppProvider

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

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit' },
})

function channelAddresses(
  provider: WebhookProvider,
  identifiers: Array<{
    identifierType: ChannelIdentifierType
    value?: string | null
  }>,
): WhatsAppChannelAddress[] {
  return identifiers.flatMap(({ identifierType, value }) => {
    if (typeof value !== 'string' || !value.trim()) return []
    return [{ provider, identifierType, identifier: value }]
  })
}

function firstIdentifier(
  ...values: Array<string | null | undefined>
): string | undefined {
  const value = values.find(
    candidate => typeof candidate === 'string' && Boolean(candidate.trim()),
  )
  return typeof value === 'string' ? value : undefined
}

interface ResolvedInbound {
  business: BusinessRecord
  address: WhatsAppChannelAddress
}

async function enqueueResolvedInbound(
  provider: WebhookProvider,
  messageId: string,
  resolved: ResolvedInbound,
  payload: InboundWebhookPayload,
): Promise<'accepted' | 'duplicate'> {
  const { data, error } = await db.enqueueWebhookEvent(
    resolved.business.id,
    provider,
    messageId,
    inboundConversationKey(payload),
    payload,
  )
  if (error) throw new Error(error.message || 'No se pudo persistir el webhook')
  return data ? 'accepted' : 'duplicate'
}

function loggedError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function metaMessages(body: MetaWebhookBody): Array<{
  message: InboundMessage
  addresses: WhatsAppChannelAddress[]
}> {
  return (body.entry || []).flatMap(entry => (
    (entry.changes || []).flatMap((change) => {
      const value = change.value
      if (!value) return []
      const metaPhoneId = firstIdentifier(value.metadata?.phone_number_id)
      const addresses = channelAddresses('meta', metaPhoneId
        ? [{ identifierType: 'account_id', value: metaPhoneId }]
        : [{
            identifierType: 'phone',
            value: value.metadata?.display_phone_number,
          }])
      return (value.messages || []).map(message => ({ message, addresses }))
    })
  ))
}

function metaContent(message: InboundMessage): InboundWebhookPayload['content'] | null {
  const text = message.type === 'text'
    ? message.text?.body
    : message.type === 'button'
      ? message.button?.text
      : message.type === 'interactive'
        ? message.interactive?.button_reply?.title
          || message.interactive?.list_reply?.title
        : undefined
  if (text?.trim()) return { kind: 'text', text }
  if ((message.type === 'audio' || message.type === 'voice') && message.audio?.id) {
    return {
      kind: 'audio',
      media: { id: message.audio.id, mimeType: message.audio.mime_type },
    }
  }
  if (message.type === 'image' && message.image?.id) {
    return {
      kind: 'image',
      media: { id: message.image.id, mimeType: message.image.mime_type },
    }
  }
  return null
}

function headerText(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function ycloudContent(message: InboundMessage): InboundWebhookPayload['content'] | null {
  let text: string | undefined
  if (message.type === 'text') text = message.text?.body
  if (message.type === 'button') text = message.button?.text
  if (message.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply
    // El id que enviamos es el NÚMERO de la opción; el menú ya entiende
    // números, y así el emparejamiento no depende del título, que WhatsApp
    // trunca a 20-24 caracteres.
    const id = String(reply?.id || '').trim()
    text = /^\d{1,2}$/.test(id) ? id : reply?.title
  }
  if (text?.trim()) return { kind: 'text', text }
  const kind = message.type === 'image'
    ? 'image'
    : message.type === 'audio' || message.type === 'voice'
      ? 'audio'
      : null
  const reference = kind === 'image' ? message.image : message.audio || message.voice
  const url = reference?.link || reference?.url
  if (!kind || !url) return null
  return {
    kind,
    media: { url, mimeType: reference?.mime_type },
  }
}

function durablePayload(
  provider: WebhookProvider,
  message: InboundMessage,
  inboundId: string,
  resolved: ResolvedInbound,
  content: InboundWebhookPayload['content'],
): InboundWebhookPayload {
  return {
    version: 1,
    provider,
    businessId: resolved.business.id,
    from: message.from || '',
    inboundId,
    channelAddress: resolved.address,
    content,
  }
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
  const deliveries = metaMessages(body).filter(({ message, addresses }) => (
    Boolean(message.id && message.from && addresses.length && metaContent(message))
  ))
  if (!deliveries.length) return res.sendStatus(200)

  try {
    for (const { message, addresses } of deliveries) {
      const resolved = await resolveBusinessChannel(db, addresses)
      if (!resolved) {
        console.warn('⚠️  [Meta] canal sin negocio exacto — mensaje ignorado')
        continue
      }
      const messageId = message.id
      const content = metaContent(message)
      if (!messageId || !content) continue
      const payload = durablePayload('meta', message, messageId, resolved, content)
      const status = await enqueueResolvedInbound('meta', messageId, resolved, payload)
      if (status === 'duplicate') {
        console.log(`🔁 [Meta] mensaje duplicado ignorado (${messageId})`)
      }
    }
  } catch (error) {
    console.error('❌ Webhook Meta persistencia:', loggedError(error))
    return res.sendStatus(503)
  }

  return res.sendStatus(200)
})

router.post('/webhook/ycloud', webhookLimiter, async (req, res) => {
  const body = req.body as YCloudWebhookBody
  console.log(`📨 [YCloud webhook] recibido — type: ${body.type || '(sin type)'}`)
  if (body.type !== 'whatsapp.inbound_message.received') return res.sendStatus(200)
  const message = body.whatsappInboundMessage
  if (!message) return res.sendStatus(200)
  const from = message.from
  const addresses = channelAddresses('ycloud', [{
    identifierType: 'phone',
    value: firstIdentifier(
      message.to,
      message.whatsappApiAccountPhoneNumber,
    ),
  }])
  const inboundId = message.id || message.wamid
  const eventId = body.id || inboundId
  if (!from || !inboundId || !eventId || !addresses.length) {
    console.warn('⚠️  [YCloud] payload inbound incompleto — mensaje ignorado')
    return res.sendStatus(200)
  }

  let resolved: {
    business: BusinessRecord
    address: WhatsAppChannelAddress
  } | null
  try {
    resolved = await resolveBusinessChannel(db, addresses)
  } catch (error) {
    console.error('❌ Webhook YCloud resolución:', loggedError(error))
    return res.sendStatus(503)
  }
  if (!resolved) {
    console.warn('⚠️  [YCloud] canal sin negocio exacto — mensaje ignorado')
    return res.sendStatus(200)
  }

  const endpointId = headerText(req.headers['x-webhook-endpoint-id'])
  const configuredEndpointId = resolved.business.ycloud_webhook_endpoint_id?.trim()
    || process.env.YCLOUD_WEBHOOK_ENDPOINT_ID?.trim()
  if (!configuredEndpointId && isProduction()) {
    console.error('❌ Webhook YCloud: falta configurar el Endpoint ID')
    return res.sendStatus(503)
  }
  if (configuredEndpointId && endpointId !== configuredEndpointId) {
    console.warn('⚠️  [YCloud] Endpoint ID inválido — rechazado')
    return res.sendStatus(401)
  }
  const signingSecret = resolved.business.ycloud_webhook_secret?.trim()
    || process.env.YCLOUD_WEBHOOK_SECRET?.trim()
  if (!signingSecret) {
    if (isProduction()) {
      console.error('❌ Webhook YCloud: falta el signing secret oficial')
      return res.sendStatus(503)
    }
  } else if (!verifyYCloudSignature(
    req.rawBody,
    req.headers['ycloud-signature'],
    signingSecret,
  )) {
    console.warn('⚠️  [YCloud] firma inválida o fuera de tiempo — rechazado')
    return res.sendStatus(401)
  }

  const content = ycloudContent(message)
  if (!content) {
    console.log(`ℹ️  [YCloud] tipo inbound no soportado ignorado (${message.type || 'sin tipo'})`)
    return res.sendStatus(200)
  }

  try {
    const durableResolved = {
      business: resolved.business,
      address: resolved.address,
    }
    const payload = durablePayload(
      'ycloud',
      message,
      inboundId,
      durableResolved,
      content,
    )
    const status = await enqueueResolvedInbound(
      'ycloud',
      eventId,
      durableResolved,
      payload,
    )
    if (status === 'duplicate') {
      console.log(`🔁 [YCloud] evento duplicado ignorado (${eventId})`)
    }
  } catch (error) {
    console.error('❌ Webhook YCloud persistencia:', loggedError(error))
    return res.sendStatus(503)
  }
  return res.sendStatus(200)
})

export = router
