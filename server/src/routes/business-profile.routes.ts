import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

const editableBusinessFields = [
  'name',
  'slogan',
  'description',
  'hours',
  'address',
  'phone',
  'social',
  'payment_methods',
] as const

type EditableBusinessField = (typeof editableBusinessFields)[number]
type BusinessRecord = Record<string, unknown>
type DatabaseResult = { error?: { message?: string } | null }

const db = require('../db') as {
  getClientStats(businessId: string): Promise<unknown>
  getBusinessById(businessId: string): Promise<BusinessRecord>
  updateBusiness(
    businessId: string,
    data: Partial<Record<EditableBusinessField, unknown>>,
  ): Promise<DatabaseResult>
  getPolicies(businessId: string): Promise<unknown>
  upsertPolicies(businessId: string, data: unknown): Promise<DatabaseResult>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requireOwner: RequestHandler
}

const router = createRouter()

function assertDatabaseResult(result: DatabaseResult, operation: string): void {
  if (result?.error) throw new Error(`${operation}: ${result.error.message || 'Error desconocido'}`)
}

function databaseFailure(res: Parameters<RequestHandler>[1], operation: string, error: unknown) {
  console.error(`❌ ${operation}:`, error instanceof Error ? error.message : 'Error desconocido')
  return res.status(500).json({ error: `No se pudo ${operation}` })
}

router.get('/api/client/stats', auth.authClient, async (req, res) => {
  res.json(await db.getClientStats(getClientBusinessId(req)))
})

router.get('/api/client/business', auth.authClient, async (req, res) => {
  const business = await db.getBusinessById(getClientBusinessId(req))
  res.json({
    id: business.id,
    name: business.name,
    type: business.type,
    slogan: business.slogan,
    description: business.description,
    hours: business.hours,
    address: business.address,
    phone: business.phone,
    social: business.social,
    payment_methods: business.payment_methods,
    takes_bookings: business.takes_bookings === true,
    takes_orders: business.takes_orders !== false,
    lodging_enabled: business.lodging_enabled === true,
    suspended: business.suspended,
    bot_active: business.bot_active,
  })
})

router.put('/api/client/business', auth.authClient, auth.requireOwner, async (req, res) => {
  const data: Partial<Record<EditableBusinessField, unknown>> = {}
  for (const field of editableBusinessFields) {
    if (field in req.body) data[field] = req.body[field]
  }

  try {
    assertDatabaseResult(
      await db.updateBusiness(getClientBusinessId(req), data),
      'actualizar el negocio',
    )
    res.json({ ok: true })
  } catch (error) {
    databaseFailure(res, 'actualizar el negocio', error)
  }
})

router.get('/api/client/policies', auth.authClient, auth.requireOwner, async (req, res) => {
  res.json(await db.getPolicies(getClientBusinessId(req)) || {})
})

router.put('/api/client/policies', auth.authClient, auth.requireOwner, async (req, res) => {
  try {
    assertDatabaseResult(
      await db.upsertPolicies(getClientBusinessId(req), req.body),
      'actualizar las políticas',
    )
    res.json({ ok: true })
  } catch (error) {
    databaseFailure(res, 'actualizar las políticas', error)
  }
})

router.put('/api/client/bot-prompt', auth.authClient, auth.requireOwner, async (req, res) => {
  try {
    assertDatabaseResult(
      await db.upsertPolicies(getClientBusinessId(req), { bot_prompt: req.body.bot_prompt }),
      'actualizar el prompt',
    )
    res.json({ ok: true })
  } catch (error) {
    databaseFailure(res, 'actualizar el prompt', error)
  }
})

export = router
