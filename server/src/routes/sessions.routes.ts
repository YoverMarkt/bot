import type { RequestHandler, Response } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'
import { sendToContact, type BusinessRecord } from '../services/notify'

interface DatabaseError {
  message?: string
}

interface DatabaseResult<T = unknown> {
  data?: T
  error?: DatabaseError | null
}

interface TagInput {
  name: string
  color?: unknown
}

interface ModuloDb {
  getConversations(businessId: string): Promise<unknown[]>
  getSessions(businessId: string): Promise<unknown[]>
  upsertSession(
    businessId: string,
    phone: string,
    data: Record<string, unknown>,
  ): Promise<DatabaseResult>
  /**
   * Bloquea o desbloquea un número en ESTE negocio.
   *
   * Crea el cliente si no existía: quien escribe por molestar puede no haber
   * pedido nunca, y es justo a ese al que hay que poder bloquear.
   */
  setContactBlocked(
    businessId: string,
    phone: string,
    blocked: boolean,
  ): Promise<{ blocked: boolean }>
  getBlockedPhones(businessId: string): Promise<string[]>
  getTags(businessId: string): Promise<unknown[]>
  createTag(businessId: string, data: TagInput): Promise<DatabaseResult>
  updateTag(businessId: string, tagId: string, data: TagInput): Promise<DatabaseResult>
  deleteTag(businessId: string, tagId: string): Promise<DatabaseResult>
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'owner',
    message: string,
  ): Promise<DatabaseResult>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const canManageConversations = auth.requirePermission('conversaciones')

function errorMessage(error: DatabaseError | Error | unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message || 'Error desconocido')
  }
  return 'Error desconocido'
}

function databaseFailure(
  res: Response,
  context: string,
  publicMessage: string,
  error: DatabaseError | Error | unknown,
) {
  console.error(`❌ ${context}:`, errorMessage(error))
  return res.status(500).json({ error: publicMessage })
}

router.get(
  '/api/client/conversations',
  auth.authClient,
  canManageConversations,
  async (req, res) => res.json(await db.getConversations(getClientBusinessId(req))),
)

router.get(
  '/api/client/sessions',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    try {
      res.json(await db.getSessions(getClientBusinessId(req)))
    } catch (error) {
      console.error('❌ listar sesiones:', errorMessage(error))
      res.json([])
    }
  },
)

router.put(
  '/api/client/sessions/:phone/mode',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const { manual } = req.body as { manual?: unknown }
    const { error } = await db.upsertSession(getClientBusinessId(req), req.params.phone, {
      manual_mode: Boolean(manual),
      unread_owner: false,
    })
    if (error) {
      return databaseFailure(
        res, 'actualizar modo de conversación',
        'No se pudo actualizar el modo de la conversación', error,
      )
    }
    res.json({ ok: true })
  },
)

// Los números bloqueados, para que el panel pinte el botón en su estado. Van
// aparte de la lista de chats porque son pocos —y en casi todos los negocios,
// ninguno—, y esa lista se pide cada pocos segundos.
router.get(
  '/api/client/sessions/blocked',
  auth.authClient,
  canManageConversations,
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
// Es TOTAL por decisión del dueño (2026-08-13): el bot deja de contestarle en
// todos los modos y la mini app le rechaza el pedido aunque tenga su enlace
// guardado. Si solo callara al bot, el bloqueo no bloquearía nada.
//
// ⚠️ Nunca se le avisa al bloqueado. Quien escribe para molestar busca una
// reacción, y «has sido bloqueado» es una reacción — además de un mensaje que
// se paga.
//
// Desbloquear limpia también el silencio automático y el contador: si el dueño
// da otra oportunidad, empieza de cero. Dejarle el silencio puesto haría que
// el desbloqueo pareciera no funcionar durante horas.
router.put(
  '/api/client/sessions/:phone/blocked',
  auth.authClient,
  canManageConversations,
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
      // ⚠️ Bloquear apaga también el MODO MANUAL, no solo la marca de no
      // leído. El bot comprueba el modo manual antes que el bloqueo —tiene que
      // hacerlo, es lo que permite al dueño responder a mano—, así que un
      // bloqueado en modo manual seguía cortando por esa rama y volviendo a
      // encender `unread_owner` con cada mensaje: la alarma sonaba una y otra
      // vez por alguien a quien se acababa de bloquear.
      //
      // Y tiene sentido por sí solo: el modo manual significa «yo le
      // contesto», que es justo lo contrario de bloquear.
      if (blocked) {
        await db.upsertSession(businessId, phone, {
          manual_mode: false,
          unread_owner: false,
        })
      }
      return res.json({ blocked })
    } catch (error) {
      return databaseFailure(
        res, 'bloquear contacto',
        'No se pudo actualizar el bloqueo de este número', error,
      )
    }
  },
)

// Cierra la venta, devuelve la conversación al bot y marca un corte de historial.
router.put(
  '/api/client/sessions/:phone/close',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const phone = decodeURIComponent(req.params.phone)
    const now = new Date().toISOString()
    let { error } = await db.upsertSession(businessId, phone, {
      manual_mode: false,
      unread_owner: false,
      closed_sale_at: now,
    })
    // Compatibilidad temporal si la columna closed_sale_at aún no existe.
    if (error && /closed_sale_at/.test(error.message || '')) {
      ;({ error } = await db.upsertSession(businessId, phone, {
        manual_mode: false,
        unread_owner: false,
      }))
    }
    if (error) {
      return databaseFailure(
        res, 'cerrar conversación',
        'No se pudo cerrar la conversación', error,
      )
    }
    res.json({ ok: true })
  },
)

router.put(
  '/api/client/sessions/:phone/read',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const { error } = await db.upsertSession(
      getClientBusinessId(req),
      decodeURIComponent(req.params.phone),
      { unread_owner: false },
    )
    if (error) {
      return databaseFailure(
        res, 'marcar conversación como leída',
        'No se pudo marcar la conversación como leída', error,
      )
    }
    res.json({ ok: true })
  },
)

router.put(
  '/api/client/sessions/:phone/name',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const { name: rawName } = req.body as { name?: string }
    const name = (rawName || '').trim().slice(0, 60)
    const { error } = await db.upsertSession(
      getClientBusinessId(req),
      decodeURIComponent(req.params.phone),
      { contact_name: name || null },
    )
    if (error) {
      return databaseFailure(
        res, 'actualizar nombre del contacto',
        'No se pudo actualizar el nombre del contacto', error,
      )
    }
    res.json({ ok: true })
  },
)

router.get(
  '/api/client/tags',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    try {
      res.json(await db.getTags(getClientBusinessId(req)))
    } catch (error) {
      databaseFailure(res, 'listar etiquetas', 'No se pudieron cargar las etiquetas', error)
    }
  },
)

router.post(
  '/api/client/tags',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const { name: rawName, color } = req.body as { name?: string; color?: unknown }
    const name = (rawName || '').trim().slice(0, 30)
    if (!name) return res.status(400).json({ error: 'Nombre requerido' })
    try {
      const { data, error } = await db.createTag(getClientBusinessId(req), { name, color })
      if (error) {
        return databaseFailure(
          res, 'crear etiqueta', 'No se pudo crear la etiqueta', error,
        )
      }
      res.status(201).json(data)
    } catch (error) {
      databaseFailure(res, 'crear etiqueta', 'No se pudo crear la etiqueta', error)
    }
  },
)

router.put(
  '/api/client/tags/:id',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const { name: rawName, color } = req.body as { name?: string; color?: unknown }
    const name = (rawName || '').trim().slice(0, 30)
    if (!name) return res.status(400).json({ error: 'Nombre requerido' })
    const { error } = await db.updateTag(
      getClientBusinessId(req),
      req.params.id,
      { name, color },
    )
    if (error) {
      return databaseFailure(
        res, 'actualizar etiqueta', 'No se pudo actualizar la etiqueta', error,
      )
    }
    res.json({ ok: true })
  },
)

router.delete(
  '/api/client/tags/:id',
  auth.authClient,
    canManageConversations,
    async (req, res) => {
    try {
      const { error } = await db.deleteTag(getClientBusinessId(req), req.params.id)
      if (error) {
        return databaseFailure(
          res, 'eliminar etiqueta', 'No se pudo eliminar la etiqueta', error,
        )
      }
      res.json({ ok: true })
    } catch (error) {
      databaseFailure(res, 'eliminar etiqueta', 'No se pudo eliminar la etiqueta', error)
    }
  },
)

router.put(
  '/api/client/sessions/:phone/tags',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const phone = decodeURIComponent(req.params.phone)
    const requestBody = req.body as { tags?: unknown }
    const tags = Array.isArray(requestBody.tags) ? requestBody.tags : []
    const { error } = await db.upsertSession(getClientBusinessId(req), phone, { tags })
    if (error) {
      const publicMessage = /tags/.test(error.message || '')
        ? 'Falta correr la migración de etiquetas'
        : 'No se pudieron asignar las etiquetas'
      return databaseFailure(res, 'asignar etiquetas', publicMessage, error)
    }
    res.json({ ok: true })
  },
)

router.post(
  '/api/client/sessions/:phone/send',
  auth.authClient,
  canManageConversations,
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const phone = decodeURIComponent(req.params.phone)
    const { message } = req.body as { message?: string }
    if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' })
    try {
      const business = await db.getBusinessById(businessId)
      // Sin negocio no hay canal por donde enviar: se corta antes de guardar
      // un mensaje que nunca saldría.
      if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })
      const { error } = await db.saveMessage(businessId, phone, 'owner', message)
      if (error) {
        return databaseFailure(
          res, 'guardar respuesta del dueño',
          'No se pudo guardar el mensaje', error,
        )
      }
      await sendToContact(business, phone, message)
      res.json({ ok: true })
    } catch (error) {
      databaseFailure(res, 'enviar respuesta del dueño', 'No se pudo enviar el mensaje', error)
    }
  },
)

export = router
