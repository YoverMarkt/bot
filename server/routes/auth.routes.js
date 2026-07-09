// ── RUTAS: LOGIN (admin y cliente) ───────────────────────────────────
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento. El rate-limit anti fuerza bruta vive aquí junto a
// sus únicos consumidores.
const express = require('express')
const rateLimit = require('express-rate-limit')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const db      = require('../db')
const { JWT } = require('../middleware/auth')

const router = express.Router()

// Login: máx 20 intentos FALLIDOS por IP cada 15 min (anti fuerza bruta).
// Los logins exitosos no gastan el cupo, así que usuarios legítimos no se bloquean.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Espera 15 minutos.' }
})

// ── ADMIN (dueño del SaaS) ──
router.post('/api/admin/login', loginLimiter, (req, res) => {
  const { email, password } = req.body
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Credenciales incorrectas' })
  const token = jwt.sign({ role: 'admin', email }, JWT(), { expiresIn: '7d' })
  res.json({ token })
})

// ── CLIENTE (dueño/empleado de cada negocio) ──
router.post('/api/client/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body
  try {
    const user = await db.getClientByEmail(email)
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' })
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Contraseña incorrecta' })
    const biz = await db.getBusinessById(user.business_id)
    if (!biz?.active) return res.status(403).json({ error: 'Tu cuenta no está activa. Contacta al administrador.' })
    const urole = user.role || 'owner'
    const perms = Array.isArray(user.permissions) ? user.permissions : []
    const token = jwt.sign({ userId: user.id, businessId: user.business_id, role: 'client', urole, perms, email }, JWT(), { expiresIn: '7d' })
    res.json({ token, user: { name: user.name || '', role: urole, permissions: perms }, business: { id: biz.id, name: biz.name, type: biz.type, suspended: biz.suspended, bot_active: biz.bot_active } })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
