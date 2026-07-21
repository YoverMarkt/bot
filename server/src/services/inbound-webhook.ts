import axios from 'axios'
import { metaGraphUrl } from '../config/meta-graph'
import {
  normalizeChannelIdentifier,
  type WhatsAppChannelAddress,
  type WhatsAppProvider,
} from '../types/channels'

export interface InboundMediaReference {
  id?: string
  url?: string
  mimeType?: string
}

type InboundContent =
  | { kind: 'text'; text: string }
  | { kind: 'audio' | 'image'; media: InboundMediaReference }

export interface InboundWebhookPayload {
  version: 1
  provider: WhatsAppProvider
  businessId: string
  from: string
  inboundId: string
  channelAddress: WhatsAppChannelAddress
  content: InboundContent
}

interface InboundBusiness {
  id: string
  meta_token?: string | null
  ycloud_api_key?: string | null
}

interface InboundDatabase {
  getBusinessByChannel(
    address: WhatsAppChannelAddress,
  ): Promise<InboundBusiness | null>
}

interface MessageOptions {
  inboundId: string
  businessId: string
  channelAddress: WhatsAppChannelAddress
}

interface InboundBot {
  handleMessage(
    from: string,
    text: string,
    businessPhone: string,
    options: MessageOptions,
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

interface HttpResponse<T> {
  data: T
  headers: Record<string, unknown>
}

interface InboundHttpClient {
  get<T>(url: string, options: Record<string, unknown>): Promise<HttpResponse<T>>
}

interface InboundLogger {
  log(...values: unknown[]): void
}

export interface InboundWebhookDependencies {
  database: InboundDatabase
  bot: InboundBot
  http?: InboundHttpClient
  env?: NodeJS.ProcessEnv
  logger?: InboundLogger
}

export interface InboundWebhookExpectation {
  businessId: string
  provider: WhatsAppProvider
}

const MAX_TEXT_LENGTH = 16_384
const MAX_IDENTIFIER_LENGTH = 512
const META_IMAGE_LIMIT = 5 * 1024 * 1024
const META_AUDIO_LIMIT = 16 * 1024 * 1024
const YCLOUD_IMAGE_LIMIT = 10 * 1024 * 1024
const YCLOUD_AUDIO_LIMIT = 20 * 1024 * 1024

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedText(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maxLength ? text : null
}

function inboundMediaReference(value: unknown): InboundMediaReference | null {
  const record = recordValue(value)
  if (!record) return null
  const id = boundedText(record.id)
  const url = boundedText(record.url, 4096)
  const mimeType = boundedText(record.mimeType, 255)
  if (!id && !url) return null
  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
    ...(mimeType ? { mimeType } : {}),
  }
}

export function parseInboundWebhookPayload(value: unknown): InboundWebhookPayload {
  const payload = recordValue(value)
  if (!payload || payload.version !== 1) {
    throw new Error('Payload durable de webhook inválido')
  }
  const provider = payload.provider
  if (provider !== 'meta' && provider !== 'ycloud') {
    throw new Error('Proveedor durable de webhook inválido')
  }
  const businessId = boundedText(payload.businessId, 128)
  const from = boundedText(payload.from, 64)
  const inboundId = boundedText(payload.inboundId)
  const address = recordValue(payload.channelAddress)
  const identifierType = address?.identifierType
  const identifier = boundedText(address?.identifier, 255)
  if (!businessId || !from || !inboundId || address?.provider !== provider
    || (identifierType !== 'phone' && identifierType !== 'account_id')
    || !identifier
    || !normalizeChannelIdentifier(identifierType, identifier)) {
    throw new Error('Contexto durable de webhook inválido')
  }

  const content = recordValue(payload.content)
  if (!content) throw new Error('Contenido durable de webhook inválido')
  let parsedContent: InboundContent
  if (content.kind === 'text') {
    const text = boundedText(content.text, MAX_TEXT_LENGTH)
    if (!text) throw new Error('Texto durable de webhook inválido')
    parsedContent = { kind: 'text', text }
  } else if (content.kind === 'audio' || content.kind === 'image') {
    const media = inboundMediaReference(content.media)
    if (!media
      || (provider === 'meta' && !media.id)
      || (provider === 'ycloud' && !media.url)) {
      throw new Error('Media durable de webhook inválida')
    }
    parsedContent = { kind: content.kind, media }
  } else {
    throw new Error('Tipo durable de webhook no soportado')
  }

  return {
    version: 1,
    provider,
    businessId,
    from,
    inboundId,
    channelAddress: {
      provider,
      identifierType,
      identifier,
    },
    content: parsedContent,
  }
}

export function inboundConversationKey(payload: InboundWebhookPayload): string {
  return `${payload.provider}:${payload.businessId}:${payload.from}`
}

function validatedYCloudMediaUrl(value?: string): string {
  const url = new URL(value || '')
  if (url.protocol !== 'https:' || url.hostname !== 'api.ycloud.com'
    || url.port || url.username || url.password
    || !url.pathname.startsWith('/v2/whatsapp/media/download/')) {
    throw new Error('URL de media YCloud no permitida')
  }
  return url.toString()
}

async function downloadMetaMedia(
  http: InboundHttpClient,
  mediaId: string,
  token: string,
  phoneNumberId: string,
  maxBytes: number,
): Promise<{ data: Buffer; mimeType?: string }> {
  const media = await http.get<{
    url: string
    mime_type?: string
  }>(metaGraphUrl(mediaId), {
    headers: { Authorization: `Bearer ${token}` },
    params: { phone_number_id: phoneNumberId },
    timeout: 15000,
  })
  const mediaUrl = new URL(media.data.url)
  if (mediaUrl.protocol !== 'https:' || mediaUrl.username || mediaUrl.password) {
    throw new Error('Meta devolvió una URL de media no segura')
  }
  const response = await http.get<ArrayBuffer>(mediaUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    timeout: 20000,
    maxRedirects: 0,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
  })
  const responseType = response.headers['content-type']
  return {
    data: Buffer.from(response.data),
    mimeType: media.data.mime_type
      || (typeof responseType === 'string' ? responseType : undefined),
  }
}

async function downloadYCloudMedia(
  http: InboundHttpClient,
  reference: InboundMediaReference,
  apiKey: string,
  maxBytes: number,
): Promise<{ data: Buffer; mimeType?: string }> {
  const response = await http.get<ArrayBuffer>(validatedYCloudMediaUrl(reference.url), {
    headers: { 'X-API-Key': apiKey },
    responseType: 'arraybuffer',
    timeout: 20000,
    maxRedirects: 0,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
  })
  const responseType = response.headers['content-type']
  return {
    data: Buffer.from(response.data),
    mimeType: reference.mimeType
      || (typeof responseType === 'string' ? responseType : undefined),
  }
}

export function createInboundWebhookProcessor(
  dependencies: InboundWebhookDependencies,
) {
  const http = dependencies.http || axios
  const env = dependencies.env || process.env
  const logger = dependencies.logger || console

  return async function processInboundWebhook(
    value: unknown,
    expectation?: InboundWebhookExpectation,
  ): Promise<void> {
    const payload = parseInboundWebhookPayload(value)
    if (expectation && (
      payload.businessId !== expectation.businessId
      || payload.provider !== expectation.provider
    )) {
      throw new Error('El payload durable no coincide con el tenant de su evento')
    }
    const business = await dependencies.database.getBusinessByChannel(
      payload.channelAddress,
    )
    if (!business || business.id !== payload.businessId) {
      throw new Error('El canal del webhook ya no pertenece al negocio original')
    }
    const businessIdentifier = payload.channelAddress.identifier
    const options: MessageOptions = {
      inboundId: payload.inboundId,
      businessId: payload.businessId,
      channelAddress: payload.channelAddress,
    }

    if (payload.content.kind === 'text') {
      await dependencies.bot.handleMessage(
        payload.from,
        payload.content.text,
        businessIdentifier,
        options,
      )
      return
    }

    const isAudio = payload.content.kind === 'audio'
    let media: { data: Buffer; mimeType?: string }
    if (payload.provider === 'meta') {
      const token = business.meta_token?.trim()
      if (!token || !payload.content.media.id) {
        throw new Error('Falta el token Meta para procesar la media')
      }
      media = await downloadMetaMedia(
        http,
        payload.content.media.id,
        token,
        businessIdentifier,
        isAudio ? META_AUDIO_LIMIT : META_IMAGE_LIMIT,
      )
    } else {
      const apiKey = business.ycloud_api_key?.trim() || env.YCLOUD_API_KEY?.trim()
      if (!apiKey) throw new Error('Falta la API Key YCloud para procesar la media')
      media = await downloadYCloudMedia(
        http,
        payload.content.media,
        apiKey,
        isAudio ? YCLOUD_AUDIO_LIMIT : YCLOUD_IMAGE_LIMIT,
      )
    }

    if (isAudio) {
      if (media.mimeType && !media.mimeType.startsWith('audio/')) {
        throw new Error(`${payload.provider} devolvió un tipo de audio inválido`)
      }
      const filename = media.mimeType === 'audio/mpeg' ? 'audio.mp3' : 'audio.ogg'
      const transcript = await dependencies.bot.transcribeAudio(media.data, filename)
      if (!transcript) throw new Error('No se pudo transcribir el audio entrante')
      logger.log(`🎙️  [${payload.provider}] audio transcrito`)
      await dependencies.bot.handleMessage(
        payload.from,
        transcript,
        businessIdentifier,
        options,
      )
      return
    }

    const mimeType = media.mimeType || 'image/jpeg'
    if (!mimeType.startsWith('image/')) {
      throw new Error(`${payload.provider} devolvió un tipo de imagen inválido`)
    }
    await dependencies.bot.handleImage(
      payload.from,
      media.data,
      mimeType,
      businessIdentifier,
      options,
    )
  }
}

const processor = createInboundWebhookProcessor({
  database: require('../db') as InboundDatabase,
  bot: require('./bot-entry') as InboundBot,
})

export const processInboundWebhook = processor
