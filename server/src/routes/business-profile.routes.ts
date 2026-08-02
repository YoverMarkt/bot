import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'
import type { BusinessRecord } from '../db/types'

const editableBusinessFields = [
  'name',
  'slogan',
  'description',
  'hours',
  'address',
  'phone',
  'social',
  'payment_methods',
  'delivery_fee',
  'brand_color',
  'logo_url',
] as const

type EditableBusinessField = (typeof editableBusinessFields)[number]
type DatabaseResult = { error?: { message?: string } | null }

interface ModuloDb {
  getClientStats(businessId: string): Promise<unknown>
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
  updateBusiness(
    businessId: string,
    data: Partial<Record<EditableBusinessField, unknown>>,
  ): Promise<DatabaseResult>
  getPolicies(businessId: string): Promise<unknown>
  upsertPolicies(businessId: string, data: unknown): Promise<DatabaseResult>
  getBusinessBankAccount(businessId: string): Promise<unknown>
  upsertBankAccount(businessId: string, data: Record<string, unknown>): Promise<DatabaseResult>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requireOwner: RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

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
  // Puede haberse eliminado entre la validación de la sesión y esta consulta.
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })
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
    // Apariencia y envío de la mini app. El importe oficial del envío lo
    // vuelve a calcular la base al crear el pedido; esto es la configuración.
    delivery_fee: Number(business.delivery_fee) || 0,
    brand_color: business.brand_color ?? null,
    logo_url: business.logo_url ?? null,
    suspended: business.suspended,
    bot_active: business.bot_active,
  })
})

router.put('/api/client/business', auth.authClient, auth.requireOwner, async (req, res) => {
  const data: Partial<Record<EditableBusinessField, unknown>> = {}
  for (const field of editableBusinessFields) {
    if (field in req.body) data[field] = req.body[field]
  }

  // Los dos campos que acaban en la mini app se validan aquí y no solo en el
  // CHECK: un 400 explicando qué pasa vale más que un 500 de la base.
  if ('delivery_fee' in data) {
    const monto = Number(data.delivery_fee)
    if (!Number.isFinite(monto) || monto < 0 || monto > 999) {
      return res.status(400).json({ error: 'El costo de envío debe estar entre 0 y 999' })
    }
    data.delivery_fee = Math.round(monto * 100) / 100
  }
  if ('brand_color' in data) {
    const color = typeof data.brand_color === 'string' ? data.brand_color.trim() : ''
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: 'El color debe ser un hex de 6 dígitos, por ejemplo #D9F950' })
    }
    // Vacío = volver al color de la plataforma.
    data.brand_color = color ? color.toUpperCase() : null
  }
  if ('logo_url' in data) {
    // La sube el propio panel a Cloudinary; aquí solo se acepta el resultado.
    // Vacío = quitar el logo.
    const url = typeof data.logo_url === 'string' ? data.logo_url.trim() : ''
    if (url && !/^https:\/\//.test(url)) {
      return res.status(400).json({ error: 'El logo debe ser una imagen subida desde el panel' })
    }
    data.logo_url = url || null
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

// ── Cuenta bancaria ─────────────────────────────────────────────────────────
//
// La tienda ya la mostraba en `/api/store/:slug/payment-info`, pero no había
// forma de cargarla salvo a mano en Supabase.
//
// El dueño DIJO que estos datos no son secretos: son con los que le pagan, y
// el banco es quien gestiona el riesgo. Aun así van tras `requireOwner` — un
// empleado con permiso de catálogo no tiene por qué cambiar a qué cuenta
// entra el dinero.

class InvalidBankInput extends Error {}

function bankField(value: unknown, name: string, max: number, required = false): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new InvalidBankInput(`${name} es obligatorio`)
    return null
  }
  if (typeof value !== 'string') throw new InvalidBankInput(`${name} es inválido`)
  const clean = value.trim()
  if ((required && !clean) || clean.length > max) throw new InvalidBankInput(`${name} es inválido`)
  return clean || null
}

router.get('/api/client/bank-account', auth.authClient, auth.requireOwner, async (req, res) => {
  res.json(await db.getBusinessBankAccount(getClientBusinessId(req)) || null)
})

router.put('/api/client/bank-account', auth.authClient, auth.requireOwner, async (req, res) => {
  try {
    const source = (req.body || {}) as Record<string, unknown>
    const account = {
      bank_name: bankField(source.bank_name, 'El banco', 80, true),
      account_type: source.account_type === 'corriente' ? 'corriente' : 'ahorros',
      account_number: bankField(source.account_number, 'El número de cuenta', 40, true),
      holder_name: bankField(source.holder_name, 'El titular', 120, true),
      holder_id: bankField(source.holder_id, 'La cédula o RUC', 20),
      instructions: bankField(source.instructions, 'Las instrucciones', 300),
    }
    assertDatabaseResult(
      await db.upsertBankAccount(getClientBusinessId(req), account),
      'guardar la cuenta bancaria',
    )
    res.json({ ok: true })
  } catch (error) {
    if (error instanceof InvalidBankInput) return res.status(400).json({ error: error.message })
    databaseFailure(res, 'guardar la cuenta bancaria', error)
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
