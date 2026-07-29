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
  | { kind: 'flow_response'; responseJson: string }

interface InboundBatchMetadata {
  version: 1
  eventIds: string[]
}

export interface InboundWebhookPayload {
  version: 1
  provider: WhatsAppProvider
  businessId: string
  from: string
  inboundId: string
  channelAddress: WhatsAppChannelAddress
  content: InboundContent
  /**
   * Metadato reservado que PostgreSQL agrega al congelar un lote de textos.
   * Los webhooks externos nunca pueden construirlo directamente.
   */
  _inboxBatch?: InboundBatchMetadata
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
  bypassDebounce?: boolean
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

export interface InboundFlowResponse {
  businessId: string
  provider: WhatsAppProvider
  from: string
  inboundId: string
  channelAddress: WhatsAppChannelAddress
  response: Record<string, unknown>
}

interface InboundFlowProcessor {
  handleResponse(input: InboundFlowResponse): Promise<unknown>
}

export interface InboundWebhookDependencies {
  database: InboundDatabase
  bot: InboundBot
  flow?: InboundFlowProcessor
  http?: InboundHttpClient
  env?: NodeJS.ProcessEnv
  logger?: InboundLogger
}

export interface InboundWebhookExpectation {
  businessId: string
  provider: WhatsAppProvider
  eventId?: string
}

const MAX_TEXT_LENGTH = 16_384
const MAX_FLOW_RESPONSE_BYTES = 64 * 1024
const MAX_IDENTIFIER_LENGTH = 512
const MAX_INBOX_BATCH_EVENTS = 20
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

function boundedMessageText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  // PostgreSQL char_length usa puntos de código, mientras String.length usa
  // unidades UTF-16. Mantener la misma medida evita rechazar lotes con emojis
  // que la RPC consolidó dentro del límite de 16.384 caracteres.
  if (!text) return null
  let length = 0
  for (const _character of text) {
    length += 1
    if (length > MAX_TEXT_LENGTH) return null
  }
  return text
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

function flowResponseJson(value: unknown): string | null {
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > MAX_FLOW_RESPONSE_BYTES) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    const record = recordValue(parsed)
    const token = boundedText(record?.flow_token, MAX_IDENTIFIER_LENGTH)
    if (!record || !token) return null
    // Canonicalizar elimina espacios innecesarios y garantiza que el contenido
    // durable siga siendo JSON válido antes de llegar al procesador de Flows.
    return JSON.stringify(record)
  } catch {
    return null
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function inboundBatchMetadata(value: unknown): InboundBatchMetadata | null {
  if (value === undefined) return null
  const record = recordValue(value)
  if (!record || record.version !== 1 || !Array.isArray(record.eventIds)
    || record.eventIds.length < 1
    || record.eventIds.length > MAX_INBOX_BATCH_EVENTS) {
    throw new Error('Metadatos del lote durable inválidos')
  }
  const eventIds = record.eventIds.map(eventId => (
    typeof eventId === 'string' && UUID_PATTERN.test(eventId)
      ? eventId.toLowerCase()
      : null
  ))
  if (eventIds.some(eventId => !eventId)
    || new Set(eventIds).size !== eventIds.length) {
    throw new Error('Metadatos del lote durable inválidos')
  }
  return { version: 1, eventIds: eventIds as string[] }
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
    const text = boundedMessageText(content.text)
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
  } else if (content.kind === 'flow_response') {
    const responseJson = flowResponseJson(content.responseJson)
    if (!responseJson) throw new Error('Respuesta durable de Flow inválida')
    parsedContent = { kind: 'flow_response', responseJson }
  } else {
    throw new Error('Tipo durable de webhook no soportado')
  }

  const batch = inboundBatchMetadata(payload._inboxBatch)
  if (batch && parsedContent.kind !== 'text') {
    throw new Error('Un lote durable solo puede contener mensajes de texto')
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
    ...(batch ? { _inboxBatch: batch } : {}),
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
    if (payload._inboxBatch) {
      const expectedHeadId = expectation?.eventId?.toLowerCase()
      if (!expectedHeadId
        || payload._inboxBatch.eventIds[0] !== expectedHeadId) {
        throw new Error('El lote durable no coincide con el evento reservado')
      }
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
      ...(payload._inboxBatch ? { bypassDebounce: true } : {}),
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

    if (payload.content.kind === 'flow_response') {
      if (!dependencies.flow) {
        throw new Error('El procesador de respuestas WhatsApp Flow no está configurado')
      }
      const response = JSON.parse(payload.content.responseJson) as Record<string, unknown>
      await dependencies.flow.handleResponse({
        businessId: payload.businessId,
        provider: payload.provider,
        from: payload.from,
        inboundId: payload.inboundId,
        channelAddress: payload.channelAddress,
        response,
      })
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
  flow: require('./whatsapp-flow-runtime')
    .whatsappFlowResponseProcessor as InboundFlowProcessor,
})

export const processInboundWebhook = processor
