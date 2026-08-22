import axios from 'axios'
import { metaGraphUrl } from '../config/meta-graph'
import { recordError } from '../services/error-log'
import { getPlatformChannel } from '../services/platform-channel'
import type { WhatsAppProvider } from '../types/channels'
import {
  recordOutboundUsage,
  type OutboundMessageType,
} from '../db/repositories/usage'

export interface WhatsAppBusiness {
  id?: string | null
  whatsapp_provider?: string | null
  meta_phone_id?: string | null
  meta_token?: string | null
  ycloud_api_key?: string | null
  ycloud_number?: string | null
  whatsapp_number?: string | null
}

interface YCloudClient {
  markAsRead(apiKey: string, inboundId: string): Promise<void>
  showTyping(apiKey: string, inboundId: string): Promise<void>
  sendText(apiKey: string, from: string, to: string, text: string): Promise<void>
  sendInteractive(
    apiKey: string,
    from: string,
    to: string,
    body: string,
    options: { id: string; title: string; description?: string }[],
    listButtonText?: string,
    direct?: boolean,
  ): Promise<boolean>
  sendCtaUrl(
    apiKey: string,
    from: string,
    to: string,
    message: { body: string; url: string; label: string; footer?: string | null },
    direct?: boolean,
  ): Promise<boolean>
  sendImage(
    apiKey: string,
    from: string,
    to: string,
    imageUrl: string,
    caption?: string,
    direct?: boolean,
  ): Promise<void>
  sendVideo(
    apiKey: string,
    from: string,
    to: string,
    videoUrl: string,
    caption?: string,
    direct?: boolean,
  ): Promise<void>
}

const ycloud: YCloudClient = require('./ycloud') as typeof import('./ycloud')
const OUTBOUND_TIMEOUT_MS = 15_000
type DeliveryMode = 'queued' | 'direct'

function providerFor(business: WhatsAppBusiness): WhatsAppProvider {
  const provider = String(business.whatsapp_provider || '').trim() || 'ycloud'
  if (provider === 'meta' || provider === 'ycloud') return provider
  if (provider === 'telegram') {
    throw new Error('El negocio opera solo por Telegram: no hay canal WhatsApp para este envío')
  }
  // El negocio del marketplace envía por el número de la PLATAFORMA, y a
  // esta función debe llegar ya resuelto por `conCanalDePlataforma`. Si
  // llega sin resolver es un error de programación —alguien añadió un
  // camino de envío nuevo y se saltó la resolución—, así que se dice eso y
  // no «proveedor no soportado», que haría buscar en el sitio equivocado.
  if (provider === 'marketplace') {
    throw new Error('Envío de marketplace sin resolver: falta pasar por conCanalDePlataforma')
  }
  throw new Error(`Proveedor WhatsApp no soportado: ${provider}`)
}

/**
 * Cambia un negocio de marketplace por su canal real de salida: el número de
 * la plataforma.
 *
 * Devuelve una COPIA y no toca el original: el objeto del negocio se usa
 * después para registrar consumo y errores, y `business.id` tiene que seguir
 * siendo el del local —quien envía es la plataforma, pero quien gasta es él—.
 *
 * Los negocios con número propio salen por aquí sin tocarse.
 */
async function conCanalDePlataforma(
  business: WhatsAppBusiness,
): Promise<WhatsAppBusiness> {
  if (String(business.whatsapp_provider || '').trim() !== 'marketplace') {
    return business
  }
  const platform = await getPlatformChannel()
  if (!platform) {
    throw new Error('El número del marketplace no está configurado: ponlo en Ajustes del servidor')
  }
  return {
    ...business,
    whatsapp_provider: 'ycloud',
    ycloud_api_key: platform.apiKey,
    ycloud_number: platform.number,
  }
}
const ycloudKeyFor = (business: WhatsAppBusiness) => (
  business.ycloud_api_key || process.env.YCLOUD_API_KEY
) as string
const ycloudNumberFor = (business: WhatsAppBusiness) => (
  business.ycloud_number || business.whatsapp_number
) as string

function errorDetail(error: unknown): string {
  if (axios.isAxiosError(error)) return error.message
  return error instanceof Error ? error.message : 'Error no identificado'
}

// Deja constancia de un envío que no salió (saldo agotado, ventana de 24 h
// cerrada, número bloqueado…). Estos fallos son mudos para el negocio: el
// cliente simplemente no recibe la respuesta.
function recordSendFailure(
  business: WhatsAppBusiness,
  provider: string,
  operation: string,
  error: unknown,
): void {
  void recordError({
    businessId: business.id || null,
    category: 'envio',
    code: axios.isAxiosError(error) ? String(error.response?.status || 'sin_respuesta') : 'fallo',
    message: errorDetail(error),
    context: { provider, operation },
  })
}

async function recordAcceptedMessage(
  business: WhatsAppBusiness,
  provider: WhatsAppProvider,
  to: string,
  messageType: OutboundMessageType,
): Promise<void> {
  await recordOutboundUsage(business.id, provider, to, messageType)
}

async function sendTyping(
  business: WhatsAppBusiness,
  inboundId?: string | null,
): Promise<void> {
  let provider: WhatsAppProvider
  let canal: WhatsAppBusiness
  try {
    // ⚠️ Dentro del try: resolver el canal consulta `server_settings` y puede
    // lanzar si el número del marketplace no está configurado. Fuera, un
    // negocio sin plataforma tumbaría la respuesta entera por no poder poner
    // el «escribiendo…», que es justo lo que este best-effort evita.
    canal = await conCanalDePlataforma(business)
    provider = providerFor(canal)
  } catch {
    // La lectura es best-effort y nunca debe interrumpir la respuesta.
    return
  }
  if (provider !== 'ycloud' || !inboundId) return

  const apiKey = ycloudKeyFor(canal)
  // Ambas operaciones marcan como leído. Se ejecutan en paralelo para que un
  // timeout del indicador no retrase otros 8 segundos la respuesta del bot.
  const [readResult, typingResult] = await Promise.allSettled([
    ycloud.markAsRead(apiKey, inboundId),
    ycloud.showTyping(apiKey, inboundId),
  ])
  if (readResult.status === 'rejected') {
    // Solo se registra el mensaje resumido de Axios; nunca response.data,
    // headers, credenciales ni el identificador del cliente.
    console.warn('⚠️  [ycloud] markAsRead:', errorDetail(readResult.reason))
  }
  if (typingResult.status === 'rejected') {
    console.warn(
      '⚠️  [ycloud] typingIndicator:',
      errorDetail(typingResult.reason),
    )
  }
}

async function sendText(
  business: WhatsAppBusiness,
  to: string,
  text: string,
): Promise<void> {
  const canal = await conCanalDePlataforma(business)
  const provider = providerFor(canal)
  try {
    if (provider === 'meta') {
      await axios.post(
        metaGraphUrl(String(canal.meta_phone_id || ''), 'messages'),
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${canal.meta_token}`,
            'Content-Type': 'application/json',
          },
          timeout: OUTBOUND_TIMEOUT_MS,
        },
      )
    } else {
      await ycloud.sendText(
        ycloudKeyFor(canal),
        ycloudNumberFor(canal),
        to,
        text,
      )
    }
    await recordAcceptedMessage(business, provider, to, 'text')
  } catch (error) {
    console.error(`❌ [${provider}] sendText:`, errorDetail(error))
    recordSendFailure(business, provider, 'sendText', error)
    throw error
  }
}

async function sendImage(
  business: WhatsAppBusiness,
  to: string,
  imageUrl: string,
  caption = '',
  deliveryMode: DeliveryMode = 'queued',
): Promise<void> {
  const canal = await conCanalDePlataforma(business)
  const provider = providerFor(canal)
  try {
    if (provider === 'meta') {
      await axios.post(
        metaGraphUrl(String(canal.meta_phone_id || ''), 'messages'),
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'image',
          image: { link: imageUrl, caption },
        },
        {
          headers: {
            Authorization: `Bearer ${canal.meta_token}`,
            'Content-Type': 'application/json',
          },
          timeout: OUTBOUND_TIMEOUT_MS,
        },
      )
    } else {
      await ycloud.sendImage(
        ycloudKeyFor(canal),
        ycloudNumberFor(canal),
        to,
        imageUrl,
        caption,
        deliveryMode === 'direct',
      )
    }
    await recordAcceptedMessage(business, provider, to, 'image')
  } catch (error) {
    console.error(`❌ [${provider}] sendImage:`, errorDetail(error))
    recordSendFailure(business, provider, 'sendImage', error)
    throw error
  }
}

async function sendVideo(
  business: WhatsAppBusiness,
  to: string,
  videoUrl: string,
  caption = '',
  deliveryMode: DeliveryMode = 'queued',
): Promise<void> {
  const canal = await conCanalDePlataforma(business)
  const provider = providerFor(canal)
  try {
    if (provider === 'meta') {
      await axios.post(
        metaGraphUrl(String(canal.meta_phone_id || ''), 'messages'),
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'video',
          video: { link: videoUrl, caption },
        },
        {
          headers: {
            Authorization: `Bearer ${canal.meta_token}`,
            'Content-Type': 'application/json',
          },
          timeout: OUTBOUND_TIMEOUT_MS,
        },
      )
    } else {
      await ycloud.sendVideo(
        ycloudKeyFor(canal),
        ycloudNumberFor(canal),
        to,
        videoUrl,
        caption,
        deliveryMode === 'direct',
      )
    }
    await recordAcceptedMessage(business, provider, to, 'video')
  } catch (error) {
    console.error(`❌ [${provider}] sendVideo:`, errorDetail(error))
    recordSendFailure(business, provider, 'sendVideo', error)
    throw error
  }
}

// Menú con botones/listas nativas. Solo YCloud lo soporta hoy; con cualquier
// otro proveedor devuelve false y quien llama envía el menú como texto
// numerado, que el motor entiende igual.
async function sendInteractive(
  business: WhatsAppBusiness,
  to: string,
  body: string,
  options: { id: string; title: string; description?: string }[],
  listButtonText?: string,
  deliveryMode: DeliveryMode = 'queued',
): Promise<boolean> {
  const canal = await conCanalDePlataforma(business)
  if (providerFor(canal) !== 'ycloud') return false
  try {
    const sent = await ycloud.sendInteractive(
      ycloudKeyFor(canal),
      ycloudNumberFor(canal),
      to,
      body,
      options,
      listButtonText,
      deliveryMode === 'direct',
    )
    if (sent) {
      await recordAcceptedMessage(business, 'ycloud', to, 'interactive')
    }
    return sent
  } catch (error) {
    // Nunca dejar al cliente sin respuesta: el llamador cae a texto
    console.error('❌ [ycloud] sendInteractive:', errorDetail(error))
    recordSendFailure(business, 'ycloud', 'sendInteractive', error)
    return false
  }
}

// El enlace de la tienda como BOTÓN nativo. Solo YCloud lo soporta hoy; con
// cualquier otro proveedor devuelve false y quien llama manda el enlace como
// texto, que es exactamente lo que se hacía antes de esto.
//
// ⚠️ Nunca lanza, y esa es su función. El enlace es lo único que le permite
// pedir a un cliente en modo mini app: si el botón falla —porque la cuenta no
// admite interactivos, porque YCloud cambia algo, porque hay un 400 raro— lo
// que NO puede pasar es que el cliente se quede sin enlace. Un `false` manda
// a quien llama al camino de siempre.
async function sendLinkButton(
  business: WhatsAppBusiness,
  to: string,
  message: { body: string; url: string; label: string; footer?: string | null },
  deliveryMode: DeliveryMode = 'queued',
): Promise<boolean> {
  const canal = await conCanalDePlataforma(business)
  if (providerFor(canal) !== 'ycloud') return false
  try {
    const sent = await ycloud.sendCtaUrl(
      ycloudKeyFor(canal),
      ycloudNumberFor(canal),
      to,
      message,
      deliveryMode === 'direct',
    )
    if (sent) await recordAcceptedMessage(business, 'ycloud', to, 'interactive')
    return sent
  } catch (error) {
    console.error('❌ [ycloud] sendLinkButton:', errorDetail(error))
    recordSendFailure(business, 'ycloud', 'sendLinkButton', error)
    return false
  }
}

export { sendTyping, sendText, sendImage, sendVideo, sendInteractive, sendLinkButton }
