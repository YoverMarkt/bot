import axios from 'axios'
import { atiendeSinIA } from './chat-mode'
import { textoDelComprobante, textoDelComprobanteAmbiguo } from './payment-proof-inbox'
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

/**
 * La ubicación que comparte el cliente desde WhatsApp.
 *
 * ⚠️ Latitud y longitud viajan JUNTAS o no viajan: media coordenada apunta al
 * ecuador, y eso es peor que nada porque parece un dato bueno. Es la misma
 * regla que ya rige `orders.delivery_lat/lng`.
 *
 * `address` y `name` son lo que WhatsApp adjunta cuando el cliente elige un
 * sitio del mapa en vez de su punto azul. Opcionales: la mayoría manda solo
 * el punto.
 */
export interface InboundLocation {
  latitude: number
  longitude: number
  address?: string
  name?: string
}

type InboundContent =
  | { kind: 'text'; text: string }
  | { kind: 'audio' | 'image'; media: InboundMediaReference }
  | { kind: 'location'; location: InboundLocation }

interface InboundBatchMetadata {
  version: 1
  eventIds: string[]
}

export interface InboundWebhookPayload {
  version: 1
  provider: WhatsAppProvider
  /**
   * Nulo mientras el mensaje llegó al número del marketplace y el cliente
   * todavía no eligió local. Con número propio siempre viene resuelto.
   */
  businessId: string | null
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
  /** Menú o mini app: el modelo no corre, así que no se procesa media. */
  chat_mode?: string | null
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
  businessId: string | null
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

export interface InboundWebhookDependencies {
  database: InboundDatabase
  bot: InboundBot
  http?: InboundHttpClient
  env?: NodeJS.ProcessEnv
  logger?: InboundLogger
  /**
   * ¿Este contacto tiene un pedido esperando el comprobante?
   *
   * Se pregunta ANTES de descargar la foto, y ese orden es el punto entero:
   * una consulta a la base cuesta milisegundos, bajar una imagen de 5 MB
   * cuesta tráfico. Sin él, el modo mini app volvería a pagar por cada foto
   * que le manden — que es justo lo que el atajo de abajo evita.
   */
  /**
   * ¿El dueño bloqueó este número?
   *
   * Opcional como el resto: sin ella no hay corte, que es como se comportaba
   * antes de que el bloqueo existiera.
   */
  contactoBloqueado?: (businessId: string, contactPhone: string) => Promise<boolean>
  /**
   * Atiende un mensaje al número de la PLATAFORMA, donde todavía no hay local.
   *
   * Opcional como el resto de ganchos: sin ella el mensaje se descarta con un
   * aviso, que es exactamente lo que pasaba antes de que el marketplace
   * existiera. Así una instalación sin número de plataforma no cambia.
   */
  atenderMarketplace?: (input: {
    from: string
    text: string
    /** Presente solo si el cliente compartió su ubicación. */
    location?: InboundLocation
  }) => Promise<void>
  esperaComprobante?: (businessId: string, contactPhone: string) => Promise<boolean>
  /** Sube la foto y la engancha al pedido. Devuelve el número si lo logró. */
  adjuntarComprobante?: (
    businessId: string,
    contactPhone: string,
    imagen: Buffer,
  ) => Promise<{
    adjuntado: boolean
    orderNumber?: number | null
    ambiguos?: Array<{ orderId: string; orderNumber: number | null; businessName: string }>
  }>
}

export interface InboundWebhookExpectation {
  /** Nulo en los eventos del número de la plataforma. */
  businessId: string | null
  provider: WhatsAppProvider
  eventId?: string
}

const MAX_TEXT_LENGTH = 16_384
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

/**
 * Valida una ubicación entrante.
 *
 * Devuelve null si falta cualquiera de las dos coordenadas, si no son
 * números, o si caen fuera del rango real del planeta. Un `0,0` literal se
 * rechaza: es la Isla Nula frente a África, y en la práctica siempre es un
 * campo vacío que se coló como cero — el mismo fallo que `Number(null)`.
 */
function inboundLocation(value: unknown): InboundLocation | null {
  const record = recordValue(value)
  if (!record) return null
  // ⚠️ NO se usa `Number(...)` a secas: `Number(null)` es 0, no NaN, así que
  // una coordenada nula pasaría como el ecuador y el pedido apuntaría al
  // golfo de Guinea. Es el mismo fallo que ya cazó `tests/ubicacion.test.ts`
  // con `accuracy_m`. Solo un número o una cadena numérica cuentan.
  const coordenada = (valor: unknown): number | null => {
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null
    if (typeof valor === 'string' && valor.trim()) {
      const parsed = Number(valor)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }
  const latitude = coordenada(record.latitude)
  const longitude = coordenada(record.longitude)
  if (latitude === null || longitude === null) return null
  if (latitude < -90 || latitude > 90) return null
  if (longitude < -180 || longitude > 180) return null
  if (latitude === 0 && longitude === 0) return null
  const address = boundedText(record.address, 300)
  const name = boundedText(record.name, 120)
  return {
    latitude,
    longitude,
    ...(address ? { address } : {}),
    ...(name ? { name } : {}),
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
  // Ausente = mensaje al número de la plataforma, sin local elegido todavía.
  // Presente pero ilegible sigue siendo un error: eso es un payload corrupto,
  // no un mensaje de marketplace, y tratarlos igual escondería el corrupto.
  const businessId = payload.businessId == null
    ? null
    : boundedText(payload.businessId, 128) || null
  const businessIdCorrupto = payload.businessId != null && !businessId
  const from = boundedText(payload.from, 64)
  const inboundId = boundedText(payload.inboundId)
  const address = recordValue(payload.channelAddress)
  const identifierType = address?.identifierType
  const identifier = boundedText(address?.identifier, 255)
  if (businessIdCorrupto || !from || !inboundId || address?.provider !== provider
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
  } else if (content.kind === 'location') {
    const location = inboundLocation(content.location)
    if (!location) throw new Error('Ubicación durable de webhook inválida')
    parsedContent = { kind: 'location', location }
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
  // Sin negocio, la conversación es la del cliente con la PLATAFORMA, y el
  // teléfono basta para identificarla. Se escribe 'plataforma' y no se deja
  // el `null` que produciría la interpolación: el hash sale igual de único,
  // pero un stream key que dice «plataforma» se lee en un log, y un `null`
  // ahí parece un dato que se perdió.
  const tenant = payload.businessId ?? 'plataforma'
  return `${payload.provider}:${tenant}:${payload.from}`
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
    // ── El número de la PLATAFORMA: aún no hay local ───────────────────
    //
    // Va ANTES de resolver el negocio porque aquí no hay ninguno que
    // resolver: el cliente escribió a Umbani y todavía no ha elegido. El
    // menú del marketplace lo lleva hasta la puerta del local correcto.
    //
    // ⚠️ No se descarga NINGÚN archivo. Una foto o un audio antes de elegir
    // local no tienen a qué referirse —no hay pedido, no hay catálogo, no hay
    // comprobante que adjuntar—, así que bajarlos sería pagar tráfico por algo
    // que nadie va a mirar. Es el mismo criterio del atajo del modo mini app.
    //
    // ⚠️ La UBICACIÓN es la excepción, y no cuesta nada: viaja dentro del
    // propio mensaje —dos números—, no hay archivo que bajar. Es lo que deja
    // cerrar el pedido dentro del chat sin pedirle al cliente que escriba su
    // dirección a mano.
    if (payload.businessId === null) {
      if (!dependencies.atenderMarketplace) {
        logger.log('⚠️  [marketplace] llegó un mensaje pero no hay quien lo atienda')
        return
      }
      const texto = payload.content.kind === 'text'
        ? payload.content.text
        : payload.content.kind === 'audio'
          ? '[nota de voz]'
          : payload.content.kind === 'location' ? '[ubicación]' : '[foto]'
      await dependencies.atenderMarketplace({
        from: payload.from,
        text: texto,
        ...(payload.content.kind === 'location'
          ? { location: payload.content.location }
          : {}),
      })
      return
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

    /**
     * Baja la media del proveedor que toque.
     *
     * Se extrajo para que el atajo del modo mini app pueda usarla cuando SÍ
     * hace falta —la foto de quien tiene un pedido esperando comprobante— sin
     * duplicar los límites de tamaño ni la elección de credencial, que son
     * distintos por proveedor y por tipo.
     */
    const descargarMedia = async (): Promise<{ data: Buffer; mimeType?: string }> => {
      // Ni un texto ni una ubicación traen archivo que bajar. El compilador
      // obliga a nombrar los dos casos, que es justo lo que se quiere: al
      // añadir un tipo de mensaje nuevo, este punto falla y hay que decidir.
      if (payload.content.kind === 'text' || payload.content.kind === 'location') {
        throw new Error('Este tipo de mensaje no tiene media')
      }
      const audio = payload.content.kind === 'audio'
      if (payload.provider === 'meta') {
        const token = business.meta_token?.trim()
        if (!token || !payload.content.media.id) {
          throw new Error('Falta el token Meta para procesar la media')
        }
        return downloadMetaMedia(
          http,
          payload.content.media.id,
          token,
          businessIdentifier,
          audio ? META_AUDIO_LIMIT : META_IMAGE_LIMIT,
        )
      }
      const apiKey = business.ycloud_api_key?.trim() || env.YCLOUD_API_KEY?.trim()
      if (!apiKey) throw new Error('Falta la API Key YCloud para procesar la media')
      return downloadYCloudMedia(
        http,
        payload.content.media,
        apiKey,
        audio ? YCLOUD_AUDIO_LIMIT : YCLOUD_IMAGE_LIMIT,
      )
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

    // ⚠️ BLOQUEADO: ni se descarga, ni se transcribe, ni se mira.
    //
    // Va ANTES del atajo del modo mini app porque vale para los dos modos, y
    // antes de cualquier descarga porque es justo aquí donde se gasta: bajar
    // la media cuesta tráfico, Whisper y visión cuestan dinero, y adjuntar un
    // comprobante cuesta almacenamiento. Un bloqueado no puede seguir gastando
    // en el negocio que lo bloqueó — es media de las dos razones para bloquear
    // a alguien.
    //
    // El mensaje SÍ se entrega a `handleMessage` con su marcador de texto: ahí
    // se guarda para que el dueño lo lea, y el corte de `bot-conversation`
    // impide la respuesta. Bloquear no es dejar de ver.
    const bloqueado = dependencies.contactoBloqueado
      ? await dependencies.contactoBloqueado(business.id, payload.from).catch(() => false)
      : false
    if (bloqueado) {
      logger.log(`⛔ [${payload.provider}] media de un contacto bloqueado: no se procesa`)
      await dependencies.bot.handleMessage(
        payload.from,
        payload.content.kind === 'audio' ? '[nota de voz]' : '[foto]',
        businessIdentifier,
        options,
      )
      return
    }

    // MODO MINI APP: ni se descarga la media, ni se transcribe, ni se mira.
    //
    // Este negocio atiende por su app, así que la respuesta va a ser la misma
    // mandes lo que mandes: el enlace o el recordatorio. Bajar la foto y
    // pasarla por visión —o el audio por Whisper— para luego no usar el
    // resultado es pagar dos veces por nada: el tráfico y la llamada al
    // modelo. Y son las dos llamadas más caras del sistema.
    //
    // El corte de `bot-conversation` llega DESPUÉS de esto, así que no basta
    // con el que ya hay: aquí el gasto ya se habría hecho.
    if (atiendeSinIA(business.chat_mode)) {
      // ⚠️ Con UNA excepción: la foto de quien tiene un pedido esperando el
      // comprobante. Ese es el caso más común del modo mini app —se pide por
      // la app, se transfiere desde el banco y se manda la captura por el
      // chat— y era el que se perdía: la foto no se bajaba, no se adjuntaba a
      // nada, y el cliente recibía «usa el enlace» después de pagar.
      //
      // Se pregunta a la BASE antes de bajar nada. Ese orden es el punto: una
      // consulta cuesta milisegundos, bajar 5 MB cuesta tráfico. Quien no
      // tenga un pedido esperando pago sigue por el atajo de siempre, sin
      // descargar ni pagar visión.
      const esFoto = payload.content.kind === 'image'
      const toca = esFoto && dependencies.esperaComprobante && dependencies.adjuntarComprobante
        ? await dependencies.esperaComprobante(business.id, payload.from).catch(() => false)
        : false

      if (!toca) {
        logger.log(`🛍️  [${payload.provider}] media en modo mini app: no se procesa`)
        await dependencies.bot.handleMessage(
          payload.from,
          payload.content.kind === 'audio'
            ? '[nota de voz]'
            : payload.content.kind === 'location' ? '[ubicación]' : '[foto]',
          businessIdentifier,
          options,
        )
        return
      }

      logger.log(`🧾 [${payload.provider}] foto con pedido esperando pago: se descarga`)
      const foto = await descargarMedia()
      const comprobante = await dependencies.adjuntarComprobante!(
        business.id, payload.from, foto.data,
      )
      // Pagos pendientes en más de un local: se PREGUNTA cuál, y la foto no
      // se adjunta a ninguno mientras tanto. Adivinar sería dar por cobrado a
      // un local lo que pagó otro.
      if (comprobante.ambiguos?.length) {
        logger.log(
          `🧾 [${payload.provider}] comprobante ambiguo: ${comprobante.ambiguos.length} pedidos esperando pago`,
        )
      }

      await dependencies.bot.handleMessage(
        payload.from,
        // Tres casos, y el del medio es el nuevo: se adjuntó, no se supo a
        // cuál de varios locales, o no había pedido esperando pago. Si no se
        // pudo adjuntar se sigue como siempre y el cliente recibe su respuesta
        // de siempre en vez de quedarse sin nada.
        comprobante.adjuntado
          ? textoDelComprobante(comprobante.orderNumber)
          : comprobante.ambiguos?.length
            ? textoDelComprobanteAmbiguo(comprobante.ambiguos)
            : '[foto]',
        businessIdentifier,
        options,
      )
      return
    }

    // Una ubicación no tiene archivo: se entrega como texto y no pasa por la
    // descarga. Va antes que el audio y la imagen porque `descargarMedia`
    // lanzaría con ella, y un cliente que comparte su ubicación con un
    // negocio de número propio merece que su mensaje llegue igual.
    if (payload.content.kind === 'location') {
      await dependencies.bot.handleMessage(
        payload.from,
        '[ubicación]',
        businessIdentifier,
        options,
      )
      return
    }

    const isAudio = payload.content.kind === 'audio'
    const media = await descargarMedia()

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
  /**
   * La pregunta barata que decide si vale la pena bajar la foto.
   *
   * Carga diferida como el resto de lo que habla con la base: `require` dentro
   * de la función evita un ciclo de importaciones al arrancar.
   */
  contactoBloqueado: async (businessId, contactPhone) => {
    const db = require('../db') as typeof import('../db')
    return db.isContactBlocked(businessId, contactPhone)
  },
  esperaComprobante: async (businessId, contactPhone) => {
    const db = require('../db') as typeof import('../db')
    const inbox = require('./payment-proof-inbox') as typeof import('./payment-proof-inbox')
    const pedido = await db.getLastOrderForContact(businessId, contactPhone).catch(() => null)
    return inbox.esperaComprobante(pedido)
  },
  adjuntarComprobante: (businessId, contactPhone, imagen) => {
    const bot = require('./bot-entry') as typeof import('./bot-entry')
    return bot.adjuntarComprobante(businessId, contactPhone, imagen)
  },
  /**
   * El menú del marketplace: categorías → locales → el enlace de su tienda.
   *
   * Carga diferida como el resto, para no cerrar un ciclo de importaciones al
   * arrancar (`marketplace-entry` → `storefront-link` → `db` → …).
   */
  atenderMarketplace: async ({ from, text, location }) => {
    const db = require('../db') as typeof import('../db')
    const entry = require('./marketplace-entry') as typeof import('./marketplace-entry')
    const link = require('./storefront-link') as typeof import('./storefront-link')
    const platform = require('./platform-channel') as typeof import('./platform-channel')
    const menu = require('./bot-menu-flow') as typeof import('./bot-menu-flow')
    const acciones = require('./bot-actions') as typeof import('./bot-actions')
    const settings = require('./settings') as typeof import('./settings')
    await entry.handleMarketplaceMessage({ from, text, location }, {
      database: db,
      issueLink: link.issueStorefrontLink,
      send: (reply, options) => platform.enviarPorLaPlataforma(from, reply, options),
      // El umbral vive en `server_settings` para moverlo sin desplegar: el
      // número bueno se sabrá viendo pedidos reales, no antes.
      maxProductosEnChat: async () => {
        const valor = Number(await settings.get('marketplace_menu_max_productos'))
        return Number.isFinite(valor) && valor > 0 ? valor : 20
      },
      avanzarMenu: menu.advanceMenuFlowConEstado,
      /**
       * El pedido COMPLETO, por la RPC atómica de siempre.
       *
       * ⚠️ Se resuelven los nombres del menú contra el catálogo del MISMO
       * local antes de crear nada: `create_storefront_order` quiere
       * `product_id`, y mandarle un nombre suelto sería confiar en un texto
       * para decidir qué se cobra. Lo que no se resuelva se descarta, y si no
       * queda nada el pedido no se crea.
       */
      crearPedidoCompleto: async (entrada) => {
        const catalogo = entrada.products as Array<{ id?: string; name?: string }>
        const normalizar = (valor: string) => String(valor || '')
          .toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').trim()
        const resueltos = entrada.items.flatMap((item) => {
          // El id que trae el carrito manda; el nombre es el respaldo para
          // las líneas que vengan de un flujo antiguo sin id.
          const encontrado = item.productId
            ? { id: item.productId }
            : catalogo.find(
                producto => normalizar(String(producto.name)) === normalizar(item.name),
              )
          if (!encontrado?.id) return []
          return [{
            product_id: encontrado.id,
            quantity: item.qty,
            // Las opciones del motor van con su id REAL: la RPC comprueba que
            // cada una pertenece a este negocio y a este producto (o a su
            // categoría) antes de cobrarla. Un nombre suelto no se puede
            // validar, y es lo que se está dejando atrás.
            ...(item.options?.length
              ? { options: item.options.map(o => ({ option_id: o.optionId })) }
              : {}),
          }]
        })
        if (!resueltos.length) return null

        const { data, error } = await db.createStorefrontOrder({
          businessId: entrada.businessId,
          customerId: entrada.customerId,
          contactPhone: entrada.phone,
          contactName: entrada.contactName || null,
          addressId: entrada.addressId,
          fulfillment: 'delivery',
          paymentMethod: entrada.paymentMethod,
          items: resueltos,
          deliveryNotes: entrada.notes || null,
        })
        if (error || !data) return null
        const pedido = data as { id?: string; total?: unknown }
        if (!pedido.id) return null
        // El correlativo lo pone un disparador, así que la RPC no lo
        // devuelve: se relee. Si falla, el pedido YA existe y se confirma sin
        // número — quedarse sin confirmación por un dato de presentación
        // sería mucho peor que confirmar sin él.
        const seguimiento = await db.getStorefrontOrder({
          businessId: entrada.businessId,
          contactPhone: entrada.phone,
          orderId: pedido.id,
        }).catch(() => ({ data: null }))
        const numero = (seguimiento?.data as { order_number?: number } | null)?.order_number
        return { orderNumber: numero ?? null, total: pedido.total ?? 0 }
      },
      // El MISMO camino del dinero que usa el canal propio: `money.ts` y las
      // RPC atómicas. El marketplace no abre una vía de cobro paralela.
      crearPedido: entrada => acciones.processOrderPayload({
        business: entrada.business as unknown as Parameters<typeof acciones.processOrderPayload>[0]['business'],
        phone: entrada.phone,
        session: null,
        payload: entrada.payload,
        items: entrada.items,
        products: entrada.products as Parameters<typeof acciones.processOrderPayload>[0]['products'],
        preFiltered: false,
        send: entrada.send,
      }),
      logger: console,
    })
  },
})

export const processInboundWebhook = processor
