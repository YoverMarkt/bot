import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

type Permission =
  | 'catalogo'
  | 'conversaciones'
  | 'citas'
  | 'reportes'
  | 'ventas'
  | 'hospedaje'
type DataRecord = Record<string, unknown>

interface UserPayload {
  email?: string
  password?: string
  name?: unknown
  permissions?: unknown
}

interface UserFields {
  email?: string
  password_hash?: string
  name?: unknown
  permissions?: Permission[]
}

const bcrypt = require('bcryptjs') as {
  hash(value: string, rounds: number): Promise<string>
}
const db = require('../db') as {
  countProducts(businessId: string): Promise<number>
  getPolicies(businessId: string): Promise<DataRecord | null>
  getSchedule(businessId: string): Promise<Array<{ is_active?: unknown }>>
  getBusinessById(businessId: string): Promise<DataRecord | null>
  getClientUsers(businessId: string): Promise<unknown>
  createClientUser(data: DataRecord): Promise<{
    data: { id: string }
    error: { message: string } | null
  }>
  updateClientUserById(
    businessId: string,
    userId: string,
    fields: UserFields,
  ): Promise<unknown>
  deleteClientUserById(businessId: string, userId: string): Promise<unknown>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requireOwner: RequestHandler
}

const router = createRouter()
const MIN_PASSWORD_LENGTH = 12
const validPermissions: Permission[] = [
  'catalogo',
  'conversaciones',
  'citas',
  'reportes',
  'ventas',
  'hospedaje',
]

function hasValue(value: unknown): boolean {
  return Boolean(value && String(value).trim())
}

function filterPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return []
  return value.filter((permission): permission is Permission => (
    typeof permission === 'string' && validPermissions.includes(permission as Permission)
  ))
}

router.get('/api/client/onboarding', auth.authClient, async (req, res) => {
  try {
    const businessId = getClientBusinessId(req)
    const [productCount, policies, schedule, business] = await Promise.all([
      db.countProducts(businessId),
      db.getPolicies(businessId),
      db.getSchedule(businessId),
      db.getBusinessById(businessId),
    ])
    const policiesReady = policies && (
      hasValue(policies.shipping)
      || hasValue(policies.returns)
      || hasValue(policies.discounts)
      || hasValue(policies.bot_instructions)
    )
    const scheduleReady = schedule.some(day => day.is_active) || hasValue(business?.hours)
    const whatsappNumber = business?.whatsapp_number
    const steps = [
      {
        key: 'productos',
        label: 'Sube tus productos o servicios',
        done: productCount > 0,
        hint: productCount > 0 ? `${productCount} cargado(s)` : '',
        page: 'products',
      },
      {
        key: 'prompt',
        label: 'Personaliza el prompt del bot',
        done: hasValue(policies?.bot_prompt),
        page: 'botprompt',
      },
      {
        key: 'politicas',
        label: 'Completa las políticas (envíos, garantía…)',
        done: Boolean(policiesReady),
        page: 'policies',
      },
      {
        key: 'horario',
        label: 'Define tu horario de atención',
        done: Boolean(scheduleReady),
        page: 'schedule',
      },
      {
        key: 'whatsapp',
        label: 'Conecta tu WhatsApp',
        done: hasValue(whatsappNumber),
        hint: hasValue(whatsappNumber) ? whatsappNumber : 'lo configura el administrador',
        page: null,
      },
    ]
    const done = steps.filter(step => step.done).length
    res.json({ steps, done, total: steps.length, pct: Math.round(done / steps.length * 100) })
  } catch (error) {
    console.error('❌ onboarding:', (error as Error).message)
    res.status(500).json({ error: 'No se pudo cargar el onboarding' })
  }
})

router.get('/api/client/users', auth.authClient, auth.requireOwner, async (req, res) => {
  res.json(await db.getClientUsers(getClientBusinessId(req)))
})

router.post('/api/client/users', auth.authClient, auth.requireOwner, async (req, res) => {
  const { email, password, name, permissions } = req.body as UserPayload
  if (!email || !password) {
    return res.status(400).json({ error: 'Correo y contraseña requeridos' })
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    })
  }

  const filteredPermissions = filterPermissions(permissions)
  try {
    const passwordHash = await bcrypt.hash(password, 10)
    const { data, error } = await db.createClientUser({
      business_id: getClientBusinessId(req),
      email: email.trim(),
      password_hash: passwordHash,
      name: name || null,
      role: 'employee',
      permissions: filteredPermissions,
    })
    if (error) return res.status(500).json({ error: error.message })
    res.status(201).json({ id: data.id })
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
})

router.put('/api/client/users/:id', auth.authClient, auth.requireOwner, async (req, res) => {
  const { email, password, name, permissions } = req.body as UserPayload
  const fields: UserFields = {}
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    })
  }
  if (email) fields.email = email.trim()
  if (name !== undefined) fields.name = name
  if (Array.isArray(permissions)) fields.permissions = filterPermissions(permissions)
  if (password) fields.password_hash = await bcrypt.hash(password, 10)

  try {
    if (Object.keys(fields).length) {
      await db.updateClientUserById(getClientBusinessId(req), req.params.id, fields)
    }
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
})

router.delete('/api/client/users/:id', auth.authClient, auth.requireOwner, async (req, res) => {
  try {
    await db.deleteClientUserById(getClientBusinessId(req), req.params.id)
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
})

// El frontend no recibe credenciales de Supabase y consume solo APIs autenticadas.
router.get('/api/client/supabase-config', auth.authClient, (_req, res) => res.json({}))

export = router
