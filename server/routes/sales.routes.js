// ── RUTAS: VENTAS (registro manual desde el panel) ───────────────────
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento. Aislamiento multi-tenant: business_id SIEMPRE del JWT.
const express = require('express')
const db      = require('../db')
const { authClient, requirePermission } = require('../middleware/auth')

const router = express.Router()

// Prellenado del formulario: catálogo + lo que el bot ya cotizó en la conversación.
router.get('/api/client/sessions/:phone/quote', authClient, requirePermission('ventas'), async (req, res) => {
  const bizId = req.user.businessId
  const phone = decodeURIComponent(req.params.phone)
  try {
    const [products, session, orders] = await Promise.all([
      db.getProducts(bizId),
      db.getSession(bizId, phone),
      db.getOrders(bizId, 100)
    ])
    // Solo el PEDIDO FINAL confirmado por el bot (núcleo de dinero).
    // Si el cliente solo preguntó y no cerró pedido, NO se sugiere nada:
    // el dueño arma la venta a mano (decisión del usuario 2026-07-10).
    const lastOrder = (orders || []).find(o =>
      o.contact_phone === phone && ['pendiente', 'confirmado'].includes(o.status))
    const suggested = (lastOrder?.order_items || []).map(i => ({
      product_id: i.product_id,
      product_name: i.product_name,
      unit_price: Number(i.unit_price) || 0,
      quantity: parseInt(i.quantity) || 1
    }))
    res.json({
      contact_name: session?.contact_name || '',
      products: products.map(p => ({ id: p.id, name: p.name, price: Number(p.price_sale || p.price || 0) })),
      suggested
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Registrar "Venta realizada"
router.post('/api/client/sales', authClient, requirePermission('ventas'), async (req, res) => {
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
router.post('/api/client/sales/:id/void', authClient, requirePermission('ventas'), async (req, res) => {
  try { await db.voidSale(req.user.businessId, req.params.id); res.json({ ok: true }) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Ventas registradas de un contacto (para mostrarlas y poder anularlas)
router.get('/api/client/sales', authClient, requirePermission('ventas'), async (req, res) => {
  const phone = req.query.phone ? decodeURIComponent(req.query.phone) : null
  if (!phone) return res.json([])
  res.json(await db.getSalesByContact(req.user.businessId, phone))
})

module.exports = router
