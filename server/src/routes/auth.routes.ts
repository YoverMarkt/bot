import type { Router } from 'express'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { JWT } from '../middleware/auth'
import { createRouter } from '../middleware/async'

interface LoginBody {
  email?: unknown
  password?: unknown
}

interface ClientUser {
  id: string
  business_id: string
  password_hash: string
  name?: unknown
  role?: string | null
  permissions?: unknown
}

interface BusinessRecord {
  id: string
  name: unknown
  type: unknown
  active?: unknown
  suspended?: unknown
  bot_active?: unknown
  takes_bookings?: unknown
  lodging_enabled?: unknown
}

const bcrypt = require('bcryptjs') as {
  compare(value: string, hash: string): Promise<boolean>
}
const db = require('../db') as {
  getClientByEmail(email: string): Promise<ClientUser | null>
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
}

const LOGIN_RATE_LIMIT_OPTIONS = {
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Espera 15 minutos.' },
}

type AuthRouter = Router & {
  loginRateLimitOptions: typeof LOGIN_RATE_LIMIT_OPTIONS
}

const router = createRouter() as AuthRouter
router.loginRateLimitOptions = LOGIN_RATE_LIMIT_OPTIONS

const loginLimiter = rateLimit(LOGIN_RATE_LIMIT_OPTIONS)

router.post('/api/admin/login', loginLimiter, (req, res) => {
  const { email, password } = (req.body || {}) as LoginBody
  const adminEmail = process.env.ADMIN_EMAIL?.trim()
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminEmail || !adminPassword
    || typeof email !== 'string' || typeof password !== 'string'
    || email !== adminEmail || password !== adminPassword) {
    return res.status(401).json({ error: 'Credenciales incorrectas' })
  }

  const token = jwt.sign({ role: 'admin', email }, JWT(), { expiresIn: '7d' })
  res.json({ token })
})

router.post('/api/client/login', loginLimiter, async (req, res) => {
  const { email, password } = (req.body || {}) as LoginBody
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ error: 'Credenciales incorrectas' })
  }
  try {
    const user = await db.getClientByEmail(email)
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' })

    const validPassword = await bcrypt.compare(password, user.password_hash)
    if (!validPassword) return res.status(401).json({ error: 'Credenciales incorrectas' })

    const business = await db.getBusinessById(user.business_id)
    if (!business?.active) {
      return res.status(403).json({
        error: 'Tu cuenta no está activa. Contacta al administrador.',
      })
    }

    const userRole = user.role || 'owner'
    const permissions = Array.isArray(user.permissions) ? user.permissions : []
    const token = jwt.sign({
      userId: user.id,
      businessId: user.business_id,
      role: 'client',
      urole: userRole,
      perms: permissions,
      takesBookings: business.takes_bookings === true,
      lodgingEnabled: business.lodging_enabled === true,
      email,
    }, JWT(), { expiresIn: '7d' })

    res.json({
      token,
      user: {
        name: user.name || '',
        role: userRole,
        permissions,
      },
      business: {
        id: business.id,
        name: business.name,
        type: business.type,
        suspended: business.suspended,
        bot_active: business.bot_active,
        takes_bookings: business.takes_bookings === true,
        lodging_enabled: business.lodging_enabled === true,
      },
    })
  } catch (error) {
    console.error('❌ Login cliente:', (error as Error).message)
    res.status(500).json({ error: 'No se pudo iniciar sesión' })
  }
})

export = router
