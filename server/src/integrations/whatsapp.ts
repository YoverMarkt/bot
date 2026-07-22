import axios from 'axios'
import { metaGraphUrl } from '../config/meta-graph'
import type { WhatsAppProvider } from '../types/channels'

export interface WhatsAppBusiness {
  whatsapp_provider?: string | null
  meta_phone_id?: string | null
  meta_token?: string | null
  ycloud_api_key?: string | null
  ycloud_number?: string | null
  whatsapp_number?: string | null
}

interface YCloudClient {
  showTyping(apiKey: string, inboundId: string): Promise<void>
  sendText(apiKey: string, from: string, to: string, text: string): Promise<void>
  sendInteractive(
    apiKey: string,
    from: string,
    to: string,
    body: string,
    options: { id: string; title: string; description?: string }[],
    listButtonText?: string,
  ): Promise<boolean>
  sendImage(
    apiKey: string,
    from: string,
    to: string,
    imageUrl: string,
    caption?: string,
  ): Promise<void>
  sendVideo(
    apiKey: string,
    from: string,
    to: string,
    videoUrl: string,
    caption?: string,
  ): Promise<void>
}

const ycloud = require('./ycloud') as YCloudClient
const OUTBOUND_TIMEOUT_MS = 15_000

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

function errorDetail(error: unknown): unknown {
  if (axios.isAxiosError(error)) return error.message
  return error instanceof Error ? error.message : error
}

async function sendTyping(
  business: WhatsAppBusiness,
  inboundId?: string | null,
): Promise<void> {
  try {
    const provider = providerFor(business)
    if (provider === 'ycloud' && inboundId) {
      await ycloud.showTyping(ycloudKeyFor(business), inboundId)
    }
  } catch {
    // El indicador es best-effort y nunca debe interrumpir la respuesta.
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
      )
    }
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
      )
    }
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
): Promise<boolean> {
  if (providerFor(business) !== 'ycloud') return false
  try {
    return await ycloud.sendInteractive(
      ycloudKeyFor(business),
      ycloudNumberFor(business),
      to,
      body,
      options,
      listButtonText,
    )
  } catch (error) {
    // Nunca dejar al cliente sin respuesta: el llamador cae a texto
    console.error('❌ [ycloud] sendInteractive:', errorDetail(error))
    return false
  }
}

export { sendTyping, sendText, sendImage, sendVideo, sendInteractive }
