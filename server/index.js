const express = require('express')
const cors    = require('cors')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const path    = require('path')
const fs      = require('fs')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const Anthropic = require('@anthropic-ai/sdk')
const axios     = require('axios')
const db        = require('./db')
const bot       = require('./bot')
const reports   = require('./reports')
const retell    = require('./retell')
const tunnel    = require('./tunnel')
const srvSettings = require('./settings')
const { setupTelegram } = require('./telegram')
const app     = express()

// Railway/producción corre detrás de un proxy: sin esto express-rate-limit
// no ve la IP real (bloquearía a todos) y puede lanzar error por X-Forwarded-For.
app.set('trust proxy', 1)

// ── RED DE SEGURIDAD: el server NUNCA debe caerse por un error aislado ──
process.on('uncaughtException', (err) => {
  console.error('🛑 uncaughtException (server sigue vivo):', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('🛑 unhandledRejection (server sigue vivo):', reason?.message || reason)
})

// ── CHEQUEO DE ENTORNO (avisa fuerte si falta algo crítico en el deploy) ──
function checkEnv() {
  const critical = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']
  const recommended = ['BASE_URL', 'WEBHOOK_SECRET']
  const missing = critical.filter(k => !process.env[k] || !String(process.env[k]).trim())
  const missingRec = recommended.filter(k => !process.env[k] || !String(process.env[k]).trim())
  if (missing.length) {
    console.error('\n❌ FALTAN variables CRÍTICAS (el panel/login no funcionará):', missing.join(', '))
    console.error('   Configúralas en Railway → Variables antes de usar en producción.\n')
  }
  if (missingRec.length) {
    console.warn('⚠️  Faltan variables recomendadas en producción:', missingRec.join(', '),
      '\n   BASE_URL desactiva el túnel local y fija la URL; WEBHOOK_SECRET protege los webhooks.')
  }
  if (!missing.length) console.log('✅ Variables de entorno críticas: OK')
}

const crypto = require('crypto')
app.use(cors({ origin: '*' }))
// Capturar raw body para verificar firmas de webhooks (Meta)
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf } }))

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

// ── RATE LIMITING ─────────────────────────────────────────
// Login: máx 20 intentos FALLIDOS por IP cada 15 min (anti fuerza bruta).
// Los logins exitosos no gastan el cupo, así que usuarios legítimos no se bloquean.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Espera 15 minutos.' }
})
// Webhooks: máx 120 mensajes por IP por minuto (anti abuso de costos)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate limit' }
})

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

// El permiso se valida en el SERVIDOR (no basta ocultar el menú). El dueño siempre pasa.
function requirePermission(section) {
  return (req, res, next) => {
    if (req.user?.urole === 'owner') return next()
    const perms = Array.isArray(req.user?.perms) ? req.user.perms : []
    if (perms.includes(section)) return next()
    return res.status(403).json({ error: 'No tienes permiso para esta sección' })
  }
}
function requireOwner(req, res, next) {
  if (req.user?.urole === 'owner') return next()
  return res.status(403).json({ error: 'Solo el dueño puede hacer esto' })
}

// ══════════════════════════════════════════
// ADMIN — LOGIN
// ══════════════════════════════════════════
app.post('/api/admin/login', loginLimiter, (req, res) => {
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
  if (!biz) return res.status(404).json({ error: 'No encontrado' })
  // Adjuntar el correo real del usuario de ESTE negocio (para que el panel lo muestre al editar)
  const user = await db.getClientUserByBusiness(req.params.id)
  res.json({ ...biz, client_email: user?.email || '' })
})

app.post('/api/admin/clients', authAdmin, async (req, res) => {
  const {
    name, type, whatsapp_number, whatsapp_provider,
    kapso_api_key, kapso_number_id, kapso_verify_token,
    ycloud_api_key, ycloud_number,
    meta_token, meta_phone_id, meta_verify_token,
    telegram_bot_token, retell_agent_id, ai_provider, takes_bookings,
    plan, plan_expires_at, client_email, client_password, notes, monthly_rate, owner_phone
  } = req.body
  if (!name || !whatsapp_number) return res.status(400).json({ error: 'Nombre y número requeridos' })
  try {
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now()
    const bizPayload = {
      slug, name, type: type || 'negocio',
      whatsapp_number,
      whatsapp_provider: whatsapp_provider || 'ycloud',
      kapso_api_key,     kapso_number_id,   kapso_verify_token,
      ycloud_api_key,    ycloud_number,
      meta_token,        meta_phone_id,   meta_verify_token,
      telegram_bot_token: telegram_bot_token || null,
      retell_agent_id:   retell_agent_id || null,
      takes_bookings:    takes_bookings === true,
      ai_provider:       ai_provider || null,
      owner_phone:       owner_phone || null,
      plan: plan || 'basic',
      plan_expires_at: plan_expires_at || null,
      active: true, bot_active: true, suspended: false, notes
    }
    let { data: biz, error } = await db.createBusiness(bizPayload)
    // Si la columna takes_bookings aún no existe (migración sin correr), reintenta sin ella
    if (error && /takes_bookings/.test(error.message || '')) {
      const { takes_bookings: _omit, ...fallback } = bizPayload
      ;({ data: biz, error } = await db.createBusiness(fallback))
    }
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
  // Solo columnas que existen en la tabla businesses (evita que un campo inválido
  // como monthly_rate haga fallar TODO el update en silencio)
  const ALLOWED = ['name','type','description','hours','address','phone','social','payment_methods',
    'whatsapp_number','whatsapp_provider','plan','plan_expires_at','active','bot_active','suspended',
    'notes','slogan','monthly_rate','owner_phone','ycloud_api_key','ycloud_number','kapso_api_key','kapso_number_id','kapso_verify_token',
    'meta_token','meta_phone_id','meta_verify_token','telegram_bot_token','retell_agent_id','ai_provider','takes_bookings']
  const bizData = {}
  for (const k of ALLOWED) if (k in req.body) bizData[k] = req.body[k]
  if ('monthly_rate' in bizData) bizData.monthly_rate = parseFloat(bizData.monthly_rate) || null
  try {
    if (Object.keys(bizData).length) {
      let { error } = await db.updateBusiness(req.params.id, bizData)
      // Reintento si una columna aún no existe en la BD (migración sin correr): monthly_rate o takes_bookings
      if (error && /(monthly_rate|takes_bookings)/.test(error.message || '')) {
        delete bizData.monthly_rate
        delete bizData.takes_bookings
        ;({ error } = await db.updateBusiness(req.params.id, bizData))
      }
      if (error) return res.status(500).json({ error: error.message })
    }
    // Si cambió el monto mensual → actualizar la facturación pendiente al nuevo valor
    const rate = parseFloat(req.body.monthly_rate)
    if (rate > 0) {
      const existing = await db.countBilling(req.params.id)
      if (existing > 0) {
        await db.updatePendingBilling(req.params.id, rate)
        console.log(`💳 Facturación pendiente actualizada a $${rate}/mes para ${req.params.id}`)
      } else {
        await db.createBillingBatch(db.generateYearBilling(req.params.id, rate))
        console.log(`💳 12 meses generados a $${rate}/mes para ${req.params.id}`)
      }
    }
    if (req.body.client_email) {
      const hash = req.body.client_password ? await bcrypt.hash(req.body.client_password, 10) : null
      await db.updateClientUser(req.params.id, req.body.client_email, hash)
    }
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
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
app.post('/api/client/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body
  try {
    const user = await db.getClientByEmail(email)
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' })
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Contraseña incorrecta' })
    const biz = await db.getBusinessById(user.business_id)
    if (!biz?.active) return res.status(403).json({ error: 'Tu cuenta no está activa. Contacta al administrador.' })
    const urole = user.role || 'owner'
    const perms = Array.isArray(user.permissions) ? user.permissions : []
    const token = jwt.sign({ userId: user.id, businessId: user.business_id, role: 'client', urole, perms, email }, JWT(), { expiresIn: '7d' })
    res.json({ token, user: { name: user.name || '', role: urole, permissions: perms }, business: { id: biz.id, name: biz.name, type: biz.type, suspended: biz.suspended, bot_active: biz.bot_active } })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ══════════════════════════════════════════
// CLIENT — DATOS (solo su negocio)
// ══════════════════════════════════════════
app.get('/api/client/stats', authClient, async (req, res) => res.json(await db.getClientStats(req.user.businessId)))

app.get('/api/client/business', authClient, async (req, res) => {
  const b = await db.getBusinessById(req.user.businessId)
  // Solo datos públicos — SIN credenciales de WhatsApp
  res.json({ id: b.id, name: b.name, type: b.type, slogan: b.slogan, description: b.description, hours: b.hours, address: b.address, phone: b.phone, social: b.social, payment_methods: b.payment_methods, suspended: b.suspended, bot_active: b.bot_active })
})

// El cliente edita la identidad básica de su negocio (NO credenciales, NO plan — eso lo controla el admin)
app.put('/api/client/business', authClient, async (req, res) => {
  const allowed = ['name', 'slogan', 'description', 'hours', 'address', 'phone', 'social', 'payment_methods']
  const data = {}
  for (const k of allowed) if (k in req.body) data[k] = req.body[k]
  try {
    await db.updateBusiness(req.user.businessId, data)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/client/products',      authClient, async (req, res) => res.json(await db.getProducts(req.user.businessId)))
app.get('/api/client/conversations', authClient, requirePermission('conversaciones'), async (req, res) => res.json(await db.getConversations(req.user.businessId)))

// ── SESIONES / MODO MANUAL ────────────────────────────────
app.get('/api/client/sessions', authClient, requirePermission('conversaciones'), async (req, res) => {
  try { res.json(await db.getSessions(req.user.businessId)) }
  catch { res.json([]) }
})

app.put('/api/client/sessions/:phone/mode', authClient, requirePermission('conversaciones'), async (req, res) => {
  const { manual } = req.body
  await db.upsertSession(req.user.businessId, req.params.phone, { manual_mode: !!manual, unread_owner: false })
  res.json({ ok: true })
})

// Cerrar venta: devuelve la conversación al bot Y marca un corte de historial.
// El próximo mensaje del cliente se trata como conversación nueva (no retoma el pedido).
app.put('/api/client/sessions/:phone/close', authClient, requirePermission('conversaciones'), async (req, res) => {
  const phone = decodeURIComponent(req.params.phone)
  const now = new Date().toISOString()
  let { error } = await db.upsertSession(req.user.businessId, phone, { manual_mode: false, unread_owner: false, closed_sale_at: now })
  // Si la columna closed_sale_at aún no existe (migración sin correr), al menos devuelve al bot
  if (error && /closed_sale_at/.test(error.message || '')) {
    ;({ error } = await db.upsertSession(req.user.businessId, phone, { manual_mode: false, unread_owner: false }))
  }
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// Marcar un chat manual como atendido (calla la alarma de forma persistente)
app.put('/api/client/sessions/:phone/read', authClient, requirePermission('conversaciones'), async (req, res) => {
  await db.upsertSession(req.user.businessId, decodeURIComponent(req.params.phone), { unread_owner: false })
  res.json({ ok: true })
})

// Guardar/editar el nombre del contacto (para identificar quién escribe)
app.put('/api/client/sessions/:phone/name', authClient, requirePermission('conversaciones'), async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60)
  await db.upsertSession(req.user.businessId, decodeURIComponent(req.params.phone), { contact_name: name || null })
  res.json({ ok: true })
})

// Envía un mensaje al cliente por su canal (Telegram o WhatsApp)
async function sendToContact(biz, phone, message) {
  if (phone.startsWith('tg_')) {
    const chatId = phone.replace('tg_', '')
    const tgBot = require('./telegram').getBotInstance()
    if (tgBot) await tgBot.telegram.sendMessage(chatId, message)
  } else {
    const { sendWhatsAppMessage } = require('./bot')
    await sendWhatsAppMessage(biz, phone, message)
  }
}

app.post('/api/client/sessions/:phone/send', authClient, requirePermission('conversaciones'), async (req, res) => {
  const bizId = req.user.businessId
  const phone = decodeURIComponent(req.params.phone)
  const { message } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' })
  try {
    const biz = await db.getBusinessById(bizId)
    await db.saveMessage(bizId, phone, 'owner', message)
    await sendToContact(biz, phone, message)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/client/policies',      authClient, requireOwner, async (req, res) => res.json(await db.getPolicies(req.user.businessId) || {}))
app.put('/api/client/policies',      authClient, requireOwner, async (req, res) => { await db.upsertPolicies(req.user.businessId, req.body); res.json({ ok: true }) })
app.put('/api/client/bot-prompt',    authClient, requireOwner, async (req, res) => { await db.upsertPolicies(req.user.businessId, { bot_prompt: req.body.bot_prompt }); res.json({ ok: true }) })

// ── HORARIOS ──────────────────────────────────────────────
app.get('/api/client/schedule',  authClient, requirePermission('citas'), async (req, res) => res.json(await db.getSchedule(req.user.businessId)))
app.put('/api/client/schedule',  authClient, requirePermission('citas'), async (req, res) => { await db.upsertSchedule(req.user.businessId, req.body.days); res.json({ ok: true }) })

// ── RESERVAS ──────────────────────────────────────────────
app.get('/api/client/bookings',  authClient, requirePermission('citas'), async (req, res) => res.json(await db.getBookings(req.user.businessId, req.query.from, req.query.to)))
app.put('/api/client/bookings/:id/status', authClient, requirePermission('citas'), async (req, res) => {
  const { status } = req.body
  if (!['pending', 'confirmed', 'cancelled', 'no_show'].includes(status)) return res.status(400).json({ error: 'Estado inválido' })
  try {
    const booking = await db.getBookingById(req.params.id)
    // Aislamiento: la reserva debe pertenecer a ESTE negocio
    if (!booking || booking.business_id !== req.user.businessId) return res.status(404).json({ error: 'Reserva no encontrada' })
    await db.updateBookingStatus(req.user.businessId, req.params.id, status)

    // Notificar al cliente por su canal (no bloquea la respuesta si falla)
    if (booking && booking.contact_phone) {
      const biz = await db.getBusinessById(req.user.businessId)
      const fecha = booking.booking_date
      const hora  = (booking.booking_time || '').slice(0, 5)
      const svc   = booking.service ? ` de *${booking.service}*` : ''
      let msg = null
      if (status === 'confirmed') {
        msg = `✅ ¡Tu cita${svc} quedó *confirmada* para el ${fecha} a las ${hora}! Te esperamos en ${biz.name} 😊`
      } else if (status === 'cancelled') {
        msg = `⚠️ Lamentamos informarte que tu cita${svc} del ${fecha} a las ${hora} fue *cancelada*. Si deseas, podemos agendarte en otro horario disponible. Escríbenos cuándo te conviene 🙏`
      }
      if (msg) {
        sendToContact(biz, booking.contact_phone, msg)
          .then(() => db.saveMessage(biz.id, booking.contact_phone, 'owner', msg))
          .catch(e => console.error('❌ Notificación de reserva:', e.message))
      }
    }
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/client/products', authClient, requirePermission('catalogo'), async (req, res) => {
  const { name, price } = req.body
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio requeridos' })
  const { data, error } = await db.createProduct({ ...req.body, business_id: req.user.businessId, price: parseFloat(price), active: true })
  if (error) return res.status(500).json({ error: error.message })
  // Generar embedding en segundo plano (RAG) — no bloquea la respuesta
  bot.indexProduct(data).catch(() => {})
  res.status(201).json(data)
})

app.put('/api/client/products/:id', authClient, requirePermission('catalogo'), async (req, res) => {
  await db.updateProduct(req.user.businessId, req.params.id, req.body)
  // Re-generar embedding tras editar
  db.getProductById(req.params.id).then(p => p && bot.indexProduct(p)).catch(() => {})
  res.json({ ok: true })
})
app.delete('/api/client/products/:id', authClient, requirePermission('catalogo'), async (req, res) => { await db.deleteProduct(req.user.businessId, req.params.id); res.json({ ok: true }) })

// ── VENTAS (registro manual) Y PEDIDOS PENDIENTES ─────────
// Prellenado del formulario: catálogo + lo que el bot ya cotizó en la conversación.
app.get('/api/client/sessions/:phone/quote', authClient, requirePermission('ventas'), async (req, res) => {
  const bizId = req.user.businessId
  const phone = decodeURIComponent(req.params.phone)
  try {
    const [products, history, session] = await Promise.all([
      db.getProducts(bizId),
      db.getContactHistory(bizId, phone, 30),
      db.getSession(bizId, phone)
    ])
    const text = history.map(h => h.content || '').join(' ').toLowerCase()
    const suggested = products
      .filter(p => p.name && text.includes(p.name.toLowerCase()))
      .map(p => ({ product_id: p.id, product_name: p.name, unit_price: Number(p.price_sale || p.price || 0), quantity: 1 }))
    res.json({
      contact_name: session?.contact_name || '',
      products: products.map(p => ({ id: p.id, name: p.name, price: Number(p.price_sale || p.price || 0) })),
      suggested
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Registrar "Venta realizada"
app.post('/api/client/sales', authClient, requirePermission('ventas'), async (req, res) => {
  const bizId = req.user.businessId
  const { contact_phone, contact_name, items } = req.body
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'La venta necesita al menos un ítem' })
  try {
    const norm = items.map(i => {
      const qty = parseInt(i.quantity) || 1
      const price = parseFloat(i.unit_price) || 0
      return { product_id: i.product_id || null, product_name: (i.product_name || 'Producto').trim(), quantity: qty, unit_price: price, line_total: +(qty * price).toFixed(2) }
    })
    const total = +norm.reduce((s, i) => s + i.line_total, 0).toFixed(2)
    const { data: sale, error } = await db.createSale({ business_id: bizId, contact_phone: contact_phone || null, contact_name: contact_name || null, total, status: 'completada', source: 'manual', created_by: req.user.userId || null })
    if (error) return res.status(500).json({ error: error.message })
    await db.addSaleItems(norm.map(i => ({ ...i, sale_id: sale.id, business_id: bizId })))
    // Al registrar la venta, la conversación deja de figurar como pendiente
    if (contact_phone) await db.upsertSession(bizId, contact_phone, { unread_owner: false })
    res.status(201).json({ ...sale, items: norm })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Anular venta (revierte el registro y el conteo)
app.post('/api/client/sales/:id/void', authClient, requirePermission('ventas'), async (req, res) => {
  try { await db.voidSale(req.user.businessId, req.params.id); res.json({ ok: true }) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Ventas registradas de un contacto (para mostrarlas y poder anularlas)
app.get('/api/client/sales', authClient, requirePermission('ventas'), async (req, res) => {
  const phone = req.query.phone ? decodeURIComponent(req.query.phone) : null
  if (!phone) return res.json([])
  res.json(await db.getSalesByContact(req.user.businessId, phone))
})

// Pedidos / cotizaciones sin cerrar
app.get('/api/client/pending-orders', authClient, requirePermission('reportes'), async (req, res) =>
  res.json(await db.getPendingOrders(req.user.businessId)))

// Datos de los 7 reportes para el panel del dueño (JSON) — filtrado por business_id (JWT)
app.get('/api/client/reports', authClient, requirePermission('reportes'), async (req, res) => {
  const period = ['hoy', 'semana', 'mes'].includes(req.query.period) ? req.query.period : 'mes'
  try { res.json(await reports.getAllReports(req.user.businessId, period)) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Directorio de clientes (solo lectura) — para la sección "Clientes" del panel
app.get('/api/client/customers', authClient, requirePermission('reportes'), async (req, res) => {
  try { res.json(await reports.getCustomerDirectory(req.user.businessId)) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Alertas del negocio (banner del panel) — vigila condiciones con los datos existentes
app.get('/api/client/alerts', authClient, requirePermission('reportes'), async (req, res) => {
  try { res.json(await reports.computeAlerts(req.user.businessId)) }
  catch(e) { console.error('❌ alerts:', e.message); res.status(500).json({ error: 'No se pudieron cargar las alertas' }) }
})

// Dashboard (resumen + datos para gráficos) — pantalla de inicio del panel
app.get('/api/client/dashboard', authClient, requirePermission('reportes'), async (req, res) => {
  const period = ['hoy', 'semana', 'mes'].includes(req.query.period) ? req.query.period : 'mes'
  try { res.json(await reports.getDashboard(req.user.businessId, period)) }
  catch(e) { console.error('❌ dashboard:', e.message); res.status(500).json({ error: 'No se pudo cargar el dashboard' }) }
})

// Onboarding: estado de configuración del negocio (guía de puesta en marcha)
app.get('/api/client/onboarding', authClient, async (req, res) => {
  try {
    const bizId = req.user.businessId
    const [nProds, pol, schedule, biz] = await Promise.all([
      db.countProducts(bizId), db.getPolicies(bizId), db.getSchedule(bizId), db.getBusinessById(bizId)
    ])
    const has = v => !!(v && String(v).trim())
    const polOk = pol && (has(pol.shipping) || has(pol.returns) || has(pol.discounts) || has(pol.bot_instructions))
    const horarioOk = (Array.isArray(schedule) && schedule.some(s => s.is_active)) || has(biz?.hours)
    const steps = [
      { key: 'productos',  label: 'Sube tus productos o servicios',              done: nProds > 0,          hint: nProds > 0 ? `${nProds} cargado(s)` : '', page: 'products' },
      { key: 'prompt',     label: 'Personaliza el prompt del bot',               done: has(pol?.bot_prompt), page: 'botprompt' },
      { key: 'politicas',  label: 'Completa las políticas (envíos, garantía…)',  done: !!polOk,             page: 'policies' },
      { key: 'horario',    label: 'Define tu horario de atención',               done: !!horarioOk,         page: 'schedule' },
      { key: 'whatsapp',   label: 'Conecta tu WhatsApp',                         done: has(biz?.whatsapp_number), hint: has(biz?.whatsapp_number) ? biz.whatsapp_number : 'lo configura el administrador', page: null }
    ]
    const done = steps.filter(s => s.done).length
    res.json({ steps, done, total: steps.length, pct: Math.round(done / steps.length * 100) })
  } catch(e) { console.error('❌ onboarding:', e.message); res.status(500).json({ error: 'No se pudo cargar el onboarding' }) }
})

// ── USUARIOS / EMPLEADOS (solo el DUEÑO) ──────────────────
const VALID_PERMS = ['catalogo', 'conversaciones', 'citas', 'reportes', 'ventas']
app.get('/api/client/users', authClient, requireOwner, async (req, res) =>
  res.json(await db.getClientUsers(req.user.businessId)))

app.post('/api/client/users', authClient, requireOwner, async (req, res) => {
  const { email, password, name, permissions } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña requeridos' })
  const perms = (Array.isArray(permissions) ? permissions : []).filter(p => VALID_PERMS.includes(p))
  try {
    const hash = await bcrypt.hash(password, 10)
    const { data, error } = await db.createClientUser({ business_id: req.user.businessId, email: email.trim(), password_hash: hash, name: name || null, role: 'employee', permissions: perms })
    if (error) return res.status(500).json({ error: error.message })
    res.status(201).json({ id: data.id })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.put('/api/client/users/:id', authClient, requireOwner, async (req, res) => {
  const { email, password, name, permissions } = req.body
  const fields = {}
  if (email) fields.email = email.trim()
  if (name !== undefined) fields.name = name
  if (Array.isArray(permissions)) fields.permissions = permissions.filter(p => VALID_PERMS.includes(p))
  if (password) fields.password_hash = await bcrypt.hash(password, 10)
  try {
    if (Object.keys(fields).length) await db.updateClientUserById(req.user.businessId, req.params.id, fields)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/client/users/:id', authClient, requireOwner, async (req, res) => {
  try { await db.deleteClientUserById(req.user.businessId, req.params.id); res.json({ ok: true }) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Reindexar (generar embeddings) de los productos que aún no tienen — para catálogos existentes
app.post('/api/client/reindex', authClient, requirePermission('catalogo'), async (req, res) => {
  try {
    const pending = await db.getProductsWithoutEmbedding(req.user.businessId)
    res.json({ ok: true, pending: pending.length, message: pending.length ? `Indexando ${pending.length} productos en segundo plano…` : 'Todos los productos ya están indexados ✓' })
    // Procesar en segundo plano, de a uno (evita rate limits)
    for (const p of pending) { await bot.indexProduct(p) }
    if (pending.length) console.log(`✅ [reindex] ${pending.length} productos indexados`)
  } catch(e) { console.error('❌ reindex:', e.message) }
})

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

app.post('/webhook', webhookLimiter, async (req, res) => {
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
app.post('/webhook/kapso', webhookLimiter, async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.sendStatus(401)
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
app.post('/webhook/ycloud', webhookLimiter, async (req, res) => {
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
      const key = (ycloud_api_key || process.env.YCLOUD_API_KEY || '').trim()
      if (!key) return { ok: false, info: 'Falta YCloud API Key' }
      const r = await axios.get('https://api.ycloud.com/v2/whatsapp/phoneNumbers', {
        headers: { 'X-API-Key': key, 'Accept': 'application/json' },
        params: { page: 1, limit: 10 }, timeout: 10000
      })
      const nums = r.data.items || r.data.data || []
      const digits = (ycloud_number || '').replace(/\D/g, '')
      const tail = digits.slice(-9)
      const found = tail.length >= 8
        ? nums.find(n => (n.phoneNumber || '').replace(/\D/g,'').slice(-9) === tail)
        : null
      if (!nums.length) return { ok: false, info: 'API Key válida pero NO hay números de WhatsApp en tu cuenta YCloud. Vincula tu número primero.' }
      if (digits && !found) {
        const lista = nums.map(n => n.phoneNumber).join(', ')
        return { ok: false, info: `⚠️ La API Key sirve, pero el número ${ycloud_number} NO coincide con los de tu cuenta. Números disponibles: ${lista}` }
      }
      const info = found
        ? `✅ Conectado: ${found.phoneNumber} — ${found.displayName || found.verifiedName || 'activo'}`
        : `✅ API Key válida — ${nums.length} número(s) en tu cuenta. Ingresa el número para confirmar cuál usar.`
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
    const status = e.response?.status
    const msg = e.response?.data?.error?.message
           || e.response?.data?.message
           || e.response?.data?.description
           || e.message
    const hint = status === 401 || status === 403 ? ' (API Key inválida o sin permisos)'
               : status === 404 ? ' (endpoint no encontrado)'
               : ''
    return { ok: false, info: (status ? `[HTTP ${status}] ` : '') + msg + hint }
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
// ══════════════════════════════════════════
// CONFIGURACIÓN DEL SERVIDOR
// ══════════════════════════════════════════

app.get('/api/admin/server-settings', authAdmin, async (_, res) => {
  const all = await srvSettings.getAll()
  // Enmascarar keys para no exponer valores completos
  const masked = {}
  for (const [k, v] of Object.entries(all)) {
    if (!v) { masked[k] = ''; continue }
    if (k.includes('key') || k.includes('token')) {
      masked[k] = v.length > 8 ? v.slice(0, 6) + '••••••' + v.slice(-4) : '••••••'
    } else {
      masked[k] = v
    }
  }
  res.json(masked)
})

app.post('/api/admin/server-settings', authAdmin, async (req, res) => {
  try {
    await srvSettings.setMany(req.body)
    res.json({ ok: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Verificar que las keys de IA funcionan
app.post('/api/admin/server-settings/verify-ai', authAdmin, async (req, res) => {
  const { provider, anthropic_api_key, openai_api_key, gemini_api_key, groq_api_key } = req.body
  try {
    if (provider === 'groq') {
      const key = groq_api_key || await srvSettings.get('groq_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta Groq API Key' })
      const groq = new (require('openai'))({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' })
      const r = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] })
      return res.json({ ok: true, info: `✅ Groq activo — ${r.model || 'llama-3.3-70b'}` })
    }
    if (provider === 'gemini') {
      const key = gemini_api_key || await srvSettings.get('gemini_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta Gemini API Key' })
      try {
        const r = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
          { contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 5 } },
          { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        )
        return res.json({ ok: !!r.data.candidates, info: r.data.candidates ? '✅ Gemini 2.0 Flash activo y conectado' : 'Respuesta inesperada' })
      } catch(ge) {
        // Si el modelo no existe (404), listar los modelos disponibles de la key
        if (ge.response?.status === 404) {
          try {
            const list = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { timeout: 10000 })
            const flash = (list.data.models || [])
              .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(m.name))
              .map(m => m.name.replace('models/', ''))
            return res.json({ ok: false, info: `Modelo no disponible. Modelos 'flash' que SÍ tienes: ${flash.join(', ') || 'ninguno'}` })
          } catch(le) { /* cae al error general */ }
        }
        throw ge
      }
    }
    if (provider === 'openai') {
      const key = openai_api_key || await srvSettings.get('openai_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta OpenAI API Key' })
      const openai = new (require('openai'))({ apiKey: key })
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }]
      })
      return res.json({ ok: true, info: `GPT-4o Mini — ${r.model}` })
    }
    // Claude
    const key = anthropic_api_key || await srvSettings.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY
    if (!key) return res.json({ ok: false, info: 'Falta Anthropic API Key' })
    const claude = new Anthropic({ apiKey: key })
    const r = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 5,
      messages: [{ role: 'user', content: 'ping' }]
    })
    return res.json({ ok: true, info: `Claude Sonnet activo — ${r.model}` })
  } catch(e) {
    // Mostrar el detalle real (ej: API key inválida, API no habilitada)
    const detail = e.response?.data?.error?.message || e.message || 'Error de conexión'
    const status = e.response?.status ? `[HTTP ${e.response.status}] ` : ''
    res.json({ ok: false, info: (status + detail).slice(0, 160) })
  }
})

// TÚNEL PÚBLICO (cloudflared / localtunnel)
// ══════════════════════════════════════════
app.get('/api/admin/tunnel', authAdmin, (_, res) => {
  // Secreto de webhooks (solo se entrega al superadmin autenticado, es su propio secreto)
  const webhookSecret = process.env.WEBHOOK_SECRET || ''
  // En producción con BASE_URL, siempre está "activo"
  if (process.env.BASE_URL) {
    return res.json({ url: process.env.BASE_URL, active: true, provider: 'dominio propio', startedAt: null, webhookSecret })
  }
  res.json({ ...tunnel.getState(), webhookSecret })
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

    // Usa el mismo motor que el bot real (respeta provider OpenAI/Claude configurado)
    const raw = await bot.callAI(
      bot.buildPrompt(biz, products, policies, false, message),
      history, message, biz.ai_provider
    )

    const imgMatch = raw.match(/##IMG##(https?:\/\/[^\s#]+)##/)
    const hasHandoff = /##\s*handoff\s*##/i.test(raw)
    let reply = raw.replace(/##IMG##[^\s#]+##/g, '').replace(/##\s*handoff\s*##/gi, '').replace('##BOOKING##', '').trim()
    if (hasHandoff) reply = 'Permítame un momento por favor 🙏 enseguida un asesor de nuestro equipo continuará con usted para ayudarle mejor ✨'

    await db.saveMessage(biz.id, simFrom, 'assistant', reply)
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

// SUPABASE CONFIG — desactivado por seguridad.
// El frontend ya no accede directo a la BD; usa polling vía endpoints autenticados.
// Con RLS activo, exponer la key directa no aporta y amplía la superficie de ataque.
app.get('/api/admin/supabase-config',  authAdmin,  (_, res) => res.json({}))
app.get('/api/client/supabase-config', authClient, (_, res) => res.json({}))

// HEALTH
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }))

// ── LIVE RELOAD (solo en desarrollo) ─────────────────────
if (!process.env.BASE_URL) {
  const lrClients = new Set()

  app.get('/dev-reload', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.flushHeaders()
    res.write('data: connected\n\n')
    lrClients.add(res)
    req.on('close', () => lrClients.delete(res))
  })

  const notify = () => lrClients.forEach(c => c.write('data: reload\n\n'))
  const dirs   = [path.join(__dirname, '../admin'), path.join(__dirname, '../client')]
  dirs.forEach(d => fs.watch(d, { recursive: true }, (_, f) => { if (f?.endsWith('.html') || f?.endsWith('.js') || f?.endsWith('.css')) notify() }))
  console.log('♻️  Live-reload activo')
}

// ── IMÁGENES DE PRODUCTOS ─────────────────────────────────
// Convierte base64 almacenado en BD a imagen servida por URL real
app.get('/api/images/:productId', async (req, res) => {
  const product = await db.getProductById(req.params.productId)
  if (!product?.image_url) return res.status(404).send('No image')

  if (product.image_url.startsWith('data:')) {
    const [header, base64] = product.image_url.split(',')
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
    const buffer = Buffer.from(base64, 'base64')
    res.set('Content-Type', mimeType)
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(buffer)
  }

  res.redirect(product.image_url)
})

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
  checkEnv()
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

  // Auto-arrancar el túnel al iniciar (solo en local). Queda vivo toda la sesión del
  // servidor → recargar la pestaña NO lo apaga; solo cambia al reiniciar el servidor.
  if (!process.env.BASE_URL) {
    setTimeout(() => {
      tunnel.startTunnel(PORT)
        .then(s => console.log(`🌐 Túnel automático: ${s.url}`))
        .catch(e => console.log('⚠️  No se pudo auto-iniciar el túnel:', e.message))
    }, 2500)
  }
})
