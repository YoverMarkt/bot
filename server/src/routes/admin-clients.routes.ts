import type { RequestHandler, Response } from 'express'
import { createRouter } from '../middleware/async'
import type { WriteResult } from '../db/types'
import {
  getPlanDefinition,
  normalizePlanId,
  type PlanDefinition,
  type PlanId,
} from '../config/plans'
import {
  diagnoseChannels,
  type ChannelActivity,
  type DiagnosableBusiness,
} from '../services/channel-health'
const ALLOWED_ERROR_CATEGORIES = ['canal', 'ia', 'envio', 'servidor']

interface PlatformErrorRow {
  id: string
  business_id: string | null
  category: string
  code: string | null
  message: string
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}
import { recordError } from '../services/error-log'
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

const db: {
  getAdminStats(): Promise<unknown>
  getAllBusinesses(): Promise<unknown[]>
  getLastInboundByBusiness(businessIds: string[]): Promise<ChannelActivity[]>
  getErrorCountsByBusiness(): Promise<unknown[]>
  getPlatformErrors(options: {
    category?: string
    businessId?: string
    limit?: number
  }): Promise<PlatformErrorRow[]>
  getBusinessById(businessId: string): Promise<CreatedBusiness | null>
  getClientUserByBusiness(businessId: string): Promise<{ email?: string } | null>
  createBusinessOnboarding(
    business: Record<string, unknown>,
    clientEmail: string | null,
    passwordHash: string | null,
    monthlyRate: number | null,
  ): Promise<WriteResult<CreatedBusiness>>
  updateBusiness(businessId: string, data: Record<string, unknown>): Promise<DatabaseResult>
  deleteBusiness(businessId: string): Promise<DatabaseResult>
  suspendBusiness(businessId: string, reason: string): Promise<DatabaseResult>
  reactivateBusiness(businessId: string): Promise<DatabaseResult>
  updateBusinessPlanBilling(
    businessId: string,
    plan: string,
    monthlyRate: number,
    monthlyContactLimit: number,
    monthlyOutboundMessageLimit: number,
  ): Promise<DatabaseResult>
  createClientUser(data: Record<string, unknown>): Promise<DatabaseResult>
  updateClientUser(
    businessId: string,
    email: string,
    passwordHash: string | null,
  ): Promise<DatabaseResult>
  upsertPolicies(businessId: string, data: Record<string, unknown>): Promise<DatabaseResult>
  getProducts(businessId: string): Promise<unknown[]>
  getConversations(businessId: string): Promise<unknown[]>
  getPolicies(businessId: string): Promise<unknown>
} = require('../db') as typeof import('../db')
const auth: {
  authAdmin: RequestHandler
} = require('../middleware/auth') as typeof import('../middleware/auth')
const bcrypt = require('bcryptjs') as {
  hash(value: string, rounds: number): Promise<string>
}

const router = createRouter()
const MIN_PASSWORD_LENGTH = 12
const ALLOWED_MESSAGING_PROVIDERS = ['ycloud', 'meta', 'telegram'] as const
type MessagingProvider = (typeof ALLOWED_MESSAGING_PROVIDERS)[number]
type UsageLimits = {
  monthly_contact_limit: number
  monthly_outbound_message_limit: number
}

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
  'active', 'bot_active', 'suspended', 'notes', 'slogan',
  'owner_phone', 'ycloud_api_key', 'ycloud_number',
  'ycloud_webhook_endpoint_id', 'ycloud_webhook_secret',
  'meta_token', 'meta_phone_id', 'telegram_bot_token',
  'ai_provider', 'takes_bookings', 'takes_orders', 'lodging_enabled',
  'chat_mode', 'storefront_enabled',
] as const

// Solo estos dos modos existen; cualquier otro valor lo rechaza la base.
const CHAT_MODES = ['menu', 'ai'] as const

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
  // El panel solo puede decir «no se pudo»: enseñar el error de la base a un
  // navegador filtraría nombres de tablas y restricciones. Pero el motivo real
  // TIENE que quedar en algún sitio consultable — si no, un fallo como el del
  // alta de clientes (2026-08-02) se vuelve invisible: el panel decía «no se
  // pudo crear el cliente» y el registro de errores estaba vacío.
  void recordError({
    category: 'servidor',
    code: context,
    message: errorMessage(error),
  })
  return res.status(500).json({ error: `No se pudo ${context}` })
}

// El modo se valida aquí además de en la base: así el panel recibe un mensaje
// claro en vez de un error de restricción de Postgres.
function invalidChatMode(body: Record<string, unknown>): boolean {
  if (!('chat_mode' in body)) return false
  const value = body.chat_mode
  return !CHAT_MODES.some(mode => mode === value)
}

function usageLimitsForPlan(plan: PlanDefinition): UsageLimits {
  return {
    monthly_contact_limit: plan.monthlyContactLimit,
    monthly_outbound_message_limit: plan.monthlyOutboundMessageLimit,
  }
}

function requestedPlan(body: Record<string, unknown>, fallback: PlanId): PlanDefinition | null {
  return getPlanDefinition('plan' in body ? body.plan : fallback)
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

// Vigilancia del canal de entrada: responde "¿siguen llegando mensajes?".
// Existe porque en julio de 2026 el bot estuvo cinco días mudo sin que nada
// avisara — el servidor vivía, pero ningún WhatsApp entraba.
router.get('/api/admin/channel-health', auth.authAdmin, async (_req, res) => {
  const businesses = await db.getAllBusinesses() as DiagnosableBusiness[]
  const [activity, errorCounts] = await Promise.all([
    db.getLastInboundByBusiness(businesses.map(business => business.id)),
    db.getErrorCountsByBusiness(),
  ])
  res.json({
    ...diagnoseChannels({ businesses, activity }),
    errorsByBusiness: errorCounts,
  })
})

// Registro de errores para diagnosticar sin entrar a los logs del servidor.
router.get('/api/admin/errors', auth.authAdmin, async (req, res) => {
  const query = req.query as Record<string, string | undefined>
  res.json(await db.getPlatformErrors({
    category: ALLOWED_ERROR_CATEGORIES.includes(String(query.category))
      ? query.category
      : undefined,
    businessId: query.business_id,
    limit: Number(query.limit) || 200,
  }))
})

// Descarga en CSV para compartir el diagnóstico. Los mensajes ya salen
// saneados de `services/error-log.ts`: sin credenciales ni datos personales.
router.get('/api/admin/errors/export', auth.authAdmin, async (_req, res) => {
  const errors = await db.getPlatformErrors({ limit: 1000 })
  const rows = [
    ['ultima_vez', 'primera_vez', 'veces', 'categoria', 'codigo', 'negocio', 'mensaje'],
    ...errors.map(error => [
      error.last_seen_at,
      error.first_seen_at,
      String(error.occurrences),
      error.category,
      error.code || '',
      error.business_id || 'plataforma',
      error.message,
    ]),
  ]
  const csv = rows
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="errores-${stamp}.csv"`)
  res.send(`﻿${csv}`)
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
  const whatsappProvider = configuredWhatsAppProvider(body)
  if (!whatsappProvider) {
    return res.status(400).json({ error: 'Proveedor de mensajería no válido' })
  }
  const planDefinition = requestedPlan(body, 'micro')
  if (!planDefinition) {
    return res.status(400).json({ error: 'Selecciona uno de los seis planes disponibles' })
  }
  const usageLimits = usageLimitsForPlan(planDefinition)

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
      // La tienda nace apagada salvo que se pida: encenderla sin catálogo
      // cargado le daría al cliente final una app vacía.
      storefront_enabled: body.storefront_enabled === true,
      chat_mode: body.chat_mode === 'menu' ? 'menu' : 'ai',
      ai_provider: body.ai_provider || null,
      owner_phone: body.owner_phone || null,
      plan: planDefinition.id,
      active: true,
      bot_active: true,
      suspended: false,
      notes: body.notes,
      monthly_contact_limit: usageLimits.monthly_contact_limit,
      monthly_outbound_message_limit:
        usageLimits.monthly_outbound_message_limit,
    }
    const passwordHash = clientPassword ? await bcrypt.hash(clientPassword, 10) : null
    const monthlyRate = planDefinition.monthlyRate
    const result = await db.createBusinessOnboarding(
      businessPayload,
      clientEmail,
      passwordHash,
      monthlyRate,
    )
    assertDatabaseResult(result, 'crear onboarding')
    const business = result.data
    if (!business) throw new Error('crear onboarding: respuesta vacía')
    Object.assign(business, usageLimits, { chat_mode: businessPayload.chat_mode })
    console.log(`💳 Cuota mensual automática para ${name} — $${monthlyRate}/mes`)
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
  if ('plan' in body && !normalizePlanId(body.plan)) {
    return res.status(400).json({ error: 'Selecciona uno de los seis planes disponibles' })
  }
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
  if ('whatsapp_provider' in businessData) {
    businessData.whatsapp_provider = configuredWhatsAppProvider(body)
  }

  try {
    const existingBusiness = await db.getBusinessById(req.params.id)
    if (!existingBusiness) return res.status(404).json({ error: 'No encontrado' })

    const currentPlanId = normalizePlanId(existingBusiness.plan)
    const nextPlan = 'plan' in body
      ? getPlanDefinition(body.plan)
      : null
    const planChanged = Boolean(nextPlan && (
      nextPlan.id !== currentPlanId || body.apply_plan_defaults === true
    ))
    if (nextPlan) {
      // El cambio financiero se ejecuta después en una sola RPC junto con las
      // cuotas. Los aliases antiguos sí pueden normalizarse sin tocar importes.
      if (!planChanged && existingBusiness.plan !== nextPlan.id) {
        businessData.plan = nextPlan.id
      } else {
        delete businessData.plan
      }
    }

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

    if (planChanged && nextPlan) {
      assertDatabaseResult(
        await db.updateBusinessPlanBilling(
          req.params.id,
          nextPlan.id,
          nextPlan.monthlyRate,
          nextPlan.monthlyContactLimit,
          nextPlan.monthlyOutboundMessageLimit,
        ),
        'actualizar plan y facturación',
      )
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
