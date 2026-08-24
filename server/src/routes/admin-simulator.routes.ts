import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { advanceMenuFlowConEstado } from '../services/bot-menu-flow'
import { handleMarketplaceMessage } from '../services/marketplace-entry'
import type { MarketplaceEntryDeps } from '../services/marketplace-entry'

// ═══════════════════════════════════════════════════════════════════════════
// SIMULADOR DEL MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════
//
// Escribir al número de Umbani sin gastar un mensaje de WhatsApp.
//
// ⚠️ Hasta el 2026-08-23 esto simulaba OTRA COSA. Despachaba por
// `businesses.chat_mode` —el camino del canal PROPIO de un negocio— y con el
// único local de producción en `miniapp` respondía «en el canal real, aquí se
// envía el enlace personal de la tienda». Eso NO es lo que pasa: el cliente
// escribe al número compartido, ve categorías, elige local, y ahí recibe el
// enlace. El simulador probaba una rama por la que no entra nadie, que es
// exactamente el fallo que esta clase de herramienta debería ayudar a cazar.
//
// Ahora corre `handleMarketplaceMessage`, la MISMA función que atiende el
// webhook. Los datos son los de verdad —categorías, locales, catálogo,
// opciones, precios— y el estado vive donde vive en producción,
// `marketplace_conversations`. Lo único distinto es de dónde sale el mensaje y
// a dónde va la respuesta.
//
// ⚠️ DOS COSAS NO SE HACEN DE VERDAD, y las dos por el mismo motivo: escriben
// en el negocio del dueño.
//
//   · Crear el pedido. Un pedido de prueba entra en la cocina del local, suena
//     la alarma del panel y acaba en `sales` al entregarlo — o sea, en el
//     reporte de ventas y en la comisión de la plataforma. Se responde con el
//     resumen y una nota.
//   · Guardar la dirección. Cuelga del cliente simulado y solo existe para que
//     el pedido —que no se crea— tuviera a dónde ir.
//
// Todo lo demás SÍ ocurre: la búsqueda, el bloqueo de «un pedido a la vez», el
// enlace de la tienda (que se puede abrir y funciona) y el cálculo de precios.

/**
 * El cliente simulado.
 *
 * Doce ceros: ningún país tiene el prefijo 000, así que jamás va a chocar con
 * un teléfono real ni a recibir un mensaje por accidente. Es el equivalente al
 * `sim_admin` del simulador anterior, adaptado a que aquí el teléfono es la
 * llave con la que `resolveMarketplaceCustomer` encuentra la conversación.
 */
const TELEFONO_SIMULADO = '000000000000'

const NOTA_PEDIDO = '🛒 En el canal real, aquí se crea el pedido con la RPC atómica y le suena la alarma al dueño. El simulador no lo crea: un pedido de prueba entraría en su cocina y acabaría en su reporte de ventas.'

const db: {
  getConversation(customerId: string): Promise<unknown>
  resolveMarketplaceCustomer(phone: string): Promise<{ id: string; name: string | null }>
  deleteConversation(customerId: string): Promise<void>
} = require('../db') as typeof import('../db')
const auth: {
  authAdmin: RequestHandler
} = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()

/**
 * Las mismas dependencias que arma `inbound-webhook.ts` para el webhook, con
 * dos sustituidas y `send` capturando en vez de enviando.
 *
 * Se construyen con `require` diferido por el mismo motivo que allí: cerrar el
 * ciclo de importaciones al arrancar (`marketplace-entry` → `storefront-link`
 * → `db` → …).
 */
function dependenciasDelSimulador(
  capturadas: { reply: string; options: string[] }[],
  notas: string[],
): MarketplaceEntryDeps {
  const base = require('../db') as typeof import('../db')
  const link = require('../services/storefront-link') as typeof import('../services/storefront-link')

  return {
    // El catálogo, las categorías, los locales y las opciones son los REALES.
    // Solo se reemplaza lo que escribiría en el negocio del dueño.
    database: {
      ...base,
      // Se responde con un identificador que no existe: el pedido tampoco se
      // crea, así que nadie va a buscarlo. Guardarla de verdad dejaría
      // direcciones de un cliente inventado en la ficha del local.
      createCustomerAddress: async () => ({ id: 'simulacion-sin-direccion' }),
      // ⚠️ El techo de gasto NO se aplica aquí, y es coherente con lo que el
      // techo existe para hacer: limitar los mensajes que se PAGAN. El
      // simulador no manda un solo WhatsApp. Dejarlo puesto silenciaría 12 h al
      // superadmin justo cuando está dando de alta varios locales seguidos —
      // que es exactamente cuando esta pantalla hace falta.
      claimMarketplaceReply: async () => ({ permitido: true, respuestas: 0 }),
    } as unknown as MarketplaceEntryDeps['database'],
    issueLink: link.issueStorefrontLink,
    send: async (reply: string, options: string[] = []) => {
      capturadas.push({ reply, options })
    },
    tipoPideEnChat: (businessType: string | null | undefined) => (
      base.tipoPideEnChat(businessType)
    ),
    avanzarMenu: advanceMenuFlowConEstado,
    crearPedidoCompleto: async () => {
      notas.push(NOTA_PEDIDO)
      // Un número de pedido que se distingue a simple vista de uno real.
      return { orderNumber: 0, total: 0 }
    },
    crearPedido: async () => {
      notas.push(NOTA_PEDIDO)
      return true
    },
    logger: console,
  }
}

/**
 * Un mensaje al número de Umbani, tal y como lo atendería el webhook.
 *
 * ⚠️ Ya no recibe `business_id`, y ese es el punto: en el marketplace el local
 * NO lo elige el superadmin, lo elige el cliente navegando el menú. Pedirlo
 * sería volver a simular el mundo de «un bot por local».
 */
router.post('/api/admin/simulate', auth.authAdmin, async (req, res) => {
  const { message: rawMessage } = req.body as { message?: unknown }
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    return res.status(400).json({ error: 'message requerido' })
  }
  const message = rawMessage.trim()

  try {
    const capturadas: { reply: string; options: string[] }[] = []
    const notas: string[] = []
    await handleMarketplaceMessage(
      { from: TELEFONO_SIMULADO, text: message },
      dependenciasDelSimulador(capturadas, notas),
    )

    // El menú manda UNA respuesta por mensaje, pero el checkout puede mandar
    // dos seguidas (confirmación + siguiente paso). Se devuelven todas para
    // que el simulador enseñe lo mismo que recibiría el teléfono.
    const respuestas = capturadas.map(item => ({
      reply: item.reply,
      options: item.options,
    }))
    console.log(`🧪 [Sim] marketplace: ${respuestas.length} respuesta(s)`)
    return res.json({
      replies: respuestas,
      notes: notas,
    })
  } catch (error) {
    console.error(
      '❌ Simulate:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
    return res.status(500).json({ error: 'No se pudo completar la simulación' })
  }
})

/**
 * Vuelve a empezar: deja al cliente simulado como alguien que nunca escribió.
 *
 * ⚠️ BORRA la conversación en vez de soltarla con la RPC de `MENÚ`, y la
 * diferencia importa. `MENÚ` conserva la fila, así que el mensaje siguiente ya
 * no es un primer contacto y recibe «🙏 No te entendí» en vez de la
 * bienvenida (`primerContacto: !conversation`). Lo primero que hay que poder
 * comprobar al dar de alta un local es justamente qué ve quien escribe a
 * Umbani por primera vez — con la RPC, el simulador no podía enseñarlo nunca.
 *
 * `MENÚ` sigue probándose escribiéndolo en el chat, como haría un cliente.
 */
router.delete('/api/admin/simulate/history', auth.authAdmin, async (_req, res) => {
  try {
    const cliente = await db.resolveMarketplaceCustomer(TELEFONO_SIMULADO)
    await db.deleteConversation(cliente.id)
    res.json({ ok: true })
  } catch (error) {
    console.error(
      '❌ limpiar simulador:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
    res.status(500).json({ error: 'No se pudo reiniciar la conversación' })
  }
})

export = router
