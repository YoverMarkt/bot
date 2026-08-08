import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'
import { signedMediaUrl } from '../integrations/cloudinary'
import { notificarPedidoEnPreparacion, type PedidoParaAvisar } from '../services/order-notify'
import type { BusinessRecord } from '../db/types'

// Estados que hoy acepta orders.status. El GET puede filtrar por cualquiera
// (la vigilancia del panel consulta «pendiente»); el PUT no acepta volver a
// «pendiente» porque es el estado inicial, nunca un destino.
//
// ⚠️ Esta lista es el TERCER sitio donde viven los estados, además del CHECK de
// `orders` y del tipo del panel. Quedarse corta aquí es especialmente traidor:
// el botón existe en el panel, el dueño lo toca, y esta ruta lo rechaza con un
// «estado no válido» que no explica nada. Lo vigila `estados-pedido.test.js`.
const ESTADOS_PEDIDO = [
  'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
  'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
  'cancelado', 'rechazado', 'expirado',
] as const
const ESTADOS_DESTINO = ESTADOS_PEDIDO.filter(estado => estado !== 'pendiente')

interface ModuloDb {
  createOrder(
    order: Record<string, unknown>,
    items: Record<string, unknown>[],
  ): Promise<{ data?: unknown; error?: { message?: string; code?: string } | null }>
  getOrders(
    businessId: string,
    limit?: number,
    status?: string | string[] | null,
  ): Promise<unknown>
  getOrderProof(businessId: string, orderId: string): Promise<{
    payment_proof_url?: string | null
    payment_proof_public_id?: string | null
  } | null>
  setOrderStatus(
    businessId: string,
    orderId: string,
    status: string,
  ): Promise<{ data?: unknown; error?: { message?: string } | null }>
  confirmOrderPayment(
    businessId: string,
    orderId: string,
  ): Promise<{ id: string; status: string; payment_confirmed_at: string } | null>
  claimOrderNotification(
    businessId: string,
    orderId: string,
  ): Promise<PedidoParaAvisar | null>
  getBusinessById(id: string): Promise<BusinessRecord | null>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()

/**
 * Le avisa al cliente por su canal que el pedido entró en preparación.
 *
 * **Nunca lanza, y por eso no se comprueba lo que devuelve.** Corre cuando el
 * estado YA cambió: la comanda está en la cocina. Si el aviso falla —fuera de
 * la ventana de 24 h de Meta, sin saldo, canal caído— el fallo va al registro
 * de errores y el dueño recibe su respuesta correcta igualmente. Convertir
 * esto en un 500 le diría que el pedido no arrancó cuando sí arrancó.
 */
const avisarAlCliente = async (businessId: string, orderId: string): Promise<void> => {
  try {
    // Se RECLAMA el aviso antes de redactarlo: el reclamo es atómico y solo lo
    // gana quien de verdad avisa. `set_order_status` responde `updated`
    // también cuando el estado ya era ese, así que sin esto un segundo toque
    // en «Aceptar y preparar» mandaría un segundo mensaje — y desde octubre,
    // lo cobraría dos veces.
    const pedido = await db.claimOrderNotification(businessId, orderId)
    if (!pedido) return

    const negocio = await db.getBusinessById(businessId)
    if (!negocio) return
    await notificarPedidoEnPreparacion(negocio, pedido)
  } catch (error) {
    console.error(
      '⚠️  aviso de pedido en preparación:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
  }
}

// ── Ver el comprobante de una transferencia ────────────────────────────────
//
// El comprobante ya NO vive en una URL pública: es un movimiento bancario de
// un cliente real, con su nombre y su cuenta. Aquí se firma un acceso temporal
// —diez minutos— y solo para el dueño del negocio al que pertenece el pedido.
//
// Si la captura del panel acaba en un chat, el enlace ya no sirve.
router.get(
  '/api/client/orders/:id/proof',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const pedido = await db.getOrderProof(businessId, String(req.params.id || ''))
    if (!pedido) return res.status(404).json({ error: 'Ese pedido no existe' })
    if (!pedido.payment_proof_url) {
      return res.status(404).json({ error: 'Ese pedido no tiene comprobante' })
    }

    // Los comprobantes subidos ANTES de esto no tienen identificador: siguen
    // siendo públicos y se devuelven tal cual. Romperles el acceso escondería
    // el pago de un pedido en curso, que es peor que la fuga que ya ocurrió.
    if (!pedido.payment_proof_public_id) {
      return res.json({ url: pedido.payment_proof_url, firmada: false })
    }

    const url = await signedMediaUrl(pedido.payment_proof_public_id)
    if (!url) return res.status(503).json({ error: 'No se pudo abrir el comprobante ahora mismo' })
    return res.json({ url, firmada: true })
  },
)

router.get(
  '/api/client/orders',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    // authClient garantiza estos claims; nunca se acepta businessId del request.
    const businessId = getClientBusinessId(req)
    // Se admite una lista separada por comas porque lo que espera al negocio
    // son DOS estados —un pedido nuevo y un comprobante por revisar—, y la
    // alarma tiene que verlos de una sola consulta. Con uno solo se quedó
    // ciega el 2026-08-08.
    // Se deduplica: pedir doce veces el mismo estado no significa nada, y sin
    // esto una petición podía llevar cientos de repeticiones a la consulta.
    // Los estados posibles son doce contados, así que el conjunto es el tope.
    const crudo = req.query.status === undefined ? null : String(req.query.status)
    const estados = crudo === null
      ? null
      : [...new Set(crudo.split(',').map(estado => estado.trim()).filter(Boolean))]
    if (estados !== null && (
      !estados.length
      || estados.some(estado => !ESTADOS_PEDIDO.includes(estado as typeof ESTADOS_PEDIDO[number]))
    )) {
      return res.status(400).json({ error: 'Estado de pedido inválido' })
    }
    // Uno solo sigue viajando como texto: es como se pedía antes de admitir
    // listas, y el repositorio filtra igual en los dos casos.
    const filtro = estados === null ? null : estados.length === 1 ? estados[0] : estados
    res.json(await db.getOrders(businessId, 100, filtro))
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

// ── «Ya me llegó el pago» ──────────────────────────────────────────────────
//
// El botón para el pago que NO pasó por la app: el cliente transfirió desde su
// banco —a veces desde la cuenta de un familiar— y mandó la captura por
// WhatsApp. Hasta ahora eso no se podía anotar en ningún sitio: el cliente
// seguía viendo el número de cuenta y el dueño, «sin comprobante todavía».
//
// Va SEPARADO de aceptar el pedido a propósito. Son dos momentos distintos:
// a las once de la noche el dueño da el pago por bueno pero no va a encender
// la cocina, y el cliente merece saber que su plata llegó igualmente.
router.put(
  '/api/client/orders/:id/payment-confirmed',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    try {
      const pedido = await db.confirmOrderPayment(businessId, String(req.params.id || ''))
      // Las condiciones viven en el `where` de la consulta, así que un `null`
      // significa «no cumplía»: de otro negocio, en efectivo, ya cerrado, o ya
      // marcado. No se distingue cuál para no confirmar qué pedidos existen.
      if (!pedido) {
        return res.status(409).json({
          error: 'Ese pedido no admite confirmar el pago ahora mismo',
        })
      }
      return res.json(pedido)
    } catch (error) {
      console.error(
        '❌ confirmar pago:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      return res.status(500).json({ error: 'No se pudo confirmar el pago' })
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
    // Del JWT, nunca del request: es el mismo negocio para cambiar el estado,
    // marcar el pago y avisar al cliente.
    const businessId = getClientBusinessId(req)
    try {
      const { data, error } = await db.setOrderStatus(
        businessId,
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

      // ── Lo que ocurre al ACEPTAR un pedido ──────────────────────────────
      //
      // Las dos cosas van después de responder al dueño en lo que importa: el
      // estado ya cambió y la cocina tiene su comanda. Ninguna puede
      // convertir un cambio que funcionó en un error en pantalla.
      if (String(status) === 'preparacion') {
        // 1. Aceptar el pedido ES dar el pago por bueno. El dueño que manda
        //    algo a la cocina ya decidió que le van a pagar, así que un
        //    segundo toque para decir lo mismo sobraba. La consulta filtra
        //    sola lo que no aplica (efectivo, ya marcado).
        await db.confirmOrderPayment(businessId, req.params.id)
          .catch(() => { /* el pedido ya avanzó: la marca es un extra */ })

        // 2. Y se le avisa al cliente, que hasta ahora no se enteraba de nada
        //    salvo que tuviera abierta la pantalla de seguimiento.
        //
        //    SIN esperar a que termine, a propósito: manda un mensaje por un
        //    canal externo que puede tardar segundos o colgarse. El dueño toca
        //    «aceptar» con la cocina esperando; hacerle mirar una pantalla
        //    quieta hasta que YCloud conteste es cambiar su tiempo por el de
        //    un aviso que se registra solo si falla.
        void avisarAlCliente(businessId, req.params.id)
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
