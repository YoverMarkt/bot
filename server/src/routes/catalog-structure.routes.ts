// Estructura del catálogo que gestiona el DUEÑO: categorías y variantes.
//
// Las tablas existían y la mini app ya sabía leerlas, pero no había forma de
// llenarlas salvo a mano desde Supabase. Sin variantes una pizza no puede
// tener tamaños, que es lo que bloqueaba cargar un menú real.
//
// El `business_id` sale SIEMPRE del JWT, nunca del cuerpo de la petición.
import type { RequestHandler, Response } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

type DataRecord = Record<string, unknown>

interface DatabaseResult {
  data?: unknown
  error?: { code?: string; message?: string } | null
}

interface ModuloDb {
  getCategories(businessId: string): Promise<DataRecord[]>
  createCategory(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateCategory(businessId: string, id: string, data: DataRecord): Promise<DatabaseResult>
  deleteCategory(businessId: string, id: string): Promise<DatabaseResult>
  productBelongsToBusiness(businessId: string, productId: string): Promise<boolean>
  getVariants(businessId: string): Promise<DataRecord[]>
  createVariant(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateVariant(businessId: string, id: string, data: DataRecord): Promise<DatabaseResult>
  deleteVariant(businessId: string, id: string): Promise<DatabaseResult>
}
const db: ModuloDb = require('../db') as typeof import('../db')

interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const guards = [auth.authClient, auth.requirePermission('catalogo')] as const

class InvalidCatalogInput extends Error {}

function textField(value: unknown, name: string, max: number, required = false): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new InvalidCatalogInput(`${name} es obligatorio`)
    return null
  }
  if (typeof value !== 'string') throw new InvalidCatalogInput(`${name} es inválido`)
  const clean = value.trim()
  if ((required && !clean) || clean.length > max) {
    throw new InvalidCatalogInput(`${name} es inválido`)
  }
  return clean || null
}

// Los límites replican los `check` de la base. Se comprueban aquí también para
// que el dueño vea un mensaje en su idioma y no un error de Postgres.
function sortField(value: unknown): number {
  const sort = value === undefined || value === null || value === '' ? 0 : Number(value)
  if (!Number.isInteger(sort) || sort < 0 || sort > 999) {
    throw new InvalidCatalogInput('El orden debe ser un número entre 0 y 999')
  }
  return sort
}

function priceField(value: unknown, name: string, required = false): number | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new InvalidCatalogInput(`${name} es obligatorio`)
    return null
  }
  const price = Number(value)
  if (!Number.isFinite(price) || price < 0 || price > 100_000) {
    throw new InvalidCatalogInput(`${name} debe estar entre 0 y 100000`)
  }
  return price
}

function sanitizeCategory(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidCatalogInput('Datos inválidos')
  }
  const source = body as DataRecord
  return {
    name: textField(source.name, 'El nombre', 60, true),
    description: textField(source.description, 'La descripción', 300),
    image_url: textField(source.image_url, 'La imagen', 500),
    image_public_id: textField(source.image_public_id, 'La imagen', 200),
    sort: sortField(source.sort),
    active: source.active !== false,
  }
}

function sanitizeVariant(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidCatalogInput('Datos inválidos')
  }
  const source = body as DataRecord
  const stock = source.stock === 'agotado' ? 'agotado' : 'disponible'
  const price = priceField(source.price, 'El precio', true)
  const priceSale = priceField(source.price_sale, 'El precio de oferta')
  // La base no lo comprueba, pero una oferta más cara que el precio normal es
  // un error de dedo que el cliente vería en la tienda.
  if (priceSale !== null && price !== null && priceSale > price) {
    throw new InvalidCatalogInput('El precio de oferta no puede superar al precio normal')
  }
  return {
    name: textField(source.name, 'El nombre', 60, true),
    price,
    price_sale: priceSale,
    stock,
    sort: sortField(source.sort),
    active: source.active !== false,
  }
}

function safeFailure(res: Response, operation: string, error: unknown) {
  if (error instanceof InvalidCatalogInput) {
    return res.status(400).json({ error: error.message })
  }
  console.error(`❌ ${operation}:`, error instanceof Error ? error.message : 'Error desconocido')
  return res.status(500).json({ error: `No se pudo ${operation}` })
}

// 23505 es el índice único: categoría repetida, o variante repetida en el
// mismo producto.
const isDuplicate = (result: DatabaseResult) => result.error?.code === '23505'

// ── Categorías ──────────────────────────────────────────────────────────────

router.get('/api/client/categories', ...guards, async (req, res) => {
  res.json(await db.getCategories(getClientBusinessId(req)))
})

router.post('/api/client/categories', ...guards, async (req, res) => {
  try {
    const result = await db.createCategory(getClientBusinessId(req), sanitizeCategory(req.body))
    if (isDuplicate(result)) {
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' })
    }
    if (result.error) throw new Error(result.error.message)
    res.status(201).json(result.data)
  } catch (error) {
    safeFailure(res, 'crear la categoría', error)
  }
})

router.put('/api/client/categories/:id', ...guards, async (req, res) => {
  try {
    const result = await db.updateCategory(
      getClientBusinessId(req), req.params.id, sanitizeCategory(req.body),
    )
    if (isDuplicate(result)) {
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' })
    }
    if (result.error) throw new Error(result.error.message)
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'actualizar la categoría', error)
  }
})

router.delete('/api/client/categories/:id', ...guards, async (req, res) => {
  try {
    const result = await db.deleteCategory(getClientBusinessId(req), req.params.id)
    if (result.error) throw new Error(result.error.message)
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'eliminar la categoría', error)
  }
})

// ── Variantes ───────────────────────────────────────────────────────────────
//
// Cuelgan de un producto ("mediana" de una pizza concreta), así que el
// product_id viaja en la petición… y por eso hay que comprobar de quién es.

router.get('/api/client/variants', ...guards, async (req, res) => {
  res.json(await db.getVariants(getClientBusinessId(req)))
})

router.post('/api/client/variants', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const productId = textField(
      (req.body as DataRecord)?.product_id, 'El producto', 100, true,
    ) as string
    // ⚠️ Sin esto, mandar el id de un producto ajeno colgaría la variante —con
    // su precio— del catálogo de otro negocio: la clave foránea apunta a
    // `products` sin mirar de quién es.
    if (!await db.productBelongsToBusiness(businessId, productId)) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }
    const result = await db.createVariant(businessId, {
      ...sanitizeVariant(req.body),
      product_id: productId,
    })
    if (isDuplicate(result)) {
      return res.status(409).json({ error: 'Ese producto ya tiene una variante con ese nombre' })
    }
    if (result.error) throw new Error(result.error.message)
    res.status(201).json(result.data)
  } catch (error) {
    safeFailure(res, 'crear la variante', error)
  }
})

router.put('/api/client/variants/:id', ...guards, async (req, res) => {
  try {
    // El producto de una variante no se cambia: se borra y se crea en el otro.
    // Permitirlo obligaría a revalidar pertenencia en cada edición sin ganar
    // nada que el dueño necesite.
    const result = await db.updateVariant(
      getClientBusinessId(req), req.params.id, sanitizeVariant(req.body),
    )
    if (isDuplicate(result)) {
      return res.status(409).json({ error: 'Ese producto ya tiene una variante con ese nombre' })
    }
    if (result.error) throw new Error(result.error.message)
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'actualizar la variante', error)
  }
})

router.delete('/api/client/variants/:id', ...guards, async (req, res) => {
  try {
    const result = await db.deleteVariant(getClientBusinessId(req), req.params.id)
    if (result.error) throw new Error(result.error.message)
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'eliminar la variante', error)
  }
})

export = router
