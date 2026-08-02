import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

// Estados que hoy acepta orders.status. El GET puede filtrar por cualquiera
// (la vigilancia del panel consulta «pendiente»); el PUT no acepta volver a
// «pendiente» porque es el estado inicial, nunca un destino.
const ESTADOS_PEDIDO = [
  'pendiente', 'confirmado', 'preparacion', 'en_camino',
  'completado', 'cancelado', 'expirado',
] as const
const ESTADOS_DESTINO = ESTADOS_PEDIDO.filter(estado => estado !== 'pendiente')

interface ModuloDb {
  createOrder(
    order: Record<string, unknown>,
    items: Record<string, unknown>[],
  ): Promise<{ data?: unknown; error?: { message?: string; code?: string } | null }>
  getOrders(businessId: string, limit?: number, status?: string | null): Promise<unknown>
  setOrderStatus(
    businessId: string,
    orderId: string,
    status: string,
  ): Promise<{ data?: unknown; error?: { message?: string } | null }>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()

router.get(
  '/api/client/orders',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    // authClient garantiza estos claims; nunca se acepta businessId del request.
    const businessId = getClientBusinessId(req)
    const status = req.query.status === undefined ? null : String(req.query.status)
    if (status !== null && !ESTADOS_PEDIDO.includes(status as typeof ESTADOS_PEDIDO[number])) {
      return res.status(400).json({ error: 'Estado de pedido inválido' })
    }
    res.json(await db.getOrders(businessId, 100, status))
  },
)

// ── Pedido de mostrador ────────────────────────────────────────────────────
//
// Lo que se vende en persona, por el MISMO camino que el resto: nace entregado
// y la propia función de base de datos le crea la venta. Antes esto era un
// segundo camino («Registrar venta») y por eso el dinero entraba de dos formas
// distintas.
//
// El precio NO viaja: se mandan ids y cantidades y la RPC resuelve cada
// importe del catálogo (regla inviolable #8).
router.post(
  '/api/client/orders',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) {
      return res.status(400).json({ error: 'El pedido no tiene productos' })
    }

    const lineas = items.slice(0, 50).map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>
      return {
        product_id: String(item.product_id ?? item.productId ?? ''),
        quantity: Number(item.quantity) || 0,
      }
    })
    if (lineas.some(linea => !linea.product_id || linea.quantity < 1)) {
      return res.status(400).json({ error: 'Cada línea necesita un producto y una cantidad' })
    }

    const telefono = String(body.contact_phone ?? '').trim()
    try {
      const { data, error } = await db.createOrder(
        {
          business_id: getClientBusinessId(req),
          // Sin teléfono es una venta de paso. El literal lo convierte a nulo
          // la propia base al crear la venta, para no inventar un cliente.
          contact_phone: telefono || 'mostrador',
          contact_name: String(body.contact_name ?? '').trim().slice(0, 120) || null,
          status: 'completado',
          currency: 'USD',
          source: 'manual',
        },
        lineas,
      )
      if (error) {
        // 42501 y 40001 son del catálogo (producto ajeno, precio movido): es
        // un pedido que no debía existir, no un fallo del servidor.
        const codigo = ['42501', '40001'].includes(String(error.code)) ? 409 : 400
        return res.status(codigo).json({ error: error.message || 'No se pudo registrar el pedido' })
      }
      return res.status(201).json(data)
    } catch (error) {
      console.error('❌ pedido de mostrador:', error instanceof Error ? error.message : 'Error')
      return res.status(500).json({ error: 'No se pudo registrar el pedido' })
    }
  },
)

router.put(
  '/api/client/orders/:id/status',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const status = (req.body as { status?: unknown })?.status
    if (!ESTADOS_DESTINO.includes(String(status) as typeof ESTADOS_DESTINO[number])) {
      // Del mismo sitio que la validación: añadir un estado no puede dejar el
      // mensaje mintiendo sobre cuáles se aceptan.
      return res.status(400).json({
        error: `El estado debe ser ${ESTADOS_DESTINO.join(', ')}`,
      })
    }
    try {
      const { data, error } = await db.setOrderStatus(
        getClientBusinessId(req),
        req.params.id,
        String(status),
      )
      if (error) {
        console.error('❌ actualizar pedido:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No se pudo actualizar el pedido' })
      }
      const result = data as {
        result?: 'updated' | 'not_found' | 'invalid_transition' | 'not_deliverable'
        order?: unknown
      } | null
      if (result?.result === 'not_found') {
        return res.status(404).json({ error: 'Pedido no encontrado' })
      }
      if (result?.result === 'not_deliverable') {
        return res.status(409).json({
          error: 'Este pedido es para retirar en el local: no puede salir a reparto',
        })
      }
      if (result?.result === 'invalid_transition') {
        return res.status(409).json({ error: 'Ese cambio ya no es válido para el estado actual del pedido' })
      }
      if (result?.result !== 'updated') {
        return res.status(500).json({ error: 'La base de datos devolvió una respuesta inválida' })
      }
      res.json(result.order)
    } catch (error) {
      console.error(
        '❌ actualizar pedido:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      res.status(500).json({ error: 'No se pudo actualizar el pedido' })
    }
  },
)

export = router
