import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

interface ModuloAuth {
  authAdmin: RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
interface ModuloDb {
  getAdminMonthlyUsage(month?: string | null): Promise<unknown[]>
}
const db: ModuloDb = require('../db') as typeof import('../db')

const router = createRouter()
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

router.get('/api/admin/usage', auth.authAdmin, async (req, res) => {
  const rawMonth = typeof req.query.month === 'string'
    ? req.query.month.trim()
    : ''
  if (rawMonth && !MONTH_PATTERN.test(rawMonth)) {
    return res.status(400).json({ error: 'El mes debe usar el formato YYYY-MM' })
  }
  res.json(await db.getAdminMonthlyUsage(rawMonth ? `${rawMonth}-01` : null))
})

export = router
