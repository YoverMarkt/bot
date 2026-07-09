// @ts-check
const axios = require('axios')

const BASE = 'https://api.ycloud.com/v2'

function headers(apiKey) {
  return { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }
}

async function sendText(apiKey, fromNumber, to, text) {
  await axios.post(`${BASE}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'text',
    text: { body: text }
  }, { headers: headers(apiKey) })
}

async function sendImage(apiKey, fromNumber, to, imageUrl, caption = '') {
  await axios.post(`${BASE}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'image',
    image: { link: imageUrl, caption }
  }, { headers: headers(apiKey) })
}

async function sendVideo(apiKey, fromNumber, to, videoUrl, caption = '') {
  await axios.post(`${BASE}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'video',
    video: { link: videoUrl, caption }
  }, { headers: headers(apiKey) })
}

// Marca el mensaje entrante como leído (✓✓ azul) y muestra "escribiendo…" al cliente.
// El indicador se quita al enviar la respuesta o a los 25s.
async function showTyping(apiKey, inboundMessageId) {
  if (!inboundMessageId) return
  await axios.post(
    `${BASE}/whatsapp/inboundMessages/${inboundMessageId}/typingIndicator`,
    {},
    { headers: headers(apiKey), timeout: 8000 }
  )
}

module.exports = { sendText, sendImage, sendVideo, showTyping }
