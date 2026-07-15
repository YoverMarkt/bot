import type { RequestHandler, Response } from 'express'
import { createRouter } from '../middleware/async'
import { sanitizeBusinessForAdmin, type BusinessRecord } from '../services/secrets'

interface DatabaseError {
  message?: string
}

interface DatabaseResult<T = unknown> {
  data?: T
  error?: DatabaseError | null
}

interface CreatedBusiness extends BusinessRecord {
  id: string
}

interface BillingRow extends Record<string, unknown> {
  business_id: string
}

const db = require('../db') as {
  getAdminStats(): Promise<unknown>
  getAllBusinesses(): Promise<unknown[]>
  getBusinessById(businessId: string): Promise<CreatedBusiness | null>
  getClientUserByBusiness(businessId: string): Promise<{ email?: string } | null>
  createBusinessOnboarding(
    business: Record<string, unknown>,
    clientEmail: string | null,
    passwordHash: string | null,
    monthlyRate: number | null,
  ): Promise<DatabaseResult<CreatedBusiness>>
  updateBusiness(businessId: string, data: Record<string, unknown>): Promise<DatabaseResult>
  deleteBusiness(businessId: string): Promise<DatabaseResult>
  suspendBusiness(businessId: string, reason: string): Promise<DatabaseResult>
  reactivateBusiness(businessId: string): Promise<DatabaseResult>
  createClientUser(data: Record<string, unknown>): Promise<DatabaseResult>
  updateClientUser(
    businessId: string,
    email: string,
    passwordHash: string | null,
  ): Promise<DatabaseResult>
  upsertPolicies(businessId: string, data: Record<string, unknown>): Promise<DatabaseResult>
  generateYearBilling(businessId: string, amount: number): BillingRow[]
  createBillingBatch(rows: BillingRow[]): Promise<DatabaseResult>
  countBilling(businessId: string): Promise<number>
  updatePendingBilling(businessId: string, amount: number): Promise<DatabaseResult>
  getProducts(businessId: string): Promise<unknown[]>
  getConversations(businessId: string): Promise<unknown[]>
  getPolicies(businessId: string): Promise<unknown>
}
const auth = require('../middleware/auth') as {
  authAdmin: RequestHandler
}
const bcrypt = require('bcryptjs') as {
  hash(value: string, rounds: number): Promise<string>
}

const router = createRouter()
const MIN_PASSWORD_LENGTH = 12

function configuredText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function channelConfigurationError(body: Record<string, unknown>): string | null {
  const provider = configuredText(body.whatsapp_provider)
    ? String(body.whatsapp_provider)
    : 'ycloud'
  if (provider === 'ycloud' && !configuredText(body.ycloud_api_key)
    && !configuredText(process.env.YCLOUD_API_KEY)) {
    return 'Configura una API Key de YCloud antes de crear el negocio'
  }
  if (provider === 'meta'
    && (!configuredText(body.meta_token) || !configuredText(body.meta_phone_id))) {
    return 'Meta requiere Token y Phone ID antes de crear el negocio'
  }
  if (provider === 'kapso'
    && ((!configuredText(body.kapso_api_key) && !configuredText(process.env.KAPSO_API_KEY))
      || !configuredText(body.kapso_number_id))) {
    return 'Kapso requiere API Key y Number ID antes de crear el negocio'
  }
  if (provider === 'telegram' && !configuredText(body.telegram_bot_token)
    && !configuredText(process.env.TELEGRAM_BOT_TOKEN)) {
    return 'Telegram requiere un Bot Token antes de crear el negocio'
  }
  if (!['ycloud', 'meta', 'kapso', 'telegram'].includes(provider)) {
    return 'Proveedor de WhatsApp no válido'
  }
  return null
}

const ALLOWED_BUSINESS_FIELDS = [
  'name', 'type', 'description', 'hours', 'address', 'phone', 'social',
  'payment_methods', 'whatsapp_number', 'whatsapp_provider', 'plan',
  'plan_expires_at', 'active', 'bot_active', 'suspended', 'notes', 'slogan',
  'monthly_rate', 'owner_phone', 'ycloud_api_key', 'ycloud_number',
  'kapso_api_key', 'kapso_number_id', 'kapso_verify_token', 'meta_token',
  'meta_phone_id', 'meta_verify_token', 'telegram_bot_token', 'retell_agent_id',
  'ai_provider', 'takes_bookings', 'takes_orders', 'lodging_enabled',
] as const

function assertDatabaseResult(result: DatabaseResult, operation: string): void {
  if (result.error) {
    throw new Error(`${operation}: ${result.error.message || 'Error desconocido'}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido'
}

function safeFailure(res: Response, context: string, error: unknown) {
  console.error(`❌ ${context}:`, errorMessage(error))
  return res.status(500).json({ error: `No se pudo ${context}` })
}

function isActiveLodgingConstraint(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('No se puede deshabilitar hospedaje')
}

router.get('/api/admin/stats', auth.authAdmin, async (_req, res) => {
  res.json(await db.getAdminStats())
})

router.get('/api/admin/clients', auth.authAdmin, async (_req, res) => {
  res.json(await db.getAllBusinesses())
})

router.get('/api/admin/clients/:id', auth.authAdmin, async (req, res) => {
  const business = await db.getBusinessById(req.params.id)
  if (!business) return res.status(404).json({ error: 'No encontrado' })
  const user = await db.getClientUserByBusiness(req.params.id)
  res.json({
    ...sanitizeBusinessForAdmin(business),
    client_email: user?.email || '',
  })
})

router.post('/api/admin/clients', auth.authAdmin, async (req, res) => {
  const body = req.body as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const whatsappNumber = typeof body.whatsapp_number === 'string'
    ? body.whatsapp_number.trim()
    : ''
  if (!name || !whatsappNumber) {
    return res.status(400).json({ error: 'Nombre y número requeridos' })
  }

  const clientEmail = typeof body.client_email === 'string'
    ? body.client_email.trim() || null
    : null
  const clientPassword = typeof body.client_password === 'string'
    ? body.client_password || null
    : null
  if (Boolean(clientEmail) !== Boolean(clientPassword)) {
    return res.status(400).json({ error: 'Email y password deben enviarse juntos' })
  }
  if (!clientEmail || !clientPassword) {
    return res.status(400).json({ error: 'Email y password del dueño son obligatorios' })
  }
  if (clientPassword && clientPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    })
  }
  const channelError = channelConfigurationError(body)
  if (channelError) return res.status(400).json({ error: channelError })
  const parsedMonthlyRate = Number.parseFloat(String(body.monthly_rate || ''))
  if (!(parsedMonthlyRate > 0)) {
    return res.status(400).json({ error: 'La tarifa mensual debe ser mayor que cero' })
  }

  try {
    const slug = `${name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')}-${Date.now()}`
    const businessPayload: Record<string, unknown> = {
      slug,
      name,
      type: body.type || 'negocio',
      whatsapp_number: whatsappNumber,
      whatsapp_provider: body.whatsapp_provider || 'ycloud',
      kapso_api_key: body.kapso_api_key,
      kapso_number_id: body.kapso_number_id,
      kapso_verify_token: body.kapso_verify_token,
      ycloud_api_key: body.ycloud_api_key,
      ycloud_number: body.ycloud_number,
      meta_token: body.meta_token,
      meta_phone_id: body.meta_phone_id,
      meta_verify_token: body.meta_verify_token,
      telegram_bot_token: body.telegram_bot_token || null,
      retell_agent_id: body.retell_agent_id || null,
      takes_bookings: body.takes_bookings === true,
      takes_orders: body.takes_orders !== false,
      lodging_enabled: body.lodging_enabled === true,
      ai_provider: body.ai_provider || null,
      owner_phone: body.owner_phone || null,
      plan: body.plan || 'basic',
      plan_expires_at: body.plan_expires_at || null,
      active: true,
      bot_active: true,
      suspended: false,
      notes: body.notes,
    }
    const passwordHash = clientPassword ? await bcrypt.hash(clientPassword, 10) : null
    const monthlyRate = parsedMonthlyRate
    const result = await db.createBusinessOnboarding(
      businessPayload,
      clientEmail,
      passwordHash,
      monthlyRate,
    )
    assertDatabaseResult(result, 'crear onboarding')
    const business = result.data
    if (!business) throw new Error('crear onboarding: respuesta vacía')
    if (monthlyRate) {
      console.log(`💳 12 meses generados para ${name} — $${monthlyRate}/mes`)
    }
    res.status(201).json(sanitizeBusinessForAdmin(business))
  } catch (error) {
    safeFailure(res, 'crear el cliente', error)
  }
})

router.put('/api/admin/clients/:id', auth.authAdmin, async (req, res) => {
  const body = req.body as Record<string, unknown>
  if (typeof body.client_password === 'string' && body.client_password
    && body.client_password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    })
  }
  const businessData: Record<string, unknown> = {}
  for (const field of ALLOWED_BUSINESS_FIELDS) {
    if (field in body) businessData[field] = body[field]
  }
  if ('monthly_rate' in businessData) {
    businessData.monthly_rate = Number.parseFloat(String(businessData.monthly_rate)) || null
  }

  try {
    if (Object.keys(businessData).length) {
      const result = await db.updateBusiness(req.params.id, businessData)
      assertDatabaseResult(result, 'actualizar negocio')
    }

    const monthlyRate = Number.parseFloat(String(body.monthly_rate || ''))
    if (monthlyRate > 0) {
      const existing = await db.countBilling(req.params.id)
      if (existing > 0) {
        assertDatabaseResult(
          await db.updatePendingBilling(req.params.id, monthlyRate),
          'actualizar facturación pendiente',
        )
      } else {
        assertDatabaseResult(
          await db.createBillingBatch(db.generateYearBilling(req.params.id, monthlyRate)),
          'crear facturación',
        )
      }
    }

    if (typeof body.client_email === 'string' && body.client_email) {
      const passwordHash = typeof body.client_password === 'string' && body.client_password
        ? await bcrypt.hash(body.client_password, 10)
        : null
      assertDatabaseResult(
        await db.updateClientUser(req.params.id, body.client_email, passwordHash),
        'actualizar usuario cliente',
      )
    }
    res.json({ ok: true })
  } catch (error) {
    if (isActiveLodgingConstraint(error)) {
      return res.status(409).json({
        error: 'No puedes deshabilitar hospedaje mientras existan solicitudes pendientes o estadías activas.',
      })
    }
    safeFailure(res, 'actualizar el cliente', error)
  }
})

router.delete('/api/admin/clients/:id', auth.authAdmin, async (req, res) => {
  try {
    assertDatabaseResult(await db.deleteBusiness(req.params.id), 'eliminar negocio')
    console.log(`🗑️ Cliente eliminado: ${req.params.id}`)
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'eliminar el cliente', error)
  }
})

router.post(
  '/api/admin/clients/:id/generate-billing',
  auth.authAdmin,
  async (req, res) => {
    const monthlyRate = Number.parseFloat(String((req.body as Record<string, unknown>).monthly_rate || ''))
    if (!(monthlyRate > 0)) {
      return res.status(400).json({ error: 'Tarifa mensual requerida' })
    }
    try {
      const rows = db.generateYearBilling(req.params.id, monthlyRate)
      assertDatabaseResult(await db.createBillingBatch(rows), 'crear facturación')
      res.json({ ok: true, created: rows.length })
    } catch (error) {
      safeFailure(res, 'generar la facturación', error)
    }
  },
)

router.post('/api/admin/clients/:id/suspend', auth.authAdmin, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' && req.body.reason
    ? req.body.reason
    : 'Pago pendiente'
  try {
    assertDatabaseResult(await db.suspendBusiness(req.params.id, reason), 'suspender negocio')
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'suspender el cliente', error)
  }
})

router.post('/api/admin/clients/:id/reactivate', auth.authAdmin, async (req, res) => {
  try {
    assertDatabaseResult(await db.reactivateBusiness(req.params.id), 'reactivar negocio')
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'reactivar el cliente', error)
  }
})

router.post('/api/admin/clients/:id/create-user', auth.authAdmin, async (req, res) => {
  const { email, password } = req.body as { email?: unknown; password?: unknown }
  if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email y password requeridos' })
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    })
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10)
    assertDatabaseResult(await db.createClientUser({
      business_id: req.params.id,
      email,
      password_hash: passwordHash,
    }), 'crear usuario cliente')
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'crear el usuario cliente', error)
  }
})

router.get('/api/admin/clients/:id/products', auth.authAdmin, async (req, res) => {
  res.json(await db.getProducts(req.params.id))
})

router.get('/api/admin/clients/:id/conversations', auth.authAdmin, async (req, res) => {
  res.json(await db.getConversations(req.params.id))
})

router.get('/api/admin/clients/:id/policies', auth.authAdmin, async (req, res) => {
  res.json(await db.getPolicies(req.params.id) || {})
})

router.put('/api/admin/clients/:id/policies', auth.authAdmin, async (req, res) => {
  try {
    assertDatabaseResult(
      await db.upsertPolicies(req.params.id, req.body as Record<string, unknown>),
      'actualizar políticas',
    )
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'actualizar las políticas', error)
  }
})

export = router
