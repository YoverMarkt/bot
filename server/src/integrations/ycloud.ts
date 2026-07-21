import axios from 'axios'

const BASE_URL = 'https://api.ycloud.com/v2'
const OUTBOUND_TIMEOUT_MS = 15_000

function headers(apiKey: string) {
  return { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }
}

export async function sendText(
  apiKey: string,
  fromNumber: string,
  to: string,
  text: string,
): Promise<void> {
  await axios.post(`${BASE_URL}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'text',
    text: { body: text },
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

export async function sendImage(
  apiKey: string,
  fromNumber: string,
  to: string,
  imageUrl: string,
  caption = '',
): Promise<void> {
  await axios.post(`${BASE_URL}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'image',
    image: { link: imageUrl, caption },
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

export async function sendVideo(
  apiKey: string,
  fromNumber: string,
  to: string,
  videoUrl: string,
  caption = '',
): Promise<void> {
  await axios.post(`${BASE_URL}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'video',
    video: { link: videoUrl, caption },
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

// Marca el mensaje entrante como leído (✓✓ azul) y muestra "escribiendo…".
// YCloud retira el indicador al enviar la respuesta o después de 25 segundos.
export async function showTyping(apiKey: string, inboundMessageId?: string | null): Promise<void> {
  if (!inboundMessageId) return

  await axios.post(
    `${BASE_URL}/whatsapp/inboundMessages/${inboundMessageId}/typingIndicator`,
    {},
    { headers: headers(apiKey), timeout: 8000 },
  )
}
