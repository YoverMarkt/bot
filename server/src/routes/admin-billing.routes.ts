import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

interface DatabaseError {
  message?: string
}

interface DatabaseResult<T = unknown> {
  data?: T
  error?: DatabaseError | null
}

type BillingStatus = 'pending' | 'paid' | 'overdue'

const billingStatuses = new Set<BillingStatus>(['pending', 'paid', 'overdue'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isBillingStatus = (value: unknown): value is BillingStatus => (
  typeof value === 'string' && billingStatuses.has(value as BillingStatus)
)

const validationFailure = (res: Parameters<RequestHandler>[1], message: string) => (
  res.status(400).json({ error: message })
)

const db = require('../db') as {
  getBilling(): Promise<unknown[]>
  updateBillingStatus(
    billingId: string,
    status: unknown,
    paidAt: unknown,
  ): Promise<DatabaseResult>
}
const auth = require('../middleware/auth') as {
  authAdmin: RequestHandler
}

const router = createRouter()

router.get('/api/admin/billing', auth.authAdmin, async (_req, res) => {
  res.json(await db.getBilling())
})

router.put('/api/admin/billing/:id', auth.authAdmin, async (req, res) => {
  if (!uuidPattern.test(req.params.id)) {
    return validationFailure(res, 'Registro de facturación inválido')
  }

  const body: unknown = req.body
  if (!isRecord(body) || !isBillingStatus(body.status)) {
    return validationFailure(res, 'Estado de facturación inválido')
  }

  const status = body.status
  const paidAt = status === 'paid' ? new Date().toISOString() : null
  const { error } = await db.updateBillingStatus(req.params.id, status, paidAt)
  if (error) {
    console.error('❌ actualizar facturación:', error.message || 'Error desconocido')
    return res.status(500).json({ error: 'No se pudo actualizar la facturación' })
  }
  res.json({ ok: true })
})

export = router
