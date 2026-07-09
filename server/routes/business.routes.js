// ── RUTAS: DATOS DEL NEGOCIO (panel del cliente) ─────────────────────
// Identidad del negocio, políticas/prompt, onboarding y equipo (empleados).
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento. Aislamiento multi-tenant: business_id SIEMPRE del JWT.
const express = require('express')
const bcrypt  = require('bcryptjs')
const db      = require('../db')
const { authClient, requireOwner } = require('../middleware/auth')

const router = express.Router()

router.get('/api/client/stats', authClient, async (req, res) => res.json(await db.getClientStats(req.user.businessId)))

router.get('/api/client/business', authClient, async (req, res) => {
  const b = await db.getBusinessById(req.user.businessId)
  // Solo datos públicos — SIN credenciales de WhatsApp
  res.json({ id: b.id, name: b.name, type: b.type, slogan: b.slogan, description: b.description, hours: b.hours, address: b.address, phone: b.phone, social: b.social, payment_methods: b.payment_methods, suspended: b.suspended, bot_active: b.bot_active })
})

// El cliente edita la identidad básica de su negocio (NO credenciales, NO plan — eso lo controla el admin)
router.put('/api/client/business', authClient, async (req, res) => {
  const allowed = ['name', 'slogan', 'description', 'hours', 'address', 'phone', 'social', 'payment_methods']
  const data = {}
  for (const k of allowed) if (k in req.body) data[k] = req.body[k]
  try {
    await db.updateBusiness(req.user.businessId, data)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── POLÍTICAS Y PROMPT DEL BOT (solo el dueño) ─────────────
router.get('/api/client/policies',   authClient, requireOwner, async (req, res) => res.json(await db.getPolicies(req.user.businessId) || {}))
router.put('/api/client/policies',   authClient, requireOwner, async (req, res) => { await db.upsertPolicies(req.user.businessId, req.body); res.json({ ok: true }) })
router.put('/api/client/bot-prompt', authClient, requireOwner, async (req, res) => { await db.upsertPolicies(req.user.businessId, { bot_prompt: req.body.bot_prompt }); res.json({ ok: true }) })

// Onboarding: estado de configuración del negocio (guía de puesta en marcha)
router.get('/api/client/onboarding', authClient, async (req, res) => {
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
router.get('/api/client/users', authClient, requireOwner, async (req, res) =>
  res.json(await db.getClientUsers(req.user.businessId)))

router.post('/api/client/users', authClient, requireOwner, async (req, res) => {
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

router.put('/api/client/users/:id', authClient, requireOwner, async (req, res) => {
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

router.delete('/api/client/users/:id', authClient, requireOwner, async (req, res) => {
  try { await db.deleteClientUserById(req.user.businessId, req.params.id); res.json({ ok: true }) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// SUPABASE CONFIG — desactivado por seguridad.
// El frontend ya no accede directo a la BD; usa polling vía endpoints autenticados.
router.get('/api/client/supabase-config', authClient, (_, res) => res.json({}))

module.exports = router
