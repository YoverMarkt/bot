import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

interface ProductRecord {
  id: string
  name: string
  price: unknown
  price_sale?: unknown
  stock?: string | null
}

interface SessionRecord {
  contact_name?: unknown
}

interface OrderItemRecord {
  product_id?: unknown
  product_name?: unknown
  unit_price?: unknown
  quantity?: unknown
}

interface OrderRecord {
  contact_phone?: unknown
  status?: unknown
  order_items?: OrderItemRecord[]
}

interface SaleInputItem {
  product_id?: unknown
  product_name?: unknown
  quantity?: unknown
  unit_price?: unknown
}

interface NormalizedSaleItem {
  product_id: string
  quantity: number
}

interface SaleRecord extends Record<string, unknown> {
  id: string
}

interface DatabaseResult {
  error?: { message?: string } | null
}

class SaleValidationError extends Error {}

const db = require('../db') as {
  getProducts(businessId: string): Promise<ProductRecord[]>
  getSession(businessId: string, phone: string): Promise<SessionRecord | null>
  getOrders(businessId: string, limit: number): Promise<OrderRecord[]>
  createSaleWithItems(
    data: Record<string, unknown>,
    items: NormalizedSaleItem[],
  ): Promise<{
    data: SaleRecord
    error: { message: string } | null
  }>
  upsertSession(
    businessId: string,
    phone: string,
    data: { unread_owner: false },
  ): Promise<unknown>
  voidSale(businessId: string, saleId: string): Promise<DatabaseResult>
  getSalesByContact(businessId: string, phone: string): Promise<unknown>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}

const router = createRouter()
const canManageSales = auth.requirePermission('ventas')

router.get(
  '/api/client/sessions/:phone/quote',
  auth.authClient,
  canManageSales,
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const phone = decodeURIComponent(req.params.phone)
    try {
      const [products, session, orders] = await Promise.all([
        db.getProducts(businessId),
        db.getSession(businessId, phone),
        db.getOrders(businessId, 100),
      ])
      const lastOrder = (orders || []).find(order => (
        order.contact_phone === phone
        && ['pendiente', 'confirmado'].includes(order.status as string)
      ))
      const productsById = new Map(products.map(product => [product.id, product]))
      const suggested = (lastOrder?.order_items || []).flatMap(item => {
        const product = productsById.get(String(item.product_id || ''))
        if (!product || product.stock === 'agotado') return []
        return [{
          product_id: product.id,
          product_name: product.name,
          unit_price: Number(product.price_sale || product.price || 0),
          quantity: Math.min(99, Math.max(1, Number.parseInt(String(item.quantity)) || 1)),
        }]
      })

      res.json({
        contact_name: session?.contact_name || '',
        products: products.filter(product => product.stock !== 'agotado').map(product => ({
          id: product.id,
          name: product.name,
          price: Number(product.price_sale || product.price || 0),
        })),
        suggested,
      })
    } catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  },
)

router.post('/api/client/sales', auth.authClient, canManageSales, async (req, res) => {
  const businessId = getClientBusinessId(req)
  const user = req.user as Express.ClientUserClaims
  const { contact_phone, contact_name, items } = req.body as {
    contact_phone?: unknown
    contact_name?: unknown
    items?: SaleInputItem[]
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'La venta necesita al menos un ítem' })
  }

  try {
    const normalized: NormalizedSaleItem[] = items.map(item => {
      const productId = typeof item.product_id === 'string' ? item.product_id.trim() : ''
      const quantity = Number(item.quantity)
      if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw new SaleValidationError('Cada ítem necesita un producto y una cantidad entre 1 y 99')
      }
      return {
        product_id: productId,
        quantity,
      }
    })
    const { data: sale, error } = await db.createSaleWithItems({
      business_id: businessId,
      contact_phone: contact_phone || null,
      contact_name: contact_name || null,
      created_by: user.userId || null,
    }, normalized)
    if (error) {
      console.error('❌ registrar venta:', error.message || 'Error desconocido')
      return res.status(500).json({ error: 'No se pudo registrar la venta' })
    }
    if (contact_phone) {
      const sessionResult = await db.upsertSession(
        businessId,
        contact_phone as string,
        { unread_owner: false },
      ) as DatabaseResult
      if (sessionResult?.error) {
        console.error('❌ cerrar sesión después de venta:', sessionResult.error.message || 'Error desconocido')
      }
    }
    res.status(201).json(sale)
  } catch (error) {
    if (error instanceof SaleValidationError) {
      return res.status(400).json({ error: error.message })
    }
    console.error(
      '❌ registrar venta:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
    res.status(500).json({ error: 'No se pudo registrar la venta' })
  }
})

router.post(
  '/api/client/sales/:id/void',
  auth.authClient,
    canManageSales,
    async (req, res) => {
    try {
      const { error } = await db.voidSale(getClientBusinessId(req), req.params.id)
      if (error) {
        console.error('❌ anular venta:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No se pudo anular la venta' })
      }
      res.json({ ok: true })
    } catch (error) {
      console.error(
        '❌ anular venta:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      res.status(500).json({ error: 'No se pudo anular la venta' })
    }
  },
)

router.get('/api/client/sales', auth.authClient, canManageSales, async (req, res) => {
  const phone = req.query.phone ? decodeURIComponent(String(req.query.phone)) : null
  if (!phone) return res.json([])
  res.json(await db.getSalesByContact(getClientBusinessId(req), phone))
})

export = router
