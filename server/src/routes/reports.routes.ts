import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

type ReportPeriod = 'hoy' | 'semana' | 'mes'

const db = require('../db') as {
  getPendingOrders(businessId: string): Promise<unknown>
}
const reports = require('../services/reports') as {
  getAllReports(businessId: string, period: ReportPeriod): Promise<unknown>
  getCustomerDirectory(businessId: string): Promise<unknown>
  getInactiveContacts(businessId: string, days: number): Promise<unknown>
  computeAlerts(businessId: string): Promise<unknown>
  getDashboard(businessId: string, period: ReportPeriod): Promise<unknown>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}

const router = createRouter()
const reportPeriods: ReportPeriod[] = ['hoy', 'semana', 'mes']
const canViewReports = auth.requirePermission('reportes')

function parsePeriod(value: unknown): ReportPeriod {
  return typeof value === 'string' && reportPeriods.includes(value as ReportPeriod)
    ? value as ReportPeriod
    : 'mes'
}

router.get('/api/client/pending-orders', auth.authClient, canViewReports, async (req, res) => {
  try {
    res.json(await db.getPendingOrders(getClientBusinessId(req)))
  } catch (error) {
    console.error('❌ pedidos pendientes:', (error as Error).message)
    res.status(500).json({ error: 'No se pudieron cargar los pedidos pendientes' })
  }
})

router.get('/api/client/reports', auth.authClient, canViewReports, async (req, res) => {
  const period = parsePeriod(req.query.period)
  try {
    res.json(await reports.getAllReports(getClientBusinessId(req), period))
  } catch (error) {
    console.error('❌ reportes:', (error as Error).message)
    res.status(500).json({ error: 'No se pudieron cargar los reportes' })
  }
})

router.get('/api/client/customers', auth.authClient, canViewReports, async (req, res) => {
  try {
    res.json(await reports.getCustomerDirectory(getClientBusinessId(req)))
  } catch (error) {
    console.error('❌ directorio de clientes:', (error as Error).message)
    res.status(500).json({ error: 'No se pudo cargar el directorio de clientes' })
  }
})

router.get('/api/client/inactive-contacts', auth.authClient, canViewReports, async (req, res) => {
  const days = Math.max(1, Number.parseInt(String(req.query.days)) || 15)
  try {
    res.json(await reports.getInactiveContacts(getClientBusinessId(req), days))
  } catch (error) {
    console.error('❌ contactos inactivos:', (error as Error).message)
    res.status(500).json({ error: 'No se pudieron cargar los contactos inactivos' })
  }
})

router.get('/api/client/alerts', auth.authClient, canViewReports, async (req, res) => {
  try {
    res.json(await reports.computeAlerts(getClientBusinessId(req)))
  } catch (error) {
    console.error('❌ alerts:', (error as Error).message)
    res.status(500).json({ error: 'No se pudieron cargar las alertas' })
  }
})

router.get('/api/client/dashboard', auth.authClient, canViewReports, async (req, res) => {
  const period = parsePeriod(req.query.period)
  try {
    res.json(await reports.getDashboard(getClientBusinessId(req), period))
  } catch (error) {
    console.error('❌ dashboard:', (error as Error).message)
    res.status(500).json({ error: 'No se pudo cargar el dashboard' })
  }
})

export = router
