import type { RequestHandler, Response } from 'express'
import { createRouter } from '../middleware/async'
import { sanitizeBusinessForAdmin, type BusinessRecord } from '../services/secrets'
import { normalizeChannelIdentifier } from '../types/channels'

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
const ALLOWED_MESSAGING_PROVIDERS = ['ycloud', 'meta', 'telegram'] as const
type MessagingProvider = (typeof ALLOWED_MESSAGING_PROVIDERS)[number]

function configuredText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function configuredWhatsAppProvider(
  body: Record<string, unknown>,
): MessagingProvider | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'whatsapp_provider')) return 'ycloud'
  if (!configuredText(body.whatsapp_provider)) return null
  const provider = String(body.whatsapp_provider).trim()
  return ALLOWED_MESSAGING_PROVIDERS.find(candidate => candidate === provider) || null
}

function channelIdentifierFormatError(body: Record<string, unknown>): string | null {
  for (const [field, label] of [
    ['whatsapp_number', 'El número de WhatsApp'],
    ['ycloud_number', 'El número YCloud'],
  ] as const) {
    if (configuredText(body[field])
      && !normalizeChannelIdentifier('phone', String(body[field]))) {
      return `${label} debe usar formato internacional E.164 con 8 a 15 dígitos`
    }
  }
  for (const [field, label] of [
    ['meta_phone_id', 'El Phone ID de Meta'],
    ['ycloud_webhook_endpoint_id', 'El Endpoint ID de YCloud'],
  ] as const) {
    if (configuredText(body[field])
      && !normalizeChannelIdentifier('account_id', String(body[field]))) {
      return `${label} es inválido`
    }
  }
  return null
}

function channelConfigurationError(body: Record<string, unknown>): string | null {
  const formatError = channelIdentifierFormatError(body)
  if (formatError) return formatError
  const provider = configuredWhatsAppProvider(body)
  if (!provider) return 'Proveedor de mensajería no válido'
  if (provider === 'ycloud' && !configuredText(body.ycloud_api_key)
    && !configuredText(process.env.YCLOUD_API_KEY)) {
    return 'Configura una API Key de YCloud antes de guardar el negocio'
  }
  if (provider === 'ycloud' && !configuredText(body.ycloud_webhook_secret)
    && !configuredText(process.env.YCLOUD_WEBHOOK_SECRET)) {
    return 'YCloud requiere el Signing Secret del webhook antes de guardar el negocio'
  }
  if (provider === 'ycloud' && !configuredText(body.ycloud_webhook_endpoint_id)
    && !configuredText(process.env.YCLOUD_WEBHOOK_ENDPOINT_ID)) {
    return 'YCloud requiere el Endpoint ID del webhook antes de guardar el negocio'
  }
  if (provider === 'meta'
    && (!configuredText(body.meta_token) || !configuredText(body.meta_phone_id))) {
    return 'Meta requiere Token y Phone ID antes de guardar el negocio'
  }
  if (provider === 'telegram' && !configuredText(body.telegram_bot_token)
    && !configuredText(process.env.TELEGRAM_BOT_TOKEN)) {
    return 'Telegram requiere un Bot Token antes de guardar el negocio'
  }
  return null
}

const ALLOWED_BUSINESS_FIELDS = [
  'name', 'type', 'description', 'hours', 'address', 'phone', 'social',
  'payment_methods', 'whatsapp_number', 'whatsapp_provider', 'plan',
  'plan_expires_at', 'active', 'bot_active', 'suspended', 'notes', 'slogan',
  'monthly_rate', 'owner_phone', 'ycloud_api_key', 'ycloud_number',
  'ycloud_webhook_endpoint_id', 'ycloud_webhook_secret',
  'meta_token', 'meta_phone_id', 'telegram_bot_token',
  'ai_provider', 'takes_bookings', 'takes_orders', 'lodging_enabled',
  'chat_mode',
  'monthly_contact_limit', 'monthly_outbound_message_limit',
] as const

// Solo estos dos modos existen; cualquier otro valor lo rechaza la base.
const CHAT_MODES = ['menu', 'ai'] as const
const USAGE_LIMITS = {
  monthly_contact_limit: 1_000_000,
  monthly_outbound_message_limit: 10_000_000,
} as const
type UsageLimitField = keyof typeof USAGE_LIMITS
const PLAN_USAGE_PRESETS: Record<string, Record<UsageLimitField, number>> = {
  micro: {
    monthly_contact_limit: 50,
    monthly_outbound_message_limit: 250,
  },
  basic: {
    monthly_contact_limit: 200,
    monthly_outbound_message_limit: 1_000,
  },
  pro: {
    monthly_contact_limit: 500,
    monthly_outbound_message_limit: 2_500,
  },
  premium: {
    monthly_contact_limit: 2_000,
    monthly_outbound_message_limit: 10_000,
  },
}

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

// El modo se valida aquí además de en la base: así el panel recibe un mensaje
// claro en vez de un error de restricción de Postgres.
function invalidChatMode(body: Record<string, unknown>): boolean {
  if (!('chat_mode' in body)) return false
  const value = body.chat_mode
  return !CHAT_MODES.some(mode => mode === value)
}

function parsedUsageLimit(
  body: Record<string, unknown>,
  field: keyof typeof USAGE_LIMITS,
): number | null | undefined {
  if (!(field in body)) return undefined
  if (body[field] === null || body[field] === '') return null
  const value = Number(body[field])
  if (!Number.isInteger(value) || value < 1 || value > USAGE_LIMITS[field]) {
    return undefined
  }
  return value
}

function usageLimitError(body: Record<string, unknown>): string | null {
  for (const [field, label] of [
    ['monthly_contact_limit', 'El límite mensual de contactos'],
    ['monthly_outbound_message_limit', 'El límite mensual de mensajes'],
  ] as const) {
    if (!(field in body)) continue
    if (body[field] === null || body[field] === '') continue
    if (parsedUsageLimit(body, field) === undefined) {
      return `${label} debe ser un número entero válido`
    }
  }
  return null
}

function resolvedUsageLimits(
  body: Record<string, unknown>,
  usePlanPreset: boolean,
): Record<UsageLimitField, number | null | undefined> {
  const plan = typeof body.plan === 'string'
    ? body.plan.trim().toLowerCase()
    : ''
  const preset = usePlanPreset ? PLAN_USAGE_PRESETS[plan] : undefined
  return {
    monthly_contact_limit: parsedUsageLimit(body, 'monthly_contact_limit')
      ?? (
        body.monthly_contact_limit === null || body.monthly_contact_limit === ''
          ? null
          : preset?.monthly_contact_limit
      ),
    monthly_outbound_message_limit: parsedUsageLimit(
      body,
      'monthly_outbound_message_limit',
    ) ?? (
      body.monthly_outbound_message_limit === null
        || body.monthly_outbound_message_limit === ''
        ? null
        : preset?.monthly_outbound_message_limit
    ),
  }
}

function isActiveLodgingConstraint(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('No se puede deshabilitar hospedaje')
}

// Dos negocios NUNCA pueden compartir el mismo identificador de canal: el bot
// resuelve a qué negocio pertenece cada mensaje por el número de WhatsApp o el
// slug de Telegram. La base lo bloquea; aquí se traduce a un mensaje entendible
// en vez del genérico "no se pudo actualizar".
function duplicateChannelMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  if (!/duplicate key|llave duplicada/i.test(error.message)) return null
  if (/whatsapp_number|business_channel_phone|business_channel_identifier/i.test(error.message)) {
    return 'Ese número de WhatsApp ya está asignado a otro negocio. Cada negocio necesita su propio número: quítalo del otro negocio antes de asignarlo aquí.'
  }
  if (/businesses_slug_key|\bslug\b/i.test(error.message)) {
    return 'Ese identificador (slug) ya lo usa otro negocio. Elige uno distinto.'
  }
  return 'Ese dato ya está registrado en otro negocio y debe ser único.'
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
  if (invalidChatMode(body)) {
    return res.status(400).json({ error: 'Modo de conversación no válido (menu o ai)' })
  }
  const limitsError = usageLimitError(body)
  if (limitsError) return res.status(400).json({ error: limitsError })
  const whatsappProvider = configuredWhatsAppProvider(body)
  if (!whatsappProvider) {
    return res.status(400).json({ error: 'Proveedor de mensajería no válido' })
  }
  const parsedMonthlyRate = Number.parseFloat(String(body.monthly_rate || ''))
  if (!(parsedMonthlyRate > 0)) {
    return res.status(400).json({ error: 'La tarifa mensual debe ser mayor que cero' })
  }
  const usageLimits = resolvedUsageLimits(body, 'plan' in body)

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
      whatsapp_provider: whatsappProvider,
      ycloud_api_key: body.ycloud_api_key,
      ycloud_number: body.ycloud_number,
      ycloud_webhook_endpoint_id: body.ycloud_webhook_endpoint_id,
      ycloud_webhook_secret: body.ycloud_webhook_secret,
      meta_token: body.meta_token,
      meta_phone_id: body.meta_phone_id,
      telegram_bot_token: body.telegram_bot_token || null,
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
      monthly_contact_limit: usageLimits.monthly_contact_limit,
      monthly_outbound_message_limit:
        usageLimits.monthly_outbound_message_limit,
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
    // La RPC atómica todavía no conoce chat_mode ni los límites de consumo
    // (lodging_enabled sí lo inserta ella). Se aplican juntos justo después;
    // son preferencias editables y no invariantes de dinero.
    const postCreatePreferences: Record<string, unknown> = {}
    if (typeof body.chat_mode === 'string') {
      postCreatePreferences.chat_mode = body.chat_mode
    }
    for (const field of Object.keys(USAGE_LIMITS) as UsageLimitField[]) {
      const value = usageLimits[field]
      if (value !== undefined) postCreatePreferences[field] = value
    }
    if (Object.keys(postCreatePreferences).length) {
      assertDatabaseResult(
        await db.updateBusiness(String(business.id), postCreatePreferences),
        'aplicar preferencias del negocio',
      )
      Object.assign(business, postCreatePreferences)
    }
    if (monthlyRate) {
      console.log(`💳 12 meses generados para ${name} — $${monthlyRate}/mes`)
    }
    res.status(201).json(sanitizeBusinessForAdmin(business))
  } catch (error) {
    const duplicated = duplicateChannelMessage(error)
    if (duplicated) {
      console.error('❌ crear el cliente:', errorMessage(error))
      return res.status(409).json({ error: duplicated })
    }
    safeFailure(res, 'crear el cliente', error)
  }
})

router.put('/api/admin/clients/:id', auth.authAdmin, async (req, res) => {
  const body = req.body as Record<string, unknown>
  const identifierError = channelIdentifierFormatError(body)
  if (identifierError) return res.status(400).json({ error: identifierError })
  if ('whatsapp_provider' in body && !configuredWhatsAppProvider(body)) {
    return res.status(400).json({ error: 'Proveedor de mensajería no válido' })
  }
  if (invalidChatMode(body)) {
    return res.status(400).json({ error: 'Modo de conversación no válido (menu o ai)' })
  }
  const limitsError = usageLimitError(body)
  if (limitsError) return res.status(400).json({ error: limitsError })
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
  const usageLimits = resolvedUsageLimits(body, 'plan' in body)
  for (const field of Object.keys(USAGE_LIMITS) as UsageLimitField[]) {
    const value = usageLimits[field]
    if (value !== undefined) businessData[field] = value
  }
  if ('whatsapp_provider' in businessData) {
    businessData.whatsapp_provider = configuredWhatsAppProvider(body)
  }
  if ('monthly_rate' in businessData) {
    businessData.monthly_rate = Number.parseFloat(String(businessData.monthly_rate)) || null
  }

  try {
    const existingBusiness = await db.getBusinessById(req.params.id)
    if (!existingBusiness) return res.status(404).json({ error: 'No encontrado' })

    // Una edición puede conservar secretos que el navegador nunca recibe.
    // Validamos el estado que realmente quedará guardado, no solo el fragmento
    // enviado por el formulario.
    const effectiveBusiness: Record<string, unknown> = {
      ...existingBusiness,
      ...businessData,
    }
    if (!('whatsapp_provider' in businessData)
      && !configuredText(existingBusiness.whatsapp_provider)) {
      effectiveBusiness.whatsapp_provider = 'ycloud'
    }
    const channelError = channelConfigurationError(effectiveBusiness)
    if (channelError) return res.status(400).json({ error: channelError })

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
    const duplicated = duplicateChannelMessage(error)
    if (duplicated) {
      console.error('❌ actualizar el cliente:', errorMessage(error))
      return res.status(409).json({ error: duplicated })
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
