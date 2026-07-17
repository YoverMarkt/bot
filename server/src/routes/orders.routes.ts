import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

const db = require('../db') as {
  getOrders(businessId: string): Promise<unknown>
  setOrderStatus(
    businessId: string,
    orderId: string,
    status: string,
  ): Promise<{ data?: unknown; error?: { message?: string } | null }>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}

const router = createRouter()

router.get(
  '/api/client/orders',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    // authClient garantiza estos claims; nunca se acepta businessId del request.
    const businessId = getClientBusinessId(req)
    res.json(await db.getOrders(businessId))
  },
)

router.put(
  '/api/client/orders/:id/status',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const status = (req.body as { status?: unknown })?.status
    if (!['confirmado', 'completado', 'cancelado', 'expirado'].includes(String(status))) {
      return res.status(400).json({
        error: 'El estado debe ser confirmado, completado, cancelado o expirado',
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
        result?: 'updated' | 'not_found' | 'invalid_transition'
        order?: unknown
      } | null
      if (result?.result === 'not_found') {
        return res.status(404).json({ error: 'Pedido no encontrado' })
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
