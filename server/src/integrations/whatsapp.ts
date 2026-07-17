import axios from 'axios'

export interface WhatsAppBusiness {
  whatsapp_provider?: string | null
  meta_phone_id?: string | null
  meta_token?: string | null
  kapso_api_key?: string | null
  kapso_number_id?: string | null
  ycloud_api_key?: string | null
  ycloud_number?: string | null
  whatsapp_number?: string | null
}

interface YCloudClient {
  showTyping(apiKey: string, inboundId: string): Promise<void>
  sendText(apiKey: string, from: string, to: string, text: string): Promise<void>
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

const providerFor = (business: WhatsAppBusiness) => business.whatsapp_provider || 'ycloud'
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
  const provider = providerFor(business)
  try {
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
        `https://graph.facebook.com/v19.0/${business.meta_phone_id}/messages`,
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
        },
      )
    } else if (provider === 'kapso') {
      const apiKey = business.kapso_api_key || process.env.KAPSO_API_KEY
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        {
          number_id: business.kapso_number_id,
          to,
          type: 'text',
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
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
        `https://graph.facebook.com/v19.0/${business.meta_phone_id}/messages`,
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
        },
      )
    } else if (provider === 'kapso') {
      const apiKey = business.kapso_api_key || process.env.KAPSO_API_KEY
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        {
          number_id: business.kapso_number_id,
          to,
          type: 'image',
          image: { url: imageUrl, caption },
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
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
        `https://graph.facebook.com/v19.0/${business.meta_phone_id}/messages`,
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
        },
      )
    } else if (provider === 'kapso') {
      const apiKey = business.kapso_api_key || process.env.KAPSO_API_KEY
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        {
          number_id: business.kapso_number_id,
          to,
          type: 'video',
          video: { url: videoUrl, caption },
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
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

export { sendTyping, sendText, sendImage, sendVideo }
