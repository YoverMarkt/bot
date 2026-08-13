import axios from 'axios'
import { metaGraphUrl } from '../config/meta-graph'
import { recordError } from '../services/error-log'
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
  throw new Error(`Proveedor WhatsApp no soportado: ${provider}`)
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
  try {
    provider = providerFor(business)
  } catch {
    // La lectura es best-effort y nunca debe interrumpir la respuesta.
    return
  }
  if (provider !== 'ycloud' || !inboundId) return

  const apiKey = ycloudKeyFor(business)
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
  const provider = providerFor(business)
  try {
    if (provider === 'meta') {
      await axios.post(
        metaGraphUrl(String(business.meta_phone_id || ''), 'messages'),
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${business.meta_token}`,
            'Content-Type': 'application/json',
          },
          timeout: OUTBOUND_TIMEOUT_MS,
        },
      )
    } else {
      await ycloud.sendText(
        ycloudKeyFor(business),
        ycloudNumberFor(business),
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
  const provider = providerFor(business)
  try {
    if (provider === 'meta') {
      await axios.post(
        metaGraphUrl(String(business.meta_phone_id || ''), 'messages'),
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'image',
          image: { link: imageUrl, caption },
        },
        {
          headers: {
            Authorization: `Bearer ${business.meta_token}`,
            'Content-Type': 'application/json',
          },
          timeout: OUTBOUND_TIMEOUT_MS,
        },
      )
    } else {
      await ycloud.sendImage(
        ycloudKeyFor(business),
        ycloudNumberFor(business),
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
  const provider = providerFor(business)
  try {
    if (provider === 'meta') {
      await axios.post(
        metaGraphUrl(String(business.meta_phone_id || ''), 'messages'),
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'video',
          video: { link: videoUrl, caption },
        },
        {
          headers: {
            Authorization: `Bearer ${business.meta_token}`,
            'Content-Type': 'application/json',
          },
          timeout: OUTBOUND_TIMEOUT_MS,
        },
      )
    } else {
      await ycloud.sendVideo(
        ycloudKeyFor(business),
        ycloudNumberFor(business),
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
  if (providerFor(business) !== 'ycloud') return false
  try {
    const sent = await ycloud.sendInteractive(
      ycloudKeyFor(business),
      ycloudNumberFor(business),
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
  if (providerFor(business) !== 'ycloud') return false
  try {
    const sent = await ycloud.sendCtaUrl(
      ycloudKeyFor(business),
      ycloudNumberFor(business),
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
