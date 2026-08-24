import type { RequestHandler, Response } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

// ═══════════════════════════════════════════════════════════════════════════
// CONTACTOS BLOQUEADOS
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo único que sobrevive de `sessions.routes.ts`, retirada el 2026-08-23 con
// la pantalla de Conversaciones. Las otras doce rutas —lista de chats,
// historial, modo manual, cerrar, marcar leído, renombrar, etiquetas y
// responder a mano— se fueron con ella: un local del marketplace no tiene
// chats que leer, porque sus clientes escriben al número de Umbani y
// `marketplace-entry.ts` no escribe una sola fila en `conversation_history`.
//
// ⚠️ ESTAS DOS SE QUEDAN, y no por nostalgia: el bloqueo es la única defensa
// del dueño contra quien pide para molestar, y sigue teniendo efecto —
// `POST /api/store/:slug/orders` responde 403 y el disparador
// `orders_reject_blocked` lo rechaza dentro de la misma transacción que la
// inserción. Borrarlas dejaría el `blocked_at` sin nadie que lo escriba: una
// defensa con las comprobaciones puestas y ningún interruptor, que es
// exactamente el patrón que este proyecto lleva seis veces pagando caro.
//
// ⚠️ LO QUE HOY *NO* HACE, y hay que decirlo: no calla al bot del marketplace.
// `marketplace-entry.ts` no consulta el bloqueo —lo consultan
// `bot-conversation.ts` e `inbound-webhook.ts`, que son el camino del canal
// PROPIO—, así que un bloqueado sigue recibiendo respuestas del menú. Cerrarlo
// no es cablear una consulta más: con un número compartido, «bloqueado por
// quién» no tiene respuesta hasta que el cliente elige local. Es una decisión
// de producto pendiente.

interface DatabaseError {
  message?: string
}

interface ModuloDb {
  setContactBlocked(
    businessId: string,
    phone: string,
    blocked: boolean,
  ): Promise<{ blocked: boolean }>
  getBlockedPhones(businessId: string): Promise<string[]>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
// El bloqueo decide quién puede comprar: es una decisión de venta, y ese es el
// permiso que ya tienen quienes atienden pedidos. `conversaciones` gobernaba
// una pantalla que ya no existe.
const canManageCustomers = auth.requirePermission('ventas')

function databaseFailure(
  res: Response,
  context: string,
  publicMessage: string,
  error: DatabaseError | Error | unknown,
) {
  const detalle = error instanceof Error
    ? error.message
    : String((error as DatabaseError)?.message || 'Error desconocido')
  console.error(`❌ ${context}:`, detalle)
  return res.status(500).json({ error: publicMessage })
}

/**
 * Los números que este negocio tiene bloqueados.
 *
 * Van en su propia consulta porque son pocos —y en casi todos los negocios,
 * ninguno—, así que no encarecen la pantalla que los pinta.
 */
router.get(
  '/api/client/blocked',
  auth.authClient,
  canManageCustomers,
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    try {
      return res.json(await db.getBlockedPhones(businessId))
    } catch (error) {
      return databaseFailure(
        res, 'leer números bloqueados',
        'No se pudieron leer los números bloqueados', error,
      )
    }
  },
)

// ── Bloquear un número ─────────────────────────────────────────────────────
//
// El bloqueo es del DUEÑO, no de un contador: el techo automático silencia 24
// h a quien se pasa, pero condenar a alguien para siempre es una decisión de
// persona. Por eso vive aquí y no en el bot.
//
// ⚠️ Nunca se le avisa al bloqueado. Quien escribe para molestar busca una
// reacción, y «has sido bloqueado» es una reacción — además de un mensaje que
// se paga.
//
// Desbloquear limpia también el silencio automático y el contador: si el dueño
// da otra oportunidad, empieza de cero. Dejarle el silencio puesto haría que
// el desbloqueo pareciera no funcionar durante horas.
router.put(
  '/api/client/blocked/:phone',
  auth.authClient,
  canManageCustomers,
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const phone = decodeURIComponent(req.params.phone)
    const blocked = (req.body as { blocked?: unknown } | null)?.blocked === true

    // ⚠️ Telegram no se puede bloquear todavía, y callarlo sería peor que
    // decirlo. `resolveCustomer` guarda a los clientes por dígitos, así que un
    // `tg_123` se convertiría en el cliente `123` — un número de WhatsApp de
    // otra persona, que quedaría bloqueada sin haber hecho nada. Hasta que
    // cada canal tenga su identidad, este camino se cierra.
    if (phone.startsWith('tg_')) {
      return res.status(400).json({
        error: 'Por ahora solo se pueden bloquear números de WhatsApp',
      })
    }

    try {
      await db.setContactBlocked(businessId, phone, blocked)
      // ⚠️ Aquí se apagaba además el MODO MANUAL de la sesión, porque el bot lo
      // comprueba ANTES que el bloqueo y un bloqueado en modo manual seguía
      // encendiendo `unread_owner` con cada mensaje. Se retira con la pantalla
      // que lo encendía: sin Conversaciones no hay forma de poner a nadie en
      // modo manual, así que la corrección ya no tiene nada que corregir.
      return res.json({ blocked })
    } catch (error) {
      return databaseFailure(
        res, 'bloquear contacto',
        'No se pudo actualizar el bloqueo de este número', error,
      )
    }
  },
)

export = router
