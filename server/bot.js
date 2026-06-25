const Anthropic = require('@anthropic-ai/sdk')
const axios     = require('axios')
const db        = require('./db')
const ycloud    = require('./ycloud')
const { businessNeedsCalendar } = require('./calendar')
require('dotenv').config()

// ── ENVÍO DE MENSAJES WhatsApp ────────────────────────────
async function sendText(biz, to, text) {
  const provider = biz.whatsapp_provider || 'ycloud'
  try {
    if (provider === 'meta') {
      await axios.post(
        `https://graph.facebook.com/v19.0/${biz.meta_phone_id}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } },
        { headers: { 'Authorization': `Bearer ${biz.meta_token}`, 'Content-Type': 'application/json' } }
      )
    } else if (provider === 'kapso') {
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        { number_id: biz.kapso_number_id, to, type: 'text', text: { body: text } },
        { headers: { 'Authorization': `Bearer ${process.env.KAPSO_API_KEY}`, 'Content-Type': 'application/json' } }
      )
    } else {
      // YCloud (proveedor por defecto)
      const apiKey = biz.ycloud_api_key || process.env.YCLOUD_API_KEY
      const from   = biz.ycloud_number  || biz.whatsapp_number
      await ycloud.sendText(apiKey, from, to, text)
    }
  } catch(e) {
    console.error(`❌ [${provider}] sendText:`, e.response?.data || e.message)
  }
}

async function sendImage(biz, to, imageUrl, caption = '') {
  const provider = biz.whatsapp_provider || 'ycloud'
  try {
    if (provider === 'meta') {
      await axios.post(
        `https://graph.facebook.com/v19.0/${biz.meta_phone_id}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'image', image: { link: imageUrl, caption } },
        { headers: { 'Authorization': `Bearer ${biz.meta_token}`, 'Content-Type': 'application/json' } }
      )
    } else if (provider === 'kapso') {
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        { number_id: biz.kapso_number_id, to, type: 'image', image: { url: imageUrl, caption } },
        { headers: { 'Authorization': `Bearer ${process.env.KAPSO_API_KEY}`, 'Content-Type': 'application/json' } }
      )
    } else {
      const apiKey = biz.ycloud_api_key || process.env.YCLOUD_API_KEY
      const from   = biz.ycloud_number  || biz.whatsapp_number
      await ycloud.sendImage(apiKey, from, to, imageUrl, caption)
    }
  } catch(e) {
    console.error(`❌ [${provider}] sendImage:`, e.message)
  }
}

// ── PROMPT DEL BOT ────────────────────────────────────────
function buildPrompt(biz, products, policies, voiceMode = false) {
  const catalog = (products || []).map(p => {
    let l = `- ${p.name}${p.brand ? ` (${p.brand})` : ''} — $${parseFloat(p.price).toFixed(2)}`
    if (p.price_sale) l += ` (oferta: $${parseFloat(p.price_sale).toFixed(2)})`
    l += ` — ${p.stock}`
    if (p.description) l += `\n  ${p.description}`
    if (p.tags?.length)  l += ` | ${p.tags.join(', ')}`
    if (!voiceMode && p.image_url) l += `\n  [IMAGE:${p.image_url}]`
    return l
  }).join('\n\n')

  const calendarLine = !voiceMode && businessNeedsCalendar(biz.type) && biz.calcom_link
    ? `\nRESERVAS/CITAS: Disponibles. Si el cliente quiere agendar, incluye ##BOOKING## en tu respuesta.`
    : ''

  return `Eres el asistente virtual de "${biz.name}" (${biz.type || 'negocio'}).

DATOS DEL NEGOCIO:
Descripción: ${biz.description || ''}
Horario: ${biz.hours || 'No especificado'}
Dirección: ${biz.address || 'No especificada'}
Teléfono: ${biz.phone || ''}
Redes sociales: ${biz.social || ''}
Métodos de pago: ${biz.payment_methods || ''}
${calendarLine}

CATÁLOGO (${(products || []).length} productos):
${catalog || 'Sin productos cargados aún.'}

POLÍTICAS:
Envíos: ${policies?.shipping || 'Consultar directamente.'}
Devoluciones: ${policies?.returns || 'Consultar directamente.'}
Descuentos: ${policies?.discounts || 'Consultar directamente.'}

INSTRUCCIONES ESPECIALES:
${policies?.bot_instructions || ''}

REGLAS:
1. Responde siempre en español, amable y conciso.
2. Mensajes cortos — máximo 3-4 líneas.
3. ${voiceMode ? 'Es una llamada de voz — sin markdown ni emojis.' : 'Usa *negrita* para nombres de productos y precios.'}
4. ${voiceMode ? '' : 'Si el producto tiene [IMAGE:url], incluye ##IMG##url## al final.'}
5. NUNCA inventes precios ni información.
6. Si no sabes algo di: "Déjame verificar y te confirmo en breve 🙏"
7. Si el cliente quiere comprar: pide nombre, dirección y método de pago.`
}

// ── LÓGICA CENTRAL (reutilizada por WhatsApp y Telegram) ─
async function processMessage(biz, from, text, sendFn, sendImageFn) {
  if (biz.suspended) {
    await sendFn('⚠️ Este servicio tiene un pago pendiente. Contacta al administrador para regularizar tu cuenta. Disculpa los inconvenientes.')
    return console.log(`⛔ [${biz.name}] suspendido — aviso enviado`)
  }
  if (!biz.bot_active) return console.log(`⏸️  [${biz.name}] bot inactivo`)

  const [products, policies, history] = await Promise.all([
    db.getProducts(biz.id),
    db.getPolicies(biz.id),
    db.getContactHistory(biz.id, from, 8)
  ])

  await db.saveMessage(biz.id, from, 'user', text)

  let reply = ''
  try {
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const r = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: buildPrompt(biz, products, policies),
      messages: [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: text }
      ]
    })
    reply = r.content[0].text
  } catch(e) {
    console.error('❌ Claude:', e.message)
    reply = 'Disculpa, tuve un problema técnico. Intenta de nuevo 🙏'
  }

  // Extraer imagen inline
  const imgMatch = reply.match(/##IMG##(https?:\/\/[^\s#]+)##/)
  let finalText = imgMatch ? reply.replace(imgMatch[0], '').trim() : reply

  // Cal.com — enlace de reserva
  if (finalText.includes('##BOOKING##') && biz.calcom_link) {
    finalText = finalText.replace('##BOOKING##', '').trim()
    finalText += `\n\n📅 Agenda tu cita aquí:\n${biz.calcom_link}`
  } else {
    finalText = finalText.replace('##BOOKING##', '').trim()
  }

  await sendFn(finalText)

  if (imgMatch) {
    await sendImageFn(imgMatch[1], '')
  } else {
    const low = text.toLowerCase()
    const match = (products || []).find(p =>
      low.includes((p.name  || '').split(' ')[0].toLowerCase()) ||
      low.includes((p.brand || '').toLowerCase())
    )
    if (match?.image_url) await sendImageFn(match.image_url, match.name)
  }

  await db.saveMessage(biz.id, from, 'assistant', reply)
  console.log(`🤖 [${biz.name}] respondido`)
}

// ── ENTRADA PRINCIPAL ─────────────────────────────────────
async function handleMessage(from, text, bizPhone, opts = {}) {
  // Canal Telegram
  if (opts.channel === 'telegram') {
    const biz = await db.getBusinessBySlug(opts.slug)
    if (!biz) return opts.ctx?.reply('❌ Negocio no encontrado')
    console.log(`\n📩 [TG:${opts.slug}] de ${from}: "${text}"`)
    return processMessage(
      biz, from, text,
      t  => opts.ctx.reply(t),
      (url, cap) => opts.ctx.replyWithPhoto({ url }, { caption: cap }).catch(() => {})
    )
  }

  // Canal WhatsApp (YCloud / Meta)
  console.log(`\n📩 [WA:${bizPhone}] de ${from}: "${text}"`)
  const biz = await db.getBusinessByPhone(bizPhone)
  if (!biz) return console.log('⚠️  Negocio no encontrado:', bizPhone)

  return processMessage(
    biz, from, text,
    t  => sendText(biz, from, t),
    (url, cap) => sendImage(biz, from, url, cap)
  )
}

module.exports = { handleMessage, buildPrompt }
