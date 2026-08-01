import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import { requireStorefrontSession } from '../middleware/storefront'
import {
  buildStorefrontCatalog,
  canOrder,
  publicBusiness,
  storefrontStatus,
  type StorefrontBusiness,
} from '../services/storefront'

// Rutas de la mini app del negocio.
//
// ⚠️ SON PÚBLICAS: no hay JWT. La credencial es el enlace que mandó el bot, y
// la valida `requireStorefrontSession`. Todo lo que no sea la portada exige
// sesión, y la portada no revela nada que no esté ya en el WhatsApp del local.
//
// El precio JAMÁS llega del cliente: la app manda ids y cantidades, y la RPC
// resuelve cada importe desde la base (regla inviolable #8).

interface StorefrontRouteDatabase {
  getBusinessBySlug(slug: string): Promise<StorefrontBusiness | null>
  getSchedule(businessId: string): Promise<unknown[]>
  getStorefrontCategories(businessId: string): Promise<unknown[]>
  getStorefrontProducts(businessId: string): Promise<unknown[]>
  getStorefrontVariants(businessId: string): Promise<unknown[]>
  getStorefrontExtras(businessId: string): Promise<unknown[]>
  getBusinessBankAccount(businessId: string): Promise<unknown>
  getCustomerAddresses(businessId: string, customerId: string): Promise<unknown[]>
  createCustomerAddress(input: Record<string, unknown>): Promise<unknown>
  getBusinessCustomer(businessId: string, customerId: string): Promise<unknown>
  createStorefrontOrder(input: Record<string, unknown>): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
}

const db = require('../db') as StorefrontRouteDatabase
const schedule = require('../services/schedule') as {
  isOutsideHours(schedule: unknown[]): boolean
}

const router = createRouter()

// Un enlace legítimo no necesita 200 peticiones por minuto. Frena el raspado
// del catálogo y los intentos de probar tokens a lo bruto.
const storeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, espera un momento' },
})

// Crear pedidos es mucho más caro y nadie pide 30 veces por minuto.
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de pedido, espera un momento' },
})

router.use('/api/store', storeLimiter)

const readStatus = async (business: StorefrontBusiness | null) => {
  if (!business?.id) return { status: storefrontStatus({ business: null, outsideHours: false }) }
  const businessSchedule = await db.getSchedule(business.id).catch(() => [])
  const outsideHours = schedule.isOutsideHours(businessSchedule || [])
  return { status: storefrontStatus({ business, outsideHours }), outsideHours }
}

// ── Portada: lo único que se ve sin enlace ─────────────────────────────────
// Quien reciba un enlace reenviado cae aquí: ve el nombre del negocio y su
// WhatsApp para pedir el suyo. Nada más: ni catálogo, ni precios, ni clientes.
router.get('/api/store/:slug', async (req, res) => {
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  const { status } = await readStatus(business)
  if (!business?.id || status === 'no_disponible') {
    return res.status(404).json({ error: 'Esta tienda no está disponible' })
  }
  return res.json({
    business: publicBusiness(business),
    status,
    canOrder: canOrder(status),
  })
})

// ── De aquí en adelante hace falta el enlace ───────────────────────────────

router.get('/api/store/:slug/catalog', requireStorefrontSession, async (req, res) => {
  const { businessId } = req.storefront!
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  const { status } = await readStatus(business)

  const [categories, products, variants, extras] = await Promise.all([
    db.getStorefrontCategories(businessId),
    db.getStorefrontProducts(businessId),
    db.getStorefrontVariants(businessId),
    db.getStorefrontExtras(businessId),
  ])

  return res.json({
    business: business ? publicBusiness(business) : null,
    status,
    canOrder: canOrder(status),
    ...buildStorefrontCatalog({
      categories: categories as never,
      products: products as never,
      variants: variants as never,
      extras: extras as never,
    }),
  })
})

/** Quién es el cliente y qué direcciones tiene guardadas EN ESTE negocio. */
router.get('/api/store/:slug/me', requireStorefrontSession, async (req, res) => {
  const { businessId, customerId, contactPhone } = req.storefront!
  const [addresses, relation] = await Promise.all([
    db.getCustomerAddresses(businessId, customerId),
    db.getBusinessCustomer(businessId, customerId),
  ])
  return res.json({
    // Se devuelve enmascarado: la app solo necesita confirmar "a nombre de…".
    phone: `•••• ${contactPhone.slice(-4)}`,
    name: (relation as { display_name?: string } | null)?.display_name || null,
    addresses,
  })
})

router.post('/api/store/:slug/addresses', requireStorefrontSession, async (req, res) => {
  const { businessId, customerId } = req.storefront!
  const body = (req.body || {}) as Record<string, unknown>
  const address = String(body.address || '').trim()
  if (address.length < 5 || address.length > 300) {
    return res.status(400).json({ error: 'La dirección no es válida' })
  }
  const created = await db.createCustomerAddress({
    businessId,
    customerId,
    label: String(body.label || 'Casa').slice(0, 40),
    address,
    reference: String(body.reference || '').slice(0, 300) || null,
    isDefault: body.isDefault === true,
  })
  return res.status(201).json(created)
})

// ── Pedido ─────────────────────────────────────────────────────────────────
router.post('/api/store/:slug/orders', orderLimiter, requireStorefrontSession, async (req, res) => {
  const { businessId, customerId, contactPhone } = req.storefront!
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  const { status } = await readStatus(business)

  // Cerrado: se puede mirar, no pedir.
  if (!canOrder(status)) {
    return res.status(409).json({
      error: status === 'cerrada'
        ? 'El negocio está cerrado ahora mismo'
        : 'Esta tienda no está recibiendo pedidos',
      status,
    })
  }

  const body = (req.body || {}) as Record<string, unknown>
  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) {
    return res.status(400).json({ error: 'El pedido no tiene productos' })
  }

  // Se reconstruye la lista dejando fuera cualquier precio que mande la app:
  // aquí solo viajan ids y cantidades.
  const safeItems = items.slice(0, 50).map((raw) => {
    const item = (raw || {}) as Record<string, unknown>
    return {
      product_id: String(item.productId || item.product_id || ''),
      variant_id: String(item.variantId || item.variant_id || '') || null,
      extra_ids: (Array.isArray(item.extraIds) ? item.extraIds : [])
        .slice(0, 20)
        .map(id => String(id)),
      quantity: Number(item.quantity) || 0,
      note: String(item.note || '').slice(0, 200) || null,
    }
  })

  const fulfillment = ['delivery', 'pickup', 'onsite'].includes(String(body.fulfillment))
    ? String(body.fulfillment)
    : null

  const result = await db.createStorefrontOrder({
    businessId,
    customerId,
    contactPhone,
    contactName: String(body.name || '').slice(0, 120) || null,
    addressId: String(body.addressId || '') || null,
    fulfillment,
    items: safeItems,
  })

  if (result.error) {
    // 42501 es pertenencia (producto ajeno, dirección de otro): no es un fallo
    // del servidor, es un pedido que no debía existir.
    const code = result.error.code === '42501' ? 403 : 400
    return res.status(code).json({ error: result.error.message || 'No se pudo crear el pedido' })
  }
  return res.status(201).json(result.data)
})

/** Datos bancarios para transferir. Solo con sesión y solo del propio negocio. */
router.get('/api/store/:slug/payment-info', requireStorefrontSession, async (req, res) => {
  const account = await db.getBusinessBankAccount(req.storefront!.businessId)
  if (!account) return res.status(404).json({ error: 'El negocio no tiene datos de pago cargados' })
  return res.json(account)
})

export = router
