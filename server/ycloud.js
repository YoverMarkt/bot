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

module.exports = { sendText, sendImage }
