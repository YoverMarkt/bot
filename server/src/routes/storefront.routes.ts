import rateLimit from 'express-rate-limit'
import multer from 'multer'
import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import type { ScheduleRecord } from '../db/types'
import { MEDIA_LIMITS, mapMulterError, validateMediaFile } from '../lib/media'
import { isConfigured, uploadMedia } from '../integrations/cloudinary'
import { requireStorefrontSession } from '../middleware/storefront'
import { checkSession, deviceFingerprint, hashToken, phoneMatchesSession } from '../services/storefront-session'
import {
  buildStorefrontCatalog,
  canOrder,
  publicBusiness,
  storefrontCapabilities,
  storefrontStatus,
  type StorefrontBusiness,
} from '../services/storefront'
import {
  quoteLodging,
  requestLodging,
  LodgingServiceError,
  type LodgingErrorCode,
} from '../services/lodging'

// Rutas de la mini app del negocio.
//
// ⚠️ SON PÚBLICAS: no hay JWT. La credencial es el enlace que mandó el bot, y
// la valida `requireStorefrontSession`. Todo lo que no sea la portada exige
// sesión, y la portada no revela nada que no esté ya en el WhatsApp del local.
//
// El precio JAMÁS llega del cliente: la app manda ids y cantidades, y la RPC
// resuelve cada importe desde la base (regla inviolable #8).

/** La fila de sesión, con lo que necesitan la redirección y la verificación. */
interface StorefrontSessionRow {
  id: string
  business_id: string
  customer_id: string
  contact_phone: string
  device_hash: string | null
  claimed_at: string | null
  expires_at: string | null
  revoked_at: string | null
  verified_at?: string | null
}

interface StorefrontRouteDatabase {
  getBusinessBySlug(slug: string): Promise<StorefrontBusiness | null>
  getBusinessById(businessId: string): Promise<{ slug?: string | null } | null>
  getStorefrontSessionByHash(tokenHash: string): Promise<StorefrontSessionRow | null>
  bindStorefrontSession(sessionId: string, deviceHash: string): Promise<boolean>
  getSchedule(businessId: string): Promise<ScheduleRecord[]>
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
  attachStorefrontPaymentProof(input: Record<string, unknown>): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
}

const db: StorefrontRouteDatabase = require('../db') as typeof import('../db')
const schedule: {
  isOutsideHours(schedule: ScheduleRecord[] | null | undefined, now?: Date): boolean
} = require('../services/schedule') as typeof import('../services/schedule')

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
router.use('/s', storeLimiter)

// ── Enlace corto: /s/<token> ───────────────────────────────────────────────
//
// Lo que el bot manda por WhatsApp. Existe por una razón de producto, no
// técnica: el enlace completo medía unos 130 caracteres y en un chat eso se
// lee como spam. Aquí solo viaja el token, que ya identifica al negocio.
//
// No devuelve datos NUNCA, solo redirige — por eso no lleva sesión: quien
// llegue con un token inventado no averigua nada, y quien llegue con el suyo
// ya lo tenía. La sesión se sigue validando entera al pedir el catálogo.
router.get('/s/:code', async (req, res) => {
  const code = String(req.params.code || '').trim()
  if (code) {
    const session = await db.getStorefrontSessionByHash(hashToken(code)).catch(() => null)
    if (session?.business_id) {
      const business = await db.getBusinessById(session.business_id).catch(() => null)
      if (business?.slug) {
        // Se conserva el token en el destino: la tienda lo lee y lo borra de la
        // barra de direcciones.
        return res.redirect(
          302,
          `/t/${encodeURIComponent(business.slug)}?s=${encodeURIComponent(code)}`,
        )
      }
    }
  }
  // Token desconocido: la tienda explicará que hace falta pedir uno propio.
  return res.redirect(302, '/t/_')
})

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

// ── Confirmar el número: la puerta del enlace ──────────────────────────────
//
// El enlace ya no caduca, así que lo que lo protege es esto: para usarlo hay
// que saber a qué número de WhatsApp se emitió.
//
// Antes bastaba con abrirlo primero. Quien reenviaba el enlace ANTES de
// abrirlo se lo regalaba al primero que hiciera clic, y el cliente legítimo se
// quedaba fuera de su propia tienda.
//
// NO lleva `requireStorefrontSession` a propósito: ese middleware rechaza
// justo el estado en el que se llega aquí (`necesita_telefono`).
const verifyLimiter = rateLimit({
  // Mucho más estrecho que el resto de la tienda: aquí se adivinan teléfonos.
  // Ocho intentos por minuto bastan para quien se equivoca escribiendo y no
  // para quien prueba números en serie.
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, espera un momento' },
})

router.post('/api/store/:slug/session/verify', verifyLimiter, async (req, res) => {
  const token = String(
    req.headers['x-storefront-token']
    || (req.body as { token?: unknown } | null)?.token
    || '',
  ).trim()
  const telefono = String((req.body as { phone?: unknown } | null)?.phone || '').trim()
  if (!token || !telefono) {
    return res.status(400).json({ error: 'Falta el número' })
  }

  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  if (!business?.id) return res.status(404).json({ error: 'Esta tienda no está disponible' })

  const session = await db.getStorefrontSessionByHash(hashToken(token))
  const veredicto = checkSession({
    session: session as never,
    deviceHash: '',
    expectedBusinessId: business.id,
  })
  // Solo se sigue si lo único que falta es el número. Una sesión revocada, de
  // otro negocio o inexistente se rechaza igual que en el resto de la tienda.
  if (!veredicto.session || (veredicto.reason && veredicto.reason !== 'necesita_telefono')) {
    return res.status(401).json({ error: 'Este enlace no es válido', reason: veredicto.reason })
  }

  if (!phoneMatchesSession(veredicto.session.contact_phone, telefono)) {
    // Mismo texto para "no coincide" que para "no existe": quien prueba
    // números no debe poder distinguir un fallo de otro.
    return res.status(401).json({
      error: 'Ese número no coincide con este enlace',
      reason: 'necesita_telefono',
    })
  }

  const deviceHash = deviceFingerprint({
    clientId: typeof req.headers['x-storefront-device'] === 'string'
      ? req.headers['x-storefront-device']
      : '',
    userAgent: req.headers['user-agent'] || '',
    acceptLanguage: req.headers['accept-language'] || '',
  })
  const atada = await db.bindStorefrontSession(veredicto.session.id, deviceHash)
  if (!atada) return res.status(500).json({ error: 'No pudimos confirmar tu número' })

  return res.json({ ok: true })
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

  // La tarjeta no está: la plataforma no procesa cobros (regla inviolable #6).
  const paymentMethod = ['transferencia', 'efectivo'].includes(String(body.paymentMethod))
    ? String(body.paymentMethod)
    : null

  const result = await db.createStorefrontOrder({
    businessId,
    customerId,
    contactPhone,
    contactName: String(body.name || '').slice(0, 120) || null,
    addressId: String(body.addressId || '') || null,
    fulfillment,
    paymentMethod,
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

// ── Comprobante de la transferencia ────────────────────────────────────────
//
// Es OPCIONAL a propósito: el pedido ya está creado cuando se llega aquí, así
// que un cliente que no encuentra la foto no pierde su pedido.
//
// La imagen la sube el SERVIDOR a Cloudinary. La app nunca ve credenciales, y
// la URL que se guarda es la que devuelve Cloudinary, no una que mande el
// teléfono: si no, cualquiera colgaría un enlace arbitrario en el pedido.
const proofUpload: RequestHandler = (req, res, next) => {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_LIMITS.image } })
    .single('file')(req, res, error => {
      if (error) {
        const mapped = mapMulterError(error)
        return res.status(mapped.status).json({ error: mapped.error })
      }
      next()
    })
}

router.post(
  '/api/store/:slug/orders/:id/proof',
  orderLimiter,
  requireStorefrontSession,
  proofUpload,
  async (req, res) => {
    const { businessId, contactPhone } = req.storefront!
    if (!req.file) return res.status(400).json({ error: 'No se recibió el comprobante' })

    const invalido = validateMediaFile(req.file)
    if (invalido) return res.status(invalido.status).json({ error: invalido.error })
    if (!req.file.mimetype?.startsWith('image/')) {
      return res.status(400).json({ error: 'El comprobante debe ser una imagen' })
    }
    if (!(await isConfigured())) {
      return res.status(503).json({ error: 'El negocio no puede recibir comprobantes ahora mismo' })
    }

    try {
      const subida = await uploadMedia(req.file.buffer, businessId)
      const { data, error } = await db.attachStorefrontPaymentProof({
        businessId,
        orderId: String(req.params.id || ''),
        contactPhone,
        url: subida.url,
      })
      if (error) {
        console.error('❌ comprobante:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No pudimos guardar tu comprobante' })
      }
      const resultado = (data || {}) as { result?: string }
      if (resultado.result === 'not_found') {
        return res.status(404).json({ error: 'Ese pedido no es tuyo o ya no existe' })
      }
      if (resultado.result === 'invalid_state') {
        return res.status(409).json({ error: 'Ese pedido ya está cerrado' })
      }
      return res.json({ ok: true, url: subida.url })
    } catch (error) {
      console.error('❌ comprobante:', (error as Error).message)
      return res.status(500).json({ error: 'No pudimos subir tu comprobante' })
    }
  },
)

// ── Hospedaje ──────────────────────────────────────────────────────────────
//
// Una estadía NO es un pedido y por eso no pasa por el carrito: no se piden
// "2 habitaciones" como se piden 2 pizzas, se piden noches concretas y el
// servidor decide qué cabe. Se reutilizan `quoteLodging`/`requestLodging`, las
// mismas del bot: una sola fuente de verdad para disponibilidad y precios.

const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas consultas, espera un momento' },
})

/** Traduce el error del servicio a algo que el huésped entienda. */
const lodgingMessage = (code: LodgingErrorCode): { status: number; error: string } => {
  switch (code) {
    case 'unavailable':
      return { status: 409, error: 'No hay disponibilidad para esas fechas' }
    case 'quote_expired':
      return { status: 409, error: 'La cotización expiró, vuelve a consultar las fechas' }
    case 'quote_not_found':
      return { status: 409, error: 'Primero consulta disponibilidad para esas fechas' }
    case 'room_type_not_found':
      return { status: 404, error: 'Esa habitación no está en la cotización' }
    case 'manual_quote':
      // Rule #8: sin precio automático NO se muestra ningún total inventado.
      return { status: 409, error: 'Esta opción necesita cotización manual, escríbenos por WhatsApp' }
    case 'lodging_disabled':
      return { status: 409, error: 'Este negocio no recibe reservas por aquí' }
    case 'invalid_input':
      return { status: 400, error: 'Revisa las fechas y el número de huéspedes' }
    default:
      return { status: 500, error: 'No pudimos consultar la disponibilidad' }
  }
}

/** Estado y capacidades del negocio de la URL. Compartido por cotizar y pedir. */
const lodgingGuard = async (slug: string) => {
  const business = await db.getBusinessBySlug(slug.trim())
  const { status } = await readStatus(business)
  return { business, status, capabilities: storefrontCapabilities(business) }
}

router.post('/api/store/:slug/stay/quote', quoteLimiter, requireStorefrontSession, async (req, res) => {
  const { businessId, contactPhone } = req.storefront!
  const { status, capabilities } = await lodgingGuard(String(req.params.slug || ""))
  if (!capabilities.lodging) {
    return res.status(409).json({ error: 'Este negocio no ofrece hospedaje' })
  }

  const body = (req.body || {}) as Record<string, unknown>
  const entero = (value: unknown, fallback: number) => {
    const parsed = Number.parseInt(String(value ?? ''), 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  try {
    const quote = await quoteLodging({
      businessId,
      // El teléfono sale de la sesión, jamás del cuerpo: así nadie cotiza
      // —ni luego reclama— a nombre de otro huésped.
      contactPhone,
      checkIn: String(body.checkIn || '').trim(),
      checkOut: String(body.checkOut || '').trim(),
      adults: entero(body.adults, 1),
      children: entero(body.children, 0),
      roomsCount: entero(body.rooms, 1),
    })

    // Igual que el bot: solo se muestra lo que de verdad tiene cupo, y sin
    // total automático no se pinta precio alguno.
    const options = quote.options.filter(option => (
      Number.isInteger(option.availableUnits)
      && Number.isInteger(option.unitsRequired)
      && option.unitsRequired > 0
      && option.availableUnits >= option.unitsRequired
    ))

    return res.json({
      ...quote,
      options,
      status,
      // Se puede mirar con el negocio cerrado; solicitar es otra cosa.
      canRequest: canOrder(status),
    })
  } catch (error) {
    const code = error instanceof LodgingServiceError
      ? error.code
      : 'database_error'
    const { status: httpStatus, error: message } = lodgingMessage(code)
    return res.status(httpStatus).json({ error: message, code })
  }
})

router.post('/api/store/:slug/stay/request', orderLimiter, requireStorefrontSession, async (req, res) => {
  const { businessId, contactPhone } = req.storefront!
  const { status, capabilities } = await lodgingGuard(String(req.params.slug || ""))
  if (!capabilities.lodging) {
    return res.status(409).json({ error: 'Este negocio no ofrece hospedaje' })
  }
  if (!canOrder(status)) {
    return res.status(409).json({
      error: status === 'cerrada'
        ? 'El negocio está cerrado ahora mismo'
        : 'Esta tienda no está recibiendo solicitudes',
      status,
    })
  }

  const body = (req.body || {}) as Record<string, unknown>
  const roomTypeId = String(body.roomTypeId || '').trim()
  const contactName = String(body.name || '').trim().slice(0, 120)
  if (!roomTypeId) return res.status(400).json({ error: 'Elige una habitación' })
  if (contactName.length < 2) {
    return res.status(400).json({ error: 'Necesitamos el nombre de quien se hospeda' })
  }

  const result = await requestLodging({
    businessId,
    contactPhone,
    contactName,
    roomTypeId,
    notes: String(body.notes || '').slice(0, 300) || null,
  })

  if (!result.ok) {
    const { status: httpStatus, error: message } = lodgingMessage(result.error.code)
    return res.status(httpStatus).json({ error: message, code: result.error.code })
  }

  // Es una RETENCIÓN, no una reserva confirmada: el equipo confirma a mano y
  // coordina el pago. La app debe decirlo con todas sus letras.
  return res.status(201).json({ ...result.request, confirmed: false })
})

export = router
