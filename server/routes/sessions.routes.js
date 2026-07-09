// ── RUTAS: CONVERSACIONES / SESIONES / ETIQUETAS ─────────────────────
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento. Aislamiento multi-tenant: business_id SIEMPRE del JWT.
const express = require('express')
const db      = require('../db')
const { sendToContact } = require('../services/notify')
const { authClient, requirePermission } = require('../middleware/auth')

const router = express.Router()

router.get('/api/client/conversations', authClient, requirePermission('conversaciones'), async (req, res) => res.json(await db.getConversations(req.user.businessId)))

// ── SESIONES / MODO MANUAL ────────────────────────────────
router.get('/api/client/sessions', authClient, requirePermission('conversaciones'), async (req, res) => {
  try { res.json(await db.getSessions(req.user.businessId)) }
  catch { res.json([]) }
})

router.put('/api/client/sessions/:phone/mode', authClient, requirePermission('conversaciones'), async (req, res) => {
  const { manual } = req.body
  await db.upsertSession(req.user.businessId, req.params.phone, { manual_mode: !!manual, unread_owner: false })
  res.json({ ok: true })
})

// Cerrar venta: devuelve la conversación al bot Y marca un corte de historial.
// El próximo mensaje del cliente se trata como conversación nueva (no retoma el pedido).
router.put('/api/client/sessions/:phone/close', authClient, requirePermission('conversaciones'), async (req, res) => {
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
router.put('/api/client/sessions/:phone/read', authClient, requirePermission('conversaciones'), async (req, res) => {
  await db.upsertSession(req.user.businessId, decodeURIComponent(req.params.phone), { unread_owner: false })
  res.json({ ok: true })
})

// Guardar/editar el nombre del contacto (para identificar quién escribe)
router.put('/api/client/sessions/:phone/name', authClient, requirePermission('conversaciones'), async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60)
  await db.upsertSession(req.user.businessId, decodeURIComponent(req.params.phone), { contact_name: name || null })
  res.json({ ok: true })
})

// ── ETIQUETAS de conversación (el dueño crea las suyas) ────
router.get('/api/client/tags', authClient, requirePermission('conversaciones'), async (req, res) => {
  try { res.json(await db.getTags(req.user.businessId)) }
  catch(e) { res.status(500).json({ error: e.message }) }
})
router.post('/api/client/tags', authClient, requirePermission('conversaciones'), async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 30)
  if (!name) return res.status(400).json({ error: 'Nombre requerido' })
  try {
    const { data, error } = await db.createTag(req.user.businessId, { name, color: req.body.color })
    if (error) return res.status(500).json({ error: error.message })
    res.status(201).json(data)
  } catch(e) { res.status(500).json({ error: e.message }) }
})
router.put('/api/client/tags/:id', authClient, requirePermission('conversaciones'), async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 30)
  if (!name) return res.status(400).json({ error: 'Nombre requerido' })
  const { error } = await db.updateTag(req.user.businessId, req.params.id, { name, color: req.body.color })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})
router.delete('/api/client/tags/:id', authClient, requirePermission('conversaciones'), async (req, res) => {
  try { await db.deleteTag(req.user.businessId, req.params.id); res.json({ ok: true }) }
  catch(e) { res.status(500).json({ error: e.message }) }
})
// Asignar las etiquetas de una conversación (array de IDs)
router.put('/api/client/sessions/:phone/tags', authClient, requirePermission('conversaciones'), async (req, res) => {
  const phone = decodeURIComponent(req.params.phone)
  const tags = Array.isArray(req.body.tags) ? req.body.tags : []
  const { error } = await db.upsertSession(req.user.businessId, phone, { tags })
  if (error) return res.status(500).json({ error: /tags/.test(error.message || '') ? 'Falta correr la migración de etiquetas' : error.message })
  res.json({ ok: true })
})

// Responder al cliente desde el panel (por su canal: Telegram o WhatsApp)
router.post('/api/client/sessions/:phone/send', authClient, requirePermission('conversaciones'), async (req, res) => {
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

module.exports = router
