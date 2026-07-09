// ── RUTAS: PEDIDOS DEL BOT (núcleo de dinero) ────────────────────────
// Totales oficiales calculados server-side (money.js). El panel solo LEE;
// los pedidos los crea el bot en processMessage con la etiqueta ##PEDIDO##.
// Aislamiento multi-tenant: el business_id SIEMPRE sale del JWT.
const express = require('express')
const db      = require('../db')
const { authClient, requirePermission } = require('../middleware/auth')

const router = express.Router()

router.get('/api/client/orders', authClient, requirePermission('ventas'), async (req, res) =>
  res.json(await db.getOrders(req.user.businessId)))

module.exports = router
