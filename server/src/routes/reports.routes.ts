import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

type ReportPeriod = 'hoy' | 'semana' | 'mes'

interface ModuloDb {
  getPendingOrders(businessId: string): Promise<unknown>
  getPlatformMarkupSummary(from: string, to: string, businessId: string | null): Promise<unknown[]>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloReports {
  getAllReports(businessId: string, period: ReportPeriod): Promise<unknown>
  getCustomerDirectory(businessId: string): Promise<unknown>
  getInactiveContacts(businessId: string, days: number): Promise<unknown>
  computeAlerts(businessId: string): Promise<unknown>
  getDashboard(businessId: string, period: ReportPeriod): Promise<unknown>
}
const reports: ModuloReports = require('../services/reports') as typeof import('../services/reports')
interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

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

/**
 * Lo que el comercio lleva acumulado con la plataforma.
 *
 * Existe para que la primera factura no se discuta por WhatsApp: el dueño ve
 * de dónde sale el número antes de que le llegue.
 *
 * ⚠️ El `business_id` sale SIEMPRE del JWT (regla inviolable #1). No hay
 * parámetro de negocio, ni siquiera opcional: con uno, bastaría un id ajeno
 * en la barra de direcciones para leer la facturación de otro local.
 */
router.get('/api/client/platform-fees', auth.authClient, canViewReports, async (req, res) => {
  const hoy = new Date()
  const mes = (fecha: Date) => (
    `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}-01`
  )
  const desde = mes(hoy)
  const hasta = mes(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 1)))

  try {
    const filas = await db.getPlatformMarkupSummary(desde, hasta, getClientBusinessId(req))
    // Un mes sin ventas no es un error: es un mes sin ventas. Sin esto la
    // pantalla tendría que distinguir «no hay datos» de «falló la consulta».
    res.json(filas[0] || { pedidos: 0, bruto: 0, margen: 0, comercio: 0, desde, hasta })
  } catch (error) {
    console.error('❌ comisión acumulada:', (error as Error).message)
    res.status(500).json({ error: 'No se pudo cargar la comisión acumulada' })
  }
})

export = router
