// ── RUTAS: REPORTES / DASHBOARD / CLIENTES (solo lectura) ────────────
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento. Aislamiento multi-tenant: business_id SIEMPRE del JWT.
const express = require('express')
const db      = require('../db')
const reports = require('../reports')
const { authClient, requirePermission } = require('../middleware/auth')

const router = express.Router()

// Pedidos / cotizaciones sin cerrar
router.get('/api/client/pending-orders', authClient, requirePermission('reportes'), async (req, res) =>
  res.json(await db.getPendingOrders(req.user.businessId)))

// Datos de los 7 reportes para el panel del dueño (JSON) — filtrado por business_id (JWT)
router.get('/api/client/reports', authClient, requirePermission('reportes'), async (req, res) => {
  const period = ['hoy', 'semana', 'mes'].includes(req.query.period) ? req.query.period : 'mes'
  try { res.json(await reports.getAllReports(req.user.businessId, period)) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Directorio de clientes (solo lectura) — para la sección "Clientes" del panel
router.get('/api/client/customers', authClient, requirePermission('reportes'), async (req, res) => {
  try { res.json(await reports.getCustomerDirectory(req.user.businessId)) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Clientes sin escribir hace tiempo (para reactivar) — solo lectura
router.get('/api/client/inactive-contacts', authClient, requirePermission('reportes'), async (req, res) => {
  const days = Math.max(1, parseInt(req.query.days) || 15)
  try { res.json(await reports.getInactiveContacts(req.user.businessId, days)) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// Alertas del negocio (banner del panel) — vigila condiciones con los datos existentes
router.get('/api/client/alerts', authClient, requirePermission('reportes'), async (req, res) => {
  try { res.json(await reports.computeAlerts(req.user.businessId)) }
  catch(e) { console.error('❌ alerts:', e.message); res.status(500).json({ error: 'No se pudieron cargar las alertas' }) }
})

// Dashboard (resumen + datos para gráficos) — pantalla de inicio del panel
router.get('/api/client/dashboard', authClient, requirePermission('reportes'), async (req, res) => {
  const period = ['hoy', 'semana', 'mes'].includes(req.query.period) ? req.query.period : 'mes'
  try { res.json(await reports.getDashboard(req.user.businessId, period)) }
  catch(e) { console.error('❌ dashboard:', e.message); res.status(500).json({ error: 'No se pudo cargar el dashboard' }) }
})

module.exports = router
