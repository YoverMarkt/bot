import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

const auth = require('../middleware/auth') as {
  authAdmin: RequestHandler
}
const db = require('../db') as {
  getAdminMonthlyUsage(month?: string | null): Promise<unknown[]>
}

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
