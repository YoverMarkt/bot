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
