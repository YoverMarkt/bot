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

interface BillingCreateData extends Record<string, unknown> {
  business_id: string
  amount: number
  status: BillingStatus
  period_start: string | null
  period_end: string | null
  notes: string | null
  paid_at: string | null
}

const billingStatuses = new Set<BillingStatus>(['pending', 'paid', 'overdue'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const maximumNotesLength = 2_000

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isBillingStatus = (value: unknown): value is BillingStatus => (
  typeof value === 'string' && billingStatuses.has(value as BillingStatus)
)

const isValidIsoDate = (value: string): boolean => {
  if (!isoDatePattern.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const optionalIsoDate = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isValidIsoDate(value)) return undefined
  return value
}

const validationFailure = (res: Parameters<RequestHandler>[1], message: string) => (
  res.status(400).json({ error: message })
)

const db = require('../db') as {
  getBilling(): Promise<unknown[]>
  createBilling(data: Record<string, unknown>): Promise<DatabaseResult>
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

router.post('/api/admin/billing', auth.authAdmin, async (req, res) => {
  const body: unknown = req.body
  if (!isRecord(body)) return validationFailure(res, 'Datos de facturación inválidos')

  const businessId = typeof body.business_id === 'string' ? body.business_id.trim() : ''
  if (!uuidPattern.test(businessId)) {
    return validationFailure(res, 'Negocio inválido')
  }

  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount)) {
    return validationFailure(res, 'Monto inválido')
  }
  const amountInCents = Math.round(body.amount * 100)
  if (
    amountInCents < 1
    || !Number.isSafeInteger(amountInCents)
    || Math.abs((body.amount * 100) - amountInCents) > 1e-7
  ) {
    return validationFailure(res, 'El monto debe ser positivo y tener máximo dos decimales')
  }

  const status = body.status === undefined ? 'pending' : body.status
  if (!isBillingStatus(status)) {
    return validationFailure(res, 'Estado de facturación inválido')
  }

  const periodStart = optionalIsoDate(body.period_start)
  const periodEnd = optionalIsoDate(body.period_end)
  if (periodStart === undefined || periodEnd === undefined) {
    return validationFailure(res, 'Las fechas deben usar el formato YYYY-MM-DD')
  }
  if (periodStart && periodEnd && periodStart > periodEnd) {
    return validationFailure(res, 'El inicio del período no puede ser posterior al fin')
  }

  let notes: string | null = null
  if (body.notes !== undefined && body.notes !== null && body.notes !== '') {
    if (typeof body.notes !== 'string' || body.notes.trim().length > maximumNotesLength) {
      return validationFailure(res, `Las notas no pueden superar ${maximumNotesLength} caracteres`)
    }
    notes = body.notes.trim() || null
  }

  const billingData: BillingCreateData = {
    business_id: businessId,
    amount: amountInCents / 100,
    status,
    period_start: periodStart,
    period_end: periodEnd,
    notes,
    paid_at: status === 'paid' ? new Date().toISOString() : null,
  }
  const { data, error } = await db.createBilling(billingData)
  if (error) {
    console.error('❌ crear facturación:', error.message || 'Error desconocido')
    return res.status(500).json({ error: 'No se pudo crear la facturación' })
  }
  res.json(data)
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
