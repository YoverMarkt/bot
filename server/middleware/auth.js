// @ts-check
// ── AUTH MIDDLEWARES (extraído de index.js — Fase 1 de ARQUITECTURA.md) ──
// El permiso se valida en el SERVIDOR (no basta ocultar el menú del panel).
// req.user sale SIEMPRE del JWT verificado: en rutas de cliente, el
// business_id es req.user.businessId (regla inviolable #1 de CLAUDE.md).
const jwt = require('jsonwebtoken')

const JWT = () => process.env.JWT_SECRET

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No autorizado' })
  try {
    const d = jwt.verify(token, JWT())
    if (d.role !== 'admin') return res.status(403).json({ error: 'Solo admins' })
    req.user = d; next()
  } catch { res.status(401).json({ error: 'Token inválido' }) }
}

function authClient(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No autorizado' })
  try { req.user = jwt.verify(token, JWT()); next() }
  catch { res.status(401).json({ error: 'Token inválido' }) }
}

// El dueño siempre pasa; el empleado necesita la sección en sus permisos.
function requirePermission(section) {
  return (req, res, next) => {
    if (req.user?.urole === 'owner') return next()
    const perms = Array.isArray(req.user?.perms) ? req.user.perms : []
    if (perms.includes(section)) return next()
    return res.status(403).json({ error: 'No tienes permiso para esta sección' })
  }
}

function requireOwner(req, res, next) {
  if (req.user?.urole === 'owner') return next()
  return res.status(403).json({ error: 'Solo el dueño puede hacer esto' })
}

module.exports = { JWT, authAdmin, authClient, requirePermission, requireOwner }
