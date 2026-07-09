// @ts-check
// ── NOTIFICACIONES AL CONTACTO (servicio compartido) ─────────────────
// Envía un mensaje al cliente final por su canal real (Telegram o WhatsApp).
// Lo usan: el chat del panel (sessions/send) y las reservas (confirmar/cancelar).
async function sendToContact(biz, phone, message) {
  if (phone.startsWith('tg_')) {
    const chatId = phone.replace('tg_', '')
    const tgBot = require('../telegram').getBotInstance()
    if (tgBot) await tgBot.telegram.sendMessage(chatId, message)
  } else {
    const { sendWhatsAppMessage } = require('../bot')
    await sendWhatsAppMessage(biz, phone, message)
  }
}

module.exports = { sendToContact }
