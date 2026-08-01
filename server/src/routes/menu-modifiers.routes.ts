import type { RequestHandler, Response } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

type DataRecord = Record<string, unknown>

interface DatabaseResult {
  data?: unknown
  error?: { code?: string; message?: string } | null
}

const db = require('../db') as {
  getAllMenuModifiers(businessId: string): Promise<DataRecord[]>
  getMenuModifierById(businessId: string, id: string): Promise<DataRecord | null>
  createMenuModifier(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateMenuModifier(businessId: string, id: string, data: DataRecord): Promise<DatabaseResult>
  deleteMenuModifier(businessId: string, id: string): Promise<DatabaseResult>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}

const router = createRouter()
const canManageCatalog = auth.requirePermission('catalogo')
const guards = [auth.authClient, canManageCatalog] as const

class InvalidModifierInput extends Error {}

function textField(
  value: unknown,
  name: string,
  maximum: number,
  required = false,
): string | null {
  if (value === null || value === undefined) {
    if (required) throw new InvalidModifierInput(`${name} es obligatorio`)
    return null
  }
  if (typeof value !== 'string') throw new InvalidModifierInput(`${name} es inválido`)
  const clean = value.trim()
  if ((required && !clean) || clean.length > maximum) {
    throw new InvalidModifierInput(`${name} es inválido`)
  }
  return clean || null
}

function sanitizeModifier(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidModifierInput('Datos inválidos')
  }
  const source = body as DataRecord
  const sortRaw = source.sort
  const sort = sortRaw === undefined || sortRaw === null || sortRaw === ''
    ? 0
    : Number(sortRaw)
  if (!Number.isInteger(sort) || sort < 0 || sort > 100_000) {
    throw new InvalidModifierInput('El orden es inválido')
  }
  return {
    category_tag: textField(source.category_tag, 'La categoría', 60, true),
    group_label: textField(source.group_label, 'El grupo', 60) || 'Opción',
    name: textField(source.name, 'El nombre', 120, true),
    description: textField(source.description, 'La descripción', 2000),
    sort,
    active: source.active !== false,
  }
}

function safeFailure(res: Response, operation: string, error: unknown) {
  if (error instanceof InvalidModifierInput) {
    return res.status(400).json({ error: error.message })
  }
  console.error(`❌ ${operation}:`, error instanceof Error ? error.message : 'Error desconocido')
  return res.status(500).json({ error: `No se pudo ${operation}` })
}

// Postgres marca 23505 cuando choca el índice único (categoría + nombre)
function isDuplicate(result: DatabaseResult): boolean {
  return result.error?.code === '23505'
}

router.get('/api/client/menu-modifiers', ...guards, async (req, res) => {
  res.json(await db.getAllMenuModifiers(getClientBusinessId(req)))
})

router.post('/api/client/menu-modifiers', ...guards, async (req, res) => {
  try {
    const result = await db.createMenuModifier(getClientBusinessId(req), sanitizeModifier(req.body))
    if (isDuplicate(result)) {
      return res.status(409).json({ error: 'Ya existe una opción con ese nombre en la categoría' })
    }
    if (result.error) throw new Error(result.error.message)
    res.status(201).json(result.data)
  } catch (error) {
    safeFailure(res, 'crear la opción', error)
  }
})

router.put('/api/client/menu-modifiers/:id', ...guards, async (req, res) => {
  try {
    const businessId = getClientBusinessId(req)
    const current = await db.getMenuModifierById(businessId, req.params.id)
    if (!current) return res.status(404).json({ error: 'Opción no encontrada' })
    const result = await db.updateMenuModifier(businessId, req.params.id, sanitizeModifier(req.body))
    if (isDuplicate(result)) {
      return res.status(409).json({ error: 'Ya existe una opción con ese nombre en la categoría' })
    }
    if (result.error) throw new Error(result.error.message)
    res.json(result.data)
  } catch (error) {
    safeFailure(res, 'actualizar la opción', error)
  }
})

router.delete('/api/client/menu-modifiers/:id', ...guards, async (req, res) => {
  try {
    const result = await db.deleteMenuModifier(getClientBusinessId(req), req.params.id)
    if (result.error) throw new Error(result.error.message)
    if (!result.data) return res.status(404).json({ error: 'Opción no encontrada' })
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'eliminar la opción', error)
  }
})

export = router
