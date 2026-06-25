const express = require('express')
const cors    = require('cors')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const path    = require('path')
require('dotenv').config()

const db  = require('./db')
const bot = require('./bot')
const app = express()

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
    kapso_number_id, kapso_verify_token,
    meta_token, meta_phone_id, meta_verify_token,
    plan, client_email, client_password, notes
  } = req.body
  if (!name || !whatsapp_number) return res.status(400).json({ error: 'Nombre y número requeridos' })
  try {
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now()
    const { data: biz, error } = await db.createBusiness({
      slug, name, type: type || 'negocio',
      whatsapp_number,
      whatsapp_provider: whatsapp_provider || 'kapso',
      kapso_number_id,   kapso_verify_token,
      meta_token,        meta_phone_id,   meta_verify_token,
      plan: plan || 'basic',
      active: true, bot_active: true, suspended: false, notes
    })
    if (error) return res.status(500).json({ error: error.message })
    await db.upsertPolicies(biz.id, {})
    if (client_email && client_password) {
      const hash = await bcrypt.hash(client_password, 10)
      await db.createClientUser({ business_id: biz.id, email: client_email, password_hash: hash })
    }
    res.status(201).json(biz)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.put('/api/admin/clients/:id', authAdmin, async (req, res) => {
  await db.updateBusiness(req.params.id, req.body)
  res.json({ ok: true })
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
// WEBHOOK — KAPSO Y META (mismo endpoint)
// ══════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
  const kapsoToken = process.env.KAPSO_VERIFY_TOKEN
  const metaToken  = process.env.META_VERIFY_TOKEN
  if (token === kapsoToken || token === metaToken || mode === 'subscribe') {
    console.log('✅ Webhook verificado')
    return res.status(200).send(challenge || 'OK')
  }
  res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
  res.sendStatus(200)
  try {
    const body = req.body

    // Formato Meta
    if (body.object === 'whatsapp_business_account') {
      const value = body.entry?.[0]?.changes?.[0]?.value
      if (!value?.messages?.length) return
      const msg = value.messages[0]
      const from = msg.from
      const bizPhone = value.metadata?.display_phone_number
      if (msg.type === 'text') await bot.handleMessage(from, msg.text.body, bizPhone)
      if (msg.type === 'interactive') {
        const reply = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ''
        if (reply) await bot.handleMessage(from, reply, bizPhone)
      }
      return
    }

    // Formato Kapso
    const msg      = body.message || body.messages?.[0]
    const from     = msg?.from || body.from
    const text     = msg?.text?.body || msg?.body || body.text
    const bizPhone = body.to || body.number_id
    if (from && text) await bot.handleMessage(from, text, bizPhone)

  } catch(e) { console.error('❌ Webhook:', e.message) }
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`\n🚀 BotPanel corriendo en http://localhost:${PORT}`)
  console.log(`👑 Admin:   http://localhost:${PORT}/admin`)
  console.log(`👤 Cliente: http://localhost:${PORT}/client`)
  console.log(`📡 Webhook: http://localhost:${PORT}/webhook\n`)
})
