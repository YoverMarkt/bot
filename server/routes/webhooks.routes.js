// ── RUTAS: WEBHOOKS DE WHATSAPP (Meta / YCloud / Kapso) ──────────────
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento. Aquí vive TODA la puerta de entrada de mensajes:
// verificación de firmas/secretos, rate-limit y anti-duplicados.
// (El raw body para la firma de Meta lo captura express.json en index.js.)
const express   = require('express')
const rateLimit = require('express-rate-limit')
const crypto    = require('crypto')
const axios     = require('axios')
const db        = require('../db')
const bot       = require('../bot')

const router = express.Router()

// Verifica la firma HMAC-SHA256 de Meta. Solo se exige si META_APP_SECRET está configurado.
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET
  if (!secret) return true // no configurado → no se exige (no rompe setups existentes)
  const sig = req.headers['x-hub-signature-256']
  if (!sig || !req.rawBody) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) }
  catch { return false }
}

// Verifica un secreto en la URL del webhook (?secret=...). Solo se exige si
// WEBHOOK_SECRET está configurado → opt-in, no rompe los webhooks ya activos.
// Configura la URL en YCloud/Kapso como: https://tu-dominio/webhook/ycloud?secret=<WEBHOOK_SECRET>
function verifyWebhookSecret(req) {
  const secret = process.env.WEBHOOK_SECRET
  if (!secret) return true // no configurado → no se exige
  const got = req.query.secret || req.headers['x-webhook-secret']
  try { return !!got && crypto.timingSafeEqual(Buffer.from(String(got)), Buffer.from(secret)) }
  catch { return false }
}

// Webhooks: máx 120 mensajes por IP por minuto (anti abuso de costos)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate limit' }
})

// ── ANTI-DUPLICADOS DE WEBHOOK (todos los proveedores) ─────────────
// YCloud/Meta/Kapso REINTENTAN la entrega si creen que no llegó (timeout,
// reinicio del server, cambio de túnel). Sin esta defensa, un mensaje viejo
// re-entregado hace que el bot le escriba "solo" al cliente (mensaje fantasma).
const seenInbound = new Map()              // msgId -> timestamp de procesado
const SEEN_TTL = 15 * 60 * 1000            // ventana típica de reintentos
function isDuplicateInbound(msgId) {
  if (!msgId) return false                 // sin ID no se puede dedup (no bloquear)
  const now = Date.now()
  if (seenInbound.size > 5000) {           // limpieza perezosa
    for (const [k, t] of seenInbound) if (now - t > SEEN_TTL) seenInbound.delete(k)
  }
  if (seenInbound.has(msgId)) return true
  seenInbound.set(msgId, now)
  return false
}
// Descarta mensajes demasiado viejos (reintentos tardíos que cruzan un reinicio,
// donde el dedup en memoria ya no los recuerda). Umbral amplio para no perder
// mensajes legítimos si el server estuvo caído un momento.
function isStaleInbound(ts) {
  if (!ts) return false
  const t = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts)
  if (isNaN(t)) return false
  return (Date.now() - t) > 10 * 60 * 1000   // >10 min = re-entrega vieja
}

// ══════════════════════════════════════════
// WEBHOOK — META (verificación hub)
// ══════════════════════════════════════════
router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
  if (token === process.env.META_VERIFY_TOKEN || mode === 'subscribe') {
    console.log('✅ Webhook Meta verificado')
    return res.status(200).send(challenge || 'OK')
  }
  res.sendStatus(403)
})

router.post('/webhook', webhookLimiter, async (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn('⚠️  Webhook Meta: firma inválida — rechazado')
    return res.sendStatus(401)
  }
  res.sendStatus(200)
  try {
    const body = req.body
    if (body.object !== 'whatsapp_business_account') return
    const value = body.entry?.[0]?.changes?.[0]?.value
    if (!value?.messages?.length) return
    const msg      = value.messages[0]
    if (isDuplicateInbound(msg.id) || isStaleInbound(msg.timestamp)) return console.log(`🔁 [Meta] mensaje duplicado/viejo ignorado (${msg.id || 'sin id'})`)
    const from     = msg.from
    const bizPhone = value.metadata?.display_phone_number
    if (msg.type === 'text') await bot.handleMessage(from, msg.text.body, bizPhone)
    if (msg.type === 'interactive') {
      const reply = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ''
      if (reply) await bot.handleMessage(from, reply, bizPhone)
    }
    // Audio / nota de voz → transcribir con Whisper
    if ((msg.type === 'audio' || msg.type === 'voice') && msg.audio?.id) {
      const biz = await db.getBusinessByPhone(bizPhone)
      if (biz?.meta_token) {
        const media = await axios.get(`https://graph.facebook.com/v19.0/${msg.audio.id}`, { headers: { Authorization: `Bearer ${biz.meta_token}` }, timeout: 15000 })
        const audioResp = await axios.get(media.data.url, { headers: { Authorization: `Bearer ${biz.meta_token}` }, responseType: 'arraybuffer', timeout: 20000 })
        const text = await bot.transcribeAudio(Buffer.from(audioResp.data), 'audio.ogg')
        if (text) { console.log(`🎙️  [Meta] audio transcrito: "${text}"`); await bot.handleMessage(from, text, bizPhone) }
      }
    }
  } catch(e) { console.error('❌ Webhook Meta:', e.message) }
})

// ══════════════════════════════════════════
// WEBHOOK — KAPSO
// ══════════════════════════════════════════
router.post('/webhook/kapso', webhookLimiter, async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.sendStatus(401)
  res.sendStatus(200)
  try {
    const body     = req.body
    const msg      = body.message || body.messages?.[0]
    if (isDuplicateInbound(msg?.id || body.id)) return console.log(`🔁 [Kapso] mensaje duplicado ignorado (${msg?.id || body.id})`)
    const from     = msg?.from || body.from
    const text     = msg?.text?.body || msg?.body || body.text
    const bizPhone = body.to || body.number_id
    if (from && text && bizPhone) {
      console.log(`📡 Kapso: de ${from} → ${bizPhone}: "${text}"`)
      await bot.handleMessage(from, text, bizPhone)
    } else if (from && bizPhone) {
      // Audio / nota de voz → transcribir con Whisper
      const audioUrl = msg?.audio?.url || msg?.audio?.link || msg?.media?.url || body.audio?.url
      if (audioUrl) {
        const biz = await db.getBusinessByPhone(bizPhone)
        const headers = (biz?.kapso_api_key || process.env.KAPSO_API_KEY) ? { Authorization: `Bearer ${biz?.kapso_api_key || process.env.KAPSO_API_KEY}` } : {}
        const audioResp = await axios.get(audioUrl, { headers, responseType: 'arraybuffer', timeout: 20000 })
        const trans = await bot.transcribeAudio(Buffer.from(audioResp.data), 'audio.ogg')
        if (trans) { console.log(`🎙️  [Kapso] audio transcrito: "${trans}"`); await bot.handleMessage(from, trans, bizPhone) }
      }
    }
  } catch(e) { console.error('❌ Webhook Kapso:', e.message) }
})

// ══════════════════════════════════════════
// WEBHOOK — YCLOUD
// ══════════════════════════════════════════
router.post('/webhook/ycloud', webhookLimiter, async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.sendStatus(401)
  res.sendStatus(200)
  try {
    const body = req.body
    console.log(`📨 [YCloud webhook] recibido — type: ${body.type || '(sin type)'}`)
    if (body.type !== 'whatsapp.inbound_message.received') return
    const msg      = body.whatsappInboundMessage
    if (!msg) return
    const from     = msg.from                         // número del cliente
    const bizPhone = msg.whatsappApiAccountPhoneNumber || msg.to  // número del negocio
    const inboundId = msg.id || msg.wamid                // ID para el typing indicator
    if (!from || !bizPhone) return
    if (isDuplicateInbound(inboundId) || isStaleInbound(msg.sendTime)) return console.log(`🔁 [YCloud] mensaje duplicado/viejo ignorado (${inboundId || 'sin id'})`)

    if (msg.type === 'text' && msg.text?.body) {
      console.log(`📡 YCloud: de ${from} → ${bizPhone}: "${msg.text.body}"`)
      await bot.handleMessage(from, msg.text.body, bizPhone, { inboundId })
    } else if (msg.type === 'audio' || msg.type === 'voice') {
      // Audio / nota de voz → transcribir con Whisper
      const audioUrl = msg.audio?.link || msg.audio?.url || msg.voice?.link
      if (audioUrl) {
        const audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 20000 })
        const trans = await bot.transcribeAudio(Buffer.from(audioResp.data), 'audio.ogg')
        if (trans) { console.log(`🎙️  [YCloud] audio transcrito: "${trans}"`); await bot.handleMessage(from, trans, bizPhone, { inboundId }) }
      }
    } else if (msg.type === 'image') {
      // Imagen → identificar el producto con visión y responder
      const imgUrl = msg.image?.link || msg.image?.url
      if (imgUrl) {
        const imgResp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 20000 })
        const mime = imgResp.headers['content-type'] || 'image/jpeg'
        console.log(`🖼️  [YCloud] imagen recibida de ${from}`)
        await bot.handleImage(from, Buffer.from(imgResp.data), mime, bizPhone, { inboundId })
      }
    }
  } catch(e) { console.error('❌ Webhook YCloud:', e.message) }
})

module.exports = router
