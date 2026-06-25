const express = require('express')
const cors    = require('cors')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const path    = require('path')
require('dotenv').config()

const Anthropic = require('@anthropic-ai/sdk')
const axios   = require('axios')
const db      = require('./db')
const bot     = require('./bot')
const retell  = require('./retell')
const tunnel  = require('./tunnel')
const { setupTelegram } = require('./telegram')
const app     = express()

app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '10mb' }))

// Paneles
app.use('/admin',  express.static(path.join(__dirname, '../admin')))
app.use('/client', express.static(path.join(__dirname, '../client')))
app.get('/', (_, res) => res.redirect('/admin'))

const JWT = () => process.env.JWT_SECRET

// ── AUTH MIDDLEWARES ──
function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No autorizado' })
  try {
    const d = jwt.verify(token, JWT())
    if (d.role !== 'admin') return res.status(403).json({ error: 'Solo admins' })
    req.user = d; next()
  } catch { res.status(401).json({ error: 'Token inválido' }) }
}

function authClient(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No autorizado' })
  try { req.user = jwt.verify(token, JWT()); next() }
  catch { res.status(401).json({ error: 'Token inválido' }) }
}

// ══════════════════════════════════════════
// ADMIN — LOGIN
// ══════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Credenciales incorrectas' })
  const token = jwt.sign({ role: 'admin', email }, JWT(), { expiresIn: '7d' })
  res.json({ token })
})

// ══════════════════════════════════════════
// ADMIN — STATS Y CLIENTES
// ══════════════════════════════════════════
app.get('/api/admin/stats', authAdmin, async (req, res) => {
  res.json(await db.getAdminStats())
})

app.get('/api/admin/clients', authAdmin, async (req, res) => {
  res.json(await db.getAllBusinesses())
})

app.get('/api/admin/clients/:id', authAdmin, async (req, res) => {
  const biz = await db.getBusinessById(req.params.id)
  biz ? res.json(biz) : res.status(404).json({ error: 'No encontrado' })
})

app.post('/api/admin/clients', authAdmin, async (req, res) => {
  const {
    name, type, whatsapp_number, whatsapp_provider,
    kapso_api_key, kapso_number_id, kapso_verify_token,
    ycloud_api_key, ycloud_number,
    meta_token, meta_phone_id, meta_verify_token,
    telegram_bot_token, calcom_link, retell_agent_id,
    plan, plan_expires_at, client_email, client_password, notes, monthly_rate
  } = req.body
  if (!name || !whatsapp_number) return res.status(400).json({ error: 'Nombre y número requeridos' })
  try {
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now()
    const { data: biz, error } = await db.createBusiness({
      slug, name, type: type || 'negocio',
      whatsapp_number,
      whatsapp_provider: whatsapp_provider || 'ycloud',
      kapso_api_key,     kapso_number_id,   kapso_verify_token,
      ycloud_api_key,    ycloud_number,
      meta_token,        meta_phone_id,   meta_verify_token,
      plan: plan || 'basic',
      plan_expires_at: plan_expires_at || null,
      active: true, bot_active: true, suspended: false, notes
    })
    if (error) return res.status(500).json({ error: error.message })
    await db.upsertPolicies(biz.id, {})
    if (client_email && client_password) {
      const hash = await bcrypt.hash(client_password, 10)
      await db.createClientUser({ business_id: biz.id, email: client_email, password_hash: hash })
    }
    if (monthly_rate && parseFloat(monthly_rate) > 0) {
      const rows = db.generateYearBilling(biz.id, parseFloat(monthly_rate))
      await db.createBillingBatch(rows)
      console.log(`💳 12 meses generados para ${name} — $${monthly_rate}/mes`)
    }
    res.status(201).json(biz)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.put('/api/admin/clients/:id', authAdmin, async (req, res) => {
  await db.updateBusiness(req.params.id, req.body)
  res.json({ ok: true })
})

app.delete('/api/admin/clients/:id', authAdmin, async (req, res) => {
  try {
    await db.deleteBusiness(req.params.id)
    console.log(`🗑️ Cliente eliminado: ${req.params.id}`)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/admin/clients/:id/generate-billing', authAdmin, async (req, res) => {
  const { monthly_rate } = req.body
  if (!monthly_rate || parseFloat(monthly_rate) <= 0)
    return res.status(400).json({ error: 'Tarifa mensual requerida' })
  try {
    const rows = db.generateYearBilling(req.params.id, parseFloat(monthly_rate))
    await db.createBillingBatch(rows)
    console.log(`💳 ${rows.length} meses generados para cliente ${req.params.id}`)
    res.json({ ok: true, created: rows.length })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/admin/clients/:id/suspend', authAdmin, async (req, res) => {
  await db.suspendBusiness(req.params.id, req.body.reason || 'Pago pendiente')
  console.log(`⛔ Cliente suspendido: ${req.params.id}`)
  res.json({ ok: true })
})

app.post('/api/admin/clients/:id/reactivate', authAdmin, async (req, res) => {
  await db.reactivateBusiness(req.params.id)
  console.log(`✅ Cliente reactivado: ${req.params.id}`)
  res.json({ ok: true })
})

app.post('/api/admin/clients/:id/create-user', authAdmin, async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' })
  const hash = await bcrypt.hash(password, 10)
  const { data, error } = await db.createClientUser({ business_id: req.params.id, email, password_hash: hash })
  error ? res.status(500).json({ error: error.message }) : res.json({ ok: true })
})

app.get('/api/admin/clients/:id/products',      authAdmin, async (req, res) => res.json(await db.getProducts(req.params.id)))
app.get('/api/admin/clients/:id/conversations', authAdmin, async (req, res) => res.json(await db.getConversations(req.params.id)))
app.get('/api/admin/clients/:id/policies',      authAdmin, async (req, res) => res.json(await db.getPolicies(req.params.id) || {}))
app.put('/api/admin/clients/:id/policies',      authAdmin, async (req, res) => { await db.upsertPolicies(req.params.id, req.body); res.json({ ok: true }) })

// ══════════════════════════════════════════
// ADMIN — FACTURACIÓN
// ══════════════════════════════════════════
app.get('/api/admin/billing', authAdmin, async (req, res) => res.json(await db.getBilling()))

app.post('/api/admin/billing', authAdmin, async (req, res) => {
  const { data, error } = await db.createBilling(req.body)
  error ? res.status(500).json({ error: error.message }) : res.json(data)
})

app.put('/api/admin/billing/:id', authAdmin, async (req, res) => {
  await db.updateBillingStatus(req.params.id, req.body.status, req.body.paid_at)
  res.json({ ok: true })
})

// ══════════════════════════════════════════
// CLIENT — LOGIN
// ══════════════════════════════════════════
app.post('/api/client/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const user = await db.getClientByEmail(email)
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' })
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Contraseña incorrecta' })
    const biz = await db.getBusinessById(user.business_id)
    if (!biz?.active) return res.status(403).json({ error: 'Tu cuenta no está activa. Contacta al administrador.' })
    const token = jwt.sign({ userId: user.id, businessId: user.business_id, role: 'client', email }, JWT(), { expiresIn: '7d' })
    res.json({ token, business: { id: biz.id, name: biz.name, type: biz.type, suspended: biz.suspended, bot_active: biz.bot_active } })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ══════════════════════════════════════════
// CLIENT — DATOS (solo su negocio)
// ══════════════════════════════════════════
app.get('/api/client/stats', authClient, async (req, res) => res.json(await db.getClientStats(req.user.businessId)))

app.get('/api/client/business', authClient, async (req, res) => {
  const b = await db.getBusinessById(req.user.businessId)
  // Solo datos públicos — SIN credenciales de WhatsApp
  res.json({ id: b.id, name: b.name, type: b.type, description: b.description, hours: b.hours, address: b.address, phone: b.phone, social: b.social, payment_methods: b.payment_methods, suspended: b.suspended, bot_active: b.bot_active })
})

app.get('/api/client/products',      authClient, async (req, res) => res.json(await db.getProducts(req.user.businessId)))
app.get('/api/client/conversations', authClient, async (req, res) => res.json(await db.getConversations(req.user.businessId)))
app.get('/api/client/policies',      authClient, async (req, res) => res.json(await db.getPolicies(req.user.businessId) || {}))
app.put('/api/client/policies',      authClient, async (req, res) => { await db.upsertPolicies(req.user.businessId, req.body); res.json({ ok: true }) })

app.post('/api/client/products', authClient, async (req, res) => {
  const { name, price } = req.body
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio requeridos' })
  const { data, error } = await db.createProduct({ ...req.body, business_id: req.user.businessId, price: parseFloat(price), active: true })
  error ? res.status(500).json({ error: error.message }) : res.status(201).json(data)
})

app.put('/api/client/products/:id',    authClient, async (req, res) => { await db.updateProduct(req.params.id, req.body); res.json({ ok: true }) })
app.delete('/api/client/products/:id', authClient, async (req, res) => { await db.deleteProduct(req.params.id); res.json({ ok: true }) })

// ══════════════════════════════════════════
// WEBHOOK — META (verificación hub)
// ══════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
  if (token === process.env.META_VERIFY_TOKEN || mode === 'subscribe') {
    console.log('✅ Webhook Meta verificado')
    return res.status(200).send(challenge || 'OK')
  }
  res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
  res.sendStatus(200)
  try {
    const body = req.body
    if (body.object !== 'whatsapp_business_account') return
    const value = body.entry?.[0]?.changes?.[0]?.value
    if (!value?.messages?.length) return
    const msg      = value.messages[0]
    const from     = msg.from
    const bizPhone = value.metadata?.display_phone_number
    if (msg.type === 'text') await bot.handleMessage(from, msg.text.body, bizPhone)
    if (msg.type === 'interactive') {
      const reply = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ''
      if (reply) await bot.handleMessage(from, reply, bizPhone)
    }
  } catch(e) { console.error('❌ Webhook Meta:', e.message) }
})

// ══════════════════════════════════════════
// WEBHOOK — KAPSO
// ══════════════════════════════════════════
app.post('/webhook/kapso', async (req, res) => {
  res.sendStatus(200)
  try {
    const body     = req.body
    const msg      = body.message || body.messages?.[0]
    const from     = msg?.from || body.from
    const text     = msg?.text?.body || msg?.body || body.text
    const bizPhone = body.to || body.number_id
    if (from && text && bizPhone) {
      console.log(`📡 Kapso: de ${from} → ${bizPhone}: "${text}"`)
      await bot.handleMessage(from, text, bizPhone)
    }
  } catch(e) { console.error('❌ Webhook Kapso:', e.message) }
})

// ══════════════════════════════════════════
// WEBHOOK — YCLOUD
// ══════════════════════════════════════════
app.post('/webhook/ycloud', async (req, res) => {
  res.sendStatus(200)
  try {
    const body = req.body
    if (body.type !== 'whatsapp.inbound_message.received') return
    const msg      = body.whatsappInboundMessage
    if (!msg || msg.type !== 'text') return
    const from     = msg.from                         // número del cliente
    const bizPhone = msg.whatsappApiAccountPhoneNumber || msg.to  // número del negocio
    const text     = msg.text?.body
    if (from && text && bizPhone) {
      console.log(`📡 YCloud: de ${from} → ${bizPhone}: "${text}"`)
      await bot.handleMessage(from, text, bizPhone)
    }
  } catch(e) { console.error('❌ Webhook YCloud:', e.message) }
})

// ══════════════════════════════════════════
// RETELL AI — Custom LLM + Call Events
// ══════════════════════════════════════════
app.post('/api/retell/llm',         retell.handleRetellLLM)
app.post('/api/retell/call-events', retell.handleRetellCallEvent)

// ══════════════════════════════════════════
// VERIFICACIÓN DE PROVEEDORES
// ══════════════════════════════════════════

// Lógica central reutilizada por modal y tabla
async function verifyProvider(payload) {
  const { provider, ycloud_api_key, ycloud_number,
          meta_token, meta_phone_id,
          kapso_api_key, kapso_number_id,
          telegram_bot_token, retell_api_key } = payload
  try {
    if (provider === 'ycloud') {
      const key = ycloud_api_key || process.env.YCLOUD_API_KEY
      if (!key) return { ok: false, info: 'Falta YCloud API Key' }
      const r = await axios.get('https://api.ycloud.com/v2/whatsapp/phone-numbers', {
        headers: { 'X-API-Key': key }, params: { page: 1, pageSize: 10 }, timeout: 8000
      })
      const nums = r.data.items || []
      const found = ycloud_number ? nums.find(n => n.phoneNumber?.includes(ycloud_number.replace('+',''))) : null
      const info  = found
        ? `✅ Número ${found.phoneNumber} — ${found.displayName || 'conectado'}`
        : `${nums.length} número(s) en la cuenta YCloud`
      return { ok: true, info }
    }

    if (provider === 'meta') {
      if (!meta_phone_id || !meta_token) return { ok: false, info: 'Faltan Meta Token y Phone ID' }
      const r = await axios.get(`https://graph.facebook.com/v19.0/${meta_phone_id}`, {
        params: { access_token: meta_token, fields: 'display_phone_number,verified_name,code_verification_status' },
        timeout: 8000
      })
      return { ok: true, info: `${r.data.verified_name} — ${r.data.display_phone_number} (${r.data.code_verification_status || 'verificado'})` }
    }

    if (provider === 'kapso') {
      const key = payload.kapso_api_key || process.env.KAPSO_API_KEY
      if (!key) return { ok: false, info: 'Falta la Kapso API Key' }
      const r = await axios.get('https://api.kapso.ai/v1/account', {
        headers: { 'Authorization': `Bearer ${key}` }, timeout: 8000
      })
      return { ok: true, info: `Kapso conectado — ${r.data?.name || 'cuenta activa'}` }
    }

    if (provider === 'telegram') {
      const token = telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN
      if (!token) return { ok: false, info: 'Falta el Bot Token de Telegram' }
      const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8000 })
      if (!r.data.ok) throw new Error('Token inválido')
      const b = r.data.result
      return { ok: true, info: `@${b.username} (${b.first_name}) — bot activo` }
    }

    if (provider === 'retell') {
      const key = retell_api_key || process.env.RETELL_API_KEY
      if (!key) return { ok: false, info: 'Falta RETELL_API_KEY en el .env del servidor' }
      const r = await axios.get('https://api.retell.ai/list-agents', {
        headers: { 'Authorization': `Bearer ${key}` }, timeout: 8000
      })
      const agents = Array.isArray(r.data) ? r.data : []
      return { ok: true, info: `${agents.length} agente(s) configurado(s) en Retell` }
    }

    return { ok: false, info: `Proveedor "${provider}" no reconocido` }
  } catch(e) {
    const msg = e.response?.data?.error?.message
           || e.response?.data?.message
           || e.response?.data?.description
           || e.message
    return { ok: false, info: msg }
  }
}

// Verificar desde el modal (form data)
app.post('/api/admin/verify-provider', authAdmin, async (req, res) => {
  res.json(await verifyProvider(req.body))
})

// Verificar desde la tabla (datos guardados en DB)
app.post('/api/admin/clients/:id/verify', authAdmin, async (req, res) => {
  const biz = await db.getBusinessById(req.params.id)
  if (!biz) return res.status(404).json({ error: 'No encontrado' })
  res.json(await verifyProvider({
    provider: biz.whatsapp_provider || 'ycloud',
    ycloud_api_key: biz.ycloud_api_key,
    ycloud_number:  biz.ycloud_number,
    meta_token:     biz.meta_token,
    meta_phone_id:  biz.meta_phone_id,
    kapso_api_key:   biz.kapso_api_key,
    kapso_number_id: biz.kapso_number_id,
    telegram_bot_token: biz.telegram_bot_token,
  }))
})

// ══════════════════════════════════════════
// TÚNEL PÚBLICO (cloudflared / localtunnel)
// ══════════════════════════════════════════
app.get('/api/admin/tunnel', authAdmin, (_, res) => {
  // En producción con BASE_URL, siempre está "activo"
  if (process.env.BASE_URL) {
    return res.json({ url: process.env.BASE_URL, active: true, provider: 'dominio propio', startedAt: null })
  }
  res.json(tunnel.getState())
})

app.post('/api/admin/tunnel/start', authAdmin, async (req, res) => {
  try {
    const state = await tunnel.startTunnel(process.env.PORT || 3000)
    res.json(state)
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/admin/tunnel/stop', authAdmin, (_, res) => {
  tunnel.stopTunnel()
  res.json({ ok: true })
})

// ══════════════════════════════════════════
// SIMULADOR DE BOT (sin WhatsApp real)
// ══════════════════════════════════════════
app.post('/api/admin/simulate', authAdmin, async (req, res) => {
  const { business_id, message } = req.body
  if (!business_id || !message) return res.status(400).json({ error: 'business_id y message requeridos' })

  const biz = await db.getBusinessById(business_id)
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' })

  const simFrom = 'sim_admin'
  try {
    const [products, policies, history] = await Promise.all([
      db.getProducts(biz.id),
      db.getPolicies(biz.id),
      db.getContactHistory(biz.id, simFrom, 8)
    ])

    await db.saveMessage(biz.id, simFrom, 'user', message)

    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const r = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: bot.buildPrompt(biz, products, policies),
      messages: [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message }
      ]
    })
    const raw = r.content[0].text

    const imgMatch = raw.match(/##IMG##(https?:\/\/[^\s#]+)##/)
    const hasBooking = raw.includes('##BOOKING##')
    let reply = raw.replace(/##IMG##[^\s#]+##/g, '').replace('##BOOKING##', '').trim()
    if (hasBooking && biz.calcom_link) reply += `\n\n📅 Agenda tu cita aquí:\n${biz.calcom_link}`

    await db.saveMessage(biz.id, simFrom, 'assistant', raw)
    console.log(`🧪 [Sim] ${biz.name}: respondido`)
    res.json({ reply, image: imgMatch?.[1] || null })
  } catch(e) {
    console.error('❌ Simulate:', e.message)
    res.json({ reply: `Error: ${e.message}` })
  }
})

app.delete('/api/admin/simulate/:bizId/history', authAdmin, async (req, res) => {
  await db.clearSimHistory(req.params.bizId)
  res.json({ ok: true })
})

// SUPABASE CONFIG — para Realtime en el frontend
// La anon key es pública por diseño de Supabase, es seguro exponerla
app.get('/api/admin/supabase-config', authAdmin, (_, res) => {
  res.json({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY })
})
app.get('/api/client/supabase-config', authClient, (_, res) => {
  res.json({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY })
})

// HEALTH
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }))

// SPA fallbacks
app.get('/admin/*',  (_, res) => res.sendFile(path.join(__dirname, '../admin/index.html')))
app.get('/client/*', (_, res) => res.sendFile(path.join(__dirname, '../client/index.html')))

async function checkExpiredClients() {
  try {
    const expired = await db.getExpiredBusinesses()
    for (const biz of expired) {
      await db.suspendBusiness(biz.id, 'Plan vencido — renovación requerida')
      console.log(`⛔ Auto-suspendido por vencimiento: ${biz.name}`)
    }
    if (expired.length) console.log(`⏰ Verificación: ${expired.length} cliente(s) suspendido(s) por vencimiento`)
  } catch(e) {
    console.error('Error verificando vencimientos:', e.message)
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`\n🚀 BotPanel corriendo en http://localhost:${PORT}`)
  console.log(`👑 Admin:   http://localhost:${PORT}/admin`)
  console.log(`👤 Cliente: http://localhost:${PORT}/client`)
  console.log(`📡 Webhook: http://localhost:${PORT}/webhook\n`)

  // Verificar vencimientos al arrancar y cada hora
  setTimeout(checkExpiredClients, 3000)
  setInterval(checkExpiredClients, 60 * 60 * 1000)

  // Telegram bot (polling local / webhook en producción)
  setupTelegram(app, bot.handleMessage).then(() => {
    if (process.env.BASE_URL) console.log(`🌐 Producción: ${process.env.BASE_URL}`)
  }).catch(e => console.error('❌ Telegram setup:', e.message))
})
