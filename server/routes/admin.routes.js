// ── RUTAS: PANEL DEL SUPERADMIN (dueño del SaaS) ─────────────────────
// Negocios (CRUD + suspensión + facturación), verificación de proveedores,
// configuración del servidor (keys IA/Cloudinary con enmascarado), túnel y
// simulador de bot. Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN
// cambios de comportamiento.
const express   = require('express')
const bcrypt    = require('bcryptjs')
const axios     = require('axios')
const Anthropic = require('@anthropic-ai/sdk')
const db          = require('../db')
const bot         = require('../bot')
const srvSettings = require('../settings')
const cloud       = require('../cloudinary')
const tunnel      = require('../tunnel')
const { authAdmin } = require('../middleware/auth')

const router = express.Router()

// ══════════════════════════════════════════
// ADMIN — STATS Y CLIENTES
// ══════════════════════════════════════════
router.get('/api/admin/stats', authAdmin, async (req, res) => {
  res.json(await db.getAdminStats())
})

router.get('/api/admin/clients', authAdmin, async (req, res) => {
  res.json(await db.getAllBusinesses())
})

router.get('/api/admin/clients/:id', authAdmin, async (req, res) => {
  const biz = await db.getBusinessById(req.params.id)
  if (!biz) return res.status(404).json({ error: 'No encontrado' })
  // Adjuntar el correo real del usuario de ESTE negocio (para que el panel lo muestre al editar)
  const user = await db.getClientUserByBusiness(req.params.id)
  res.json({ ...biz, client_email: user?.email || '' })
})

router.post('/api/admin/clients', authAdmin, async (req, res) => {
  const {
    name, type, whatsapp_number, whatsapp_provider,
    kapso_api_key, kapso_number_id, kapso_verify_token,
    ycloud_api_key, ycloud_number,
    meta_token, meta_phone_id, meta_verify_token,
    telegram_bot_token, retell_agent_id, ai_provider, takes_bookings, takes_orders,
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
      takes_orders:      takes_orders !== false,   // default: el bot vende; false = solo informativo
      ai_provider:       ai_provider || null,
      owner_phone:       owner_phone || null,
      plan: plan || 'basic',
      plan_expires_at: plan_expires_at || null,
      active: true, bot_active: true, suspended: false, notes
    }
    let { data: biz, error } = await db.createBusiness(bizPayload)
    // Si takes_bookings/takes_orders aún no existen (migración sin correr), reintenta sin ellas
    if (error && /(takes_bookings|takes_orders)/.test(error.message || '')) {
      const { takes_bookings: _omit, takes_orders: _omit2, ...fallback } = bizPayload
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

router.put('/api/admin/clients/:id', authAdmin, async (req, res) => {
  // Solo columnas que existen en la tabla businesses (evita que un campo inválido
  // como monthly_rate haga fallar TODO el update en silencio)
  const ALLOWED = ['name','type','description','hours','address','phone','social','payment_methods',
    'whatsapp_number','whatsapp_provider','plan','plan_expires_at','active','bot_active','suspended',
    'notes','slogan','monthly_rate','owner_phone','ycloud_api_key','ycloud_number','kapso_api_key','kapso_number_id','kapso_verify_token',
    'meta_token','meta_phone_id','meta_verify_token','telegram_bot_token','retell_agent_id','ai_provider','takes_bookings','takes_orders']
  const bizData = {}
  for (const k of ALLOWED) if (k in req.body) bizData[k] = req.body[k]
  if ('monthly_rate' in bizData) bizData.monthly_rate = parseFloat(bizData.monthly_rate) || null
  try {
    if (Object.keys(bizData).length) {
      let { error } = await db.updateBusiness(req.params.id, bizData)
      // Reintento si una columna aún no existe en la BD (migración sin correr)
      if (error && /(monthly_rate|takes_bookings|takes_orders)/.test(error.message || '')) {
        delete bizData.monthly_rate
        delete bizData.takes_bookings
        delete bizData.takes_orders
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

router.delete('/api/admin/clients/:id', authAdmin, async (req, res) => {
  try {
    await db.deleteBusiness(req.params.id)
    console.log(`🗑️ Cliente eliminado: ${req.params.id}`)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/api/admin/clients/:id/generate-billing', authAdmin, async (req, res) => {
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

router.post('/api/admin/clients/:id/suspend', authAdmin, async (req, res) => {
  await db.suspendBusiness(req.params.id, req.body.reason || 'Pago pendiente')
  console.log(`⛔ Cliente suspendido: ${req.params.id}`)
  res.json({ ok: true })
})

router.post('/api/admin/clients/:id/reactivate', authAdmin, async (req, res) => {
  await db.reactivateBusiness(req.params.id)
  console.log(`✅ Cliente reactivado: ${req.params.id}`)
  res.json({ ok: true })
})

router.post('/api/admin/clients/:id/create-user', authAdmin, async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' })
  const hash = await bcrypt.hash(password, 10)
  const { data, error } = await db.createClientUser({ business_id: req.params.id, email, password_hash: hash })
  error ? res.status(500).json({ error: error.message }) : res.json({ ok: true })
})

router.get('/api/admin/clients/:id/products',      authAdmin, async (req, res) => res.json(await db.getProducts(req.params.id)))
router.get('/api/admin/clients/:id/conversations', authAdmin, async (req, res) => res.json(await db.getConversations(req.params.id)))
router.get('/api/admin/clients/:id/policies',      authAdmin, async (req, res) => res.json(await db.getPolicies(req.params.id) || {}))
router.put('/api/admin/clients/:id/policies',      authAdmin, async (req, res) => { await db.upsertPolicies(req.params.id, req.body); res.json({ ok: true }) })

// ══════════════════════════════════════════
// ADMIN — FACTURACIÓN
// ══════════════════════════════════════════
router.get('/api/admin/billing', authAdmin, async (req, res) => res.json(await db.getBilling()))

router.post('/api/admin/billing', authAdmin, async (req, res) => {
  const { data, error } = await db.createBilling(req.body)
  error ? res.status(500).json({ error: error.message }) : res.json(data)
})

router.put('/api/admin/billing/:id', authAdmin, async (req, res) => {
  await db.updateBillingStatus(req.params.id, req.body.status, req.body.paid_at)
  res.json({ ok: true })
})

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
router.post('/api/admin/verify-provider', authAdmin, async (req, res) => {
  res.json(await verifyProvider(req.body))
})

// Verificar desde la tabla (datos guardados en DB)
router.post('/api/admin/clients/:id/verify', authAdmin, async (req, res) => {
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
// CONFIGURACIÓN DEL SERVIDOR
// ══════════════════════════════════════════

router.get('/api/admin/server-settings', authAdmin, async (_, res) => {
  const all = await srvSettings.getAll()
  // Enmascarar keys para no exponer valores completos
  const masked = {}
  for (const [k, v] of Object.entries(all)) {
    if (!v) { masked[k] = ''; continue }
    if (k.includes('key') || k.includes('token') || k.includes('secret')) {
      masked[k] = v.length > 8 ? v.slice(0, 6) + '••••••' + v.slice(-4) : '••••••'
    } else {
      masked[k] = v
    }
  }
  res.json(masked)
})

router.post('/api/admin/server-settings', authAdmin, async (req, res) => {
  try {
    await srvSettings.setMany(req.body)
    res.json({ ok: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Verificar que las keys de IA funcionan
router.post('/api/admin/server-settings/verify-ai', authAdmin, async (req, res) => {
  const { provider, anthropic_api_key, openai_api_key, gemini_api_key, groq_api_key, deepseek_api_key } = req.body
  try {
    if (provider === 'groq') {
      const key = groq_api_key || await srvSettings.get('groq_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta Groq API Key' })
      const groq = new (require('openai'))({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' })
      const r = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] })
      return res.json({ ok: true, info: `✅ Groq activo — ${r.model || 'llama-3.3-70b'}` })
    }
    if (provider === 'deepseek') {
      const key = deepseek_api_key || await srvSettings.get('deepseek_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta DeepSeek API Key' })
      const deepseek = new (require('openai'))({ apiKey: key, baseURL: 'https://api.deepseek.com' })
      const r = await deepseek.chat.completions.create({ model: 'deepseek-chat', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] })
      return res.json({ ok: true, info: `✅ DeepSeek activo — ${r.model || 'deepseek-chat'}` })
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

// Verificar que las llaves de Cloudinary funcionan (ping)
router.post('/api/admin/server-settings/verify-cloudinary', authAdmin, async (req, res) => {
  const { cloudinary_cloud_name, cloudinary_api_key, cloudinary_api_secret } = req.body
  try {
    const r = await cloud.verify({
      cloud_name: cloudinary_cloud_name,
      api_key:    cloudinary_api_key,
      api_secret: cloudinary_api_secret
    })
    res.json(r)
  } catch(e) {
    const detail = e.error?.message || e.message || 'Error de conexión'
    const status = e.http_code ? `[HTTP ${e.http_code}] ` : ''
    res.json({ ok: false, info: (status + detail).slice(0, 160) })
  }
})

// ══════════════════════════════════════════
// TÚNEL PÚBLICO (cloudflared / localtunnel)
// ══════════════════════════════════════════
router.get('/api/admin/tunnel', authAdmin, (_, res) => {
  // Secreto de webhooks (solo se entrega al superadmin autenticado, es su propio secreto)
  const webhookSecret = process.env.WEBHOOK_SECRET || ''
  // En producción con BASE_URL, siempre está "activo"
  if (process.env.BASE_URL) {
    return res.json({ url: process.env.BASE_URL, active: true, provider: 'dominio propio', startedAt: null, webhookSecret })
  }
  res.json({ ...tunnel.getState(), webhookSecret })
})

router.post('/api/admin/tunnel/start', authAdmin, async (req, res) => {
  try {
    const state = await tunnel.startTunnel(process.env.PORT || 3000)
    res.json(state)
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/api/admin/tunnel/stop', authAdmin, (_, res) => {
  tunnel.stopTunnel()
  res.json({ ok: true })
})

// ══════════════════════════════════════════
// SIMULADOR DE BOT (sin WhatsApp real)
// ══════════════════════════════════════════
router.post('/api/admin/simulate', authAdmin, async (req, res) => {
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

router.delete('/api/admin/simulate/:bizId/history', authAdmin, async (req, res) => {
  await db.clearSimHistory(req.params.bizId)
  res.json({ ok: true })
})

// SUPABASE CONFIG — desactivado por seguridad.
// El frontend ya no accede directo a la BD; usa polling vía endpoints autenticados.
router.get('/api/admin/supabase-config', authAdmin, (_, res) => res.json({}))

module.exports = router
