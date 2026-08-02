import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'
import type { WriteResult } from '../db/types'

type ProductRecord = Record<string, unknown> & {
  id: string
  business_id: string
  image_public_id?: string | null
  video_public_id?: string | null
}

const db: {
  getProducts(businessId: string): Promise<unknown>
  createProduct(businessId: string, data: Record<string, unknown>): Promise<WriteResult<ProductRecord>>
  getProductById(businessId: string, productId: string): Promise<ProductRecord | null>
  updateProduct(
    businessId: string,
    productId: string,
    data: Record<string, unknown>,
  ): Promise<unknown>
  deleteProduct(businessId: string, productId: string): Promise<unknown>
  getProductsWithoutEmbedding(businessId: string): Promise<ProductRecord[]>
  getCategories(businessId: string): Promise<{ id: string }[]>
} = require('../db') as typeof import('../db')
const bot: {
  indexProduct(product: ProductRecord): Promise<unknown>
} = require('../services/bot-entry') as typeof import('../services/bot-entry')
const cloud: {
  deleteMedia(publicId: string, resourceType: 'image' | 'video'): Promise<unknown>
} = require('../integrations/cloudinary') as typeof import('../integrations/cloudinary')
const auth: {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
} = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const canManageCatalog = auth.requirePermission('catalogo')

/**
 * Deja `category_id` solo si la categoría es de este negocio.
 *
 * ⚠️ La clave foránea de `products.category_id` apunta a `product_categories`
 * SIN mirar de quién es, y el cuerpo de la petición entra tal cual. Sin esta
 * comprobación, mandar el uuid de la categoría de otro negocio guardaría una
 * referencia cruzada entre inquilinos.
 *
 * Una categoría desconocida se limpia a null en vez de rechazar la petición:
 * el producto es válido, solo queda sin agrupar.
 */
async function safeCategoryId(businessId: string, value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim()) return null
  const propias = await db.getCategories(businessId)
  return propias.some(categoria => categoria.id === value) ? value : null
}

router.get('/api/client/products', auth.authClient, async (req, res) => {
  res.json(await db.getProducts(getClientBusinessId(req)))
})

router.post('/api/client/products', auth.authClient, canManageCatalog, async (req, res) => {
  const { name, price } = req.body as { name?: unknown; price?: unknown }
  if (!name || !price) {
    return res.status(400).json({ error: 'Nombre y precio requeridos' })
  }

  const businessId = getClientBusinessId(req)
  const productData = { ...req.body } as Record<string, unknown>
  delete productData.id
  delete productData.business_id
  delete productData.created_at
  const { data, error } = await db.createProduct(businessId, {
    ...productData,
    price: Number.parseFloat(String(price)),
    category_id: await safeCategoryId(businessId, productData.category_id),
  })
  if (error) return res.status(500).json({ error: error.message })

  void bot.indexProduct(data).catch(() => {})
  res.status(201).json(data)
})

router.put('/api/client/products/:id', auth.authClient, canManageCatalog, async (req, res) => {
  const businessId = getClientBusinessId(req)
  const previous = await db.getProductById(businessId, req.params.id)
  if (!previous || previous.business_id !== businessId) {
    return res.status(404).json({ error: 'No encontrado' })
  }

  await db.updateProduct(businessId, req.params.id, {
    ...req.body as Record<string, unknown>,
    ...('category_id' in (req.body || {})
      ? { category_id: await safeCategoryId(businessId, req.body.category_id) }
      : {}),
  })
  if (previous) {
    if (previous.image_public_id && req.body.image_public_id !== previous.image_public_id) {
      void cloud.deleteMedia(previous.image_public_id, 'image')
    }
    if (previous.video_public_id && req.body.video_public_id !== previous.video_public_id) {
      void cloud.deleteMedia(previous.video_public_id, 'video')
    }
  }

  void db.getProductById(businessId, req.params.id)
    .then(product => product && bot.indexProduct(product))
    .catch(() => {})
  res.json({ ok: true })
})

router.delete('/api/client/products/:id', auth.authClient, canManageCatalog, async (req, res) => {
  await db.deleteProduct(getClientBusinessId(req), req.params.id)
  res.json({ ok: true })
})

router.post('/api/client/reindex', auth.authClient, canManageCatalog, async (req, res) => {
  try {
    const pending = await db.getProductsWithoutEmbedding(getClientBusinessId(req))
    res.json({
      ok: true,
      pending: pending.length,
      message: pending.length
        ? `Indexando ${pending.length} productos en segundo plano…`
        : 'Todos los productos ya están indexados ✓',
    })

    for (const product of pending) {
      await bot.indexProduct(product)
    }
    if (pending.length) console.log(`✅ [reindex] ${pending.length} productos indexados`)
  } catch (error) {
    console.error('❌ reindex:', (error as Error).message)
  }
})

export = router
