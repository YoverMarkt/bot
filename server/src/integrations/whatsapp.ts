import axios from 'axios'
import { metaGraphUrl } from '../config/meta-graph'
import type { WhatsAppProvider } from '../types/channels'
import {
  buildWhatsAppFlowInteractive,
  buildWhatsAppFlowTemplate,
  type WhatsAppFlowLaunch,
  type WhatsAppFlowTemplateLaunch,
} from './whatsapp-flow'
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
  sendSessionFlow(
    apiKey: string,
    from: string,
    to: string,
    launch: WhatsAppFlowLaunch,
    direct?: boolean,
  ): Promise<void>
  sendFlowTemplate(
    apiKey: string,
    from: string,
    to: string,
    launch: WhatsAppFlowTemplateLaunch,
    direct?: boolean,
  ): Promise<void>
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

const ycloud = require('./ycloud') as YCloudClient
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
    return false
  }
}

/**
 * Sends a published Flow as a free-form interactive message. The caller is
 * responsible for ensuring that the customer-service window is still open.
 */
async function sendSessionFlow(
  business: WhatsAppBusiness,
  to: string,
  launch: WhatsAppFlowLaunch,
  deliveryMode: DeliveryMode = 'direct',
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
          type: 'interactive',
          interactive: buildWhatsAppFlowInteractive(launch),
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
      await ycloud.sendSessionFlow(
        ycloudKeyFor(business),
        ycloudNumberFor(business),
        to,
        launch,
        deliveryMode === 'direct',
      )
    }
    // El esquema de consumo agrupa CTA, listas y Flows en "interactive".
    await recordAcceptedMessage(business, provider, to, 'interactive')
  } catch (error) {
    console.error(`❌ [${provider}] sendSessionFlow:`, errorDetail(error))
    throw error
  }
}

/**
 * Sends an approved template whose button launches a Flow. This is the safe
 * transport outside the customer-service window.
 */
async function sendFlowTemplate(
  business: WhatsAppBusiness,
  to: string,
  launch: WhatsAppFlowTemplateLaunch,
  deliveryMode: DeliveryMode = 'direct',
): Promise<void> {
  const provider = providerFor(business)
  try {
    if (provider === 'meta') {
      await axios.post(
        metaGraphUrl(String(business.meta_phone_id || ''), 'messages'),
        {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: buildWhatsAppFlowTemplate(launch),
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
      await ycloud.sendFlowTemplate(
        ycloudKeyFor(business),
        ycloudNumberFor(business),
        to,
        launch,
        deliveryMode === 'direct',
      )
    }
    await recordAcceptedMessage(business, provider, to, 'interactive')
  } catch (error) {
    console.error(`❌ [${provider}] sendFlowTemplate:`, errorDetail(error))
    throw error
  }
}

export {
  sendTyping,
  sendText,
  sendImage,
  sendVideo,
  sendInteractive,
  sendSessionFlow,
  sendFlowTemplate,
}
export type { WhatsAppFlowLaunch, WhatsAppFlowTemplateLaunch }
