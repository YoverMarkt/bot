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

const db = require('../db') as {
  getConversations(businessId: string): Promise<unknown[]>
  getSessions(businessId: string): Promise<unknown[]>
  upsertSession(
    businessId: string,
    phone: string,
    data: Record<string, unknown>,
  ): Promise<DatabaseResult>
  getTags(businessId: string): Promise<unknown[]>
  createTag(businessId: string, data: TagInput): Promise<DatabaseResult>
  updateTag(businessId: string, tagId: string, data: TagInput): Promise<DatabaseResult>
  deleteTag(businessId: string, tagId: string): Promise<DatabaseResult>
  getBusinessById(businessId: string): Promise<BusinessRecord>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'owner',
    message: string,
  ): Promise<DatabaseResult>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}

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
