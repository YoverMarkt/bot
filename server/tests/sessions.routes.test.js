import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import sessionsRouter from '../dist/routes/sessions.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const notify = require('../dist/services/notify')
const JWT_SECRET = 'sessions-routes-test-secret'

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function authorization(claims = {}) {
  return `Bearer ${jwt.sign({
    role: 'client',
    businessId: 'business-a',
    urole: 'owner',
    ...claims,
  }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const routeLayer = sessionsRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(responseBody) { result.body = responseBody; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

describe('rutas de sesiones y conversaciones', () => {
  it('protege todos los endpoints con autenticación y permiso conversaciones', async () => {
    expect(sessionsRouter.stack).toHaveLength(12)
    for (const layer of sessionsRouter.stack) {
      expect(layer.route.stack).toHaveLength(3)
    }

    expect((await dispatch('get', '/api/client/sessions')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: ['ventas'] })
    expect((await dispatch('get', '/api/client/sessions', { auth: employee })).status).toBe(403)
  })

  it('lista conversaciones y sesiones únicamente desde el negocio del JWT', async () => {
    const getConversations = vi.spyOn(db, 'getConversations').mockResolvedValue([{ id: 'm1' }])
    const getSessions = vi.spyOn(db, 'getSessions').mockResolvedValue([{ id: 's1' }])
    const auth = authorization()

    const conversations = await dispatch('get', '/api/client/conversations', { auth })
    const sessions = await dispatch('get', '/api/client/sessions', { auth })

    expect(getConversations).toHaveBeenCalledWith('business-a')
    expect(getSessions).toHaveBeenCalledWith('business-a')
    expect(conversations.body).toEqual([{ id: 'm1' }])
    expect(sessions.body).toEqual([{ id: 's1' }])
  })

  it('conserva el fallback vacío cuando falla la lista de sesiones', async () => {
    vi.spyOn(db, 'getSessions').mockRejectedValue(new Error('fallo temporal'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await dispatch('get', '/api/client/sessions', {
      auth: authorization(),
    })

    expect(response).toEqual({ status: 200, body: [] })
    expect(log).toHaveBeenCalledWith('❌ listar sesiones:', 'fallo temporal')
  })

  it('no responde éxito cuando Supabase rechaza cambios de sesión', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue({
      error: { message: 'detalle interno de PostgreSQL' },
    })
    const auth = authorization()
    const phone = encodeURIComponent('+593999000001')

    const mode = await dispatch('put', '/api/client/sessions/:phone/mode', {
      auth, params: { phone }, body: { manual: true, businessId: 'business-b' },
    })
    const read = await dispatch('put', '/api/client/sessions/:phone/read', {
      auth, params: { phone },
    })
    const name = await dispatch('put', '/api/client/sessions/:phone/name', {
      auth, params: { phone }, body: { name: 'Ana' },
    })

    expect(mode).toEqual({
      status: 500,
      body: { error: 'No se pudo actualizar el modo de la conversación' },
    })
    expect(read).toEqual({
      status: 500,
      body: { error: 'No se pudo marcar la conversación como leída' },
    })
    expect(name).toEqual({
      status: 500,
      body: { error: 'No se pudo actualizar el nombre del contacto' },
    })
    expect(upsert).toHaveBeenCalledTimes(3)
    expect(upsert.mock.calls.every(call => call[0] === 'business-a')).toBe(true)
  })

  it('cierra la conversación y usa el fallback heredado sin closed_sale_at', async () => {
    const upsert = vi.spyOn(db, 'upsertSession')
      .mockResolvedValueOnce({ error: { message: 'closed_sale_at no existe' } })
      .mockResolvedValueOnce({ error: null })

    const response = await dispatch('put', '/api/client/sessions/:phone/close', {
      auth: authorization(),
      params: { phone: encodeURIComponent('+593999000001') },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(upsert).toHaveBeenNthCalledWith(1, 'business-a', '+593999000001', {
      manual_mode: false,
      unread_owner: false,
      closed_sale_at: expect.any(String),
    })
    expect(upsert).toHaveBeenNthCalledWith(2, 'business-a', '+593999000001', {
      manual_mode: false,
      unread_owner: false,
    })
  })

  it('crea y edita etiquetas con nombre acotado dentro del negocio autenticado', async () => {
    const createTag = vi.spyOn(db, 'createTag').mockResolvedValue({
      data: { id: 'tag-a', name: 'Etiqueta' }, error: null,
    })
    const updateTag = vi.spyOn(db, 'updateTag').mockResolvedValue({ error: null })
    const auth = authorization()

    const created = await dispatch('post', '/api/client/tags', {
      auth,
      body: { name: `  ${'E'.repeat(40)}  `, color: '#123456', businessId: 'business-b' },
    })
    await dispatch('put', '/api/client/tags/:id', {
      auth,
      params: { id: 'tag-a' },
      body: { name: ' Etiqueta ', color: '#654321', businessId: 'business-b' },
    })

    expect(created.status).toBe(201)
    expect(createTag).toHaveBeenCalledWith('business-a', {
      name: 'E'.repeat(30), color: '#123456',
    })
    expect(updateTag).toHaveBeenCalledWith('business-a', 'tag-a', {
      name: 'Etiqueta', color: '#654321',
    })
  })

  it('normaliza etiquetas inválidas y reporta la migración faltante', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const upsert = vi.spyOn(db, 'upsertSession').mockResolvedValue({
      error: { message: 'column tags does not exist' },
    })

    const response = await dispatch('put', '/api/client/sessions/:phone/tags', {
      auth: authorization(),
      params: { phone: encodeURIComponent('+593999000001') },
      body: { tags: 'tag-a' },
    })

    expect(upsert).toHaveBeenCalledWith('business-a', '+593999000001', { tags: [] })
    expect(response).toEqual({
      status: 500,
      body: { error: 'Falta correr la migración de etiquetas' },
    })
  })

  it('no confirma eliminar una etiqueta si Supabase devuelve error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deleteTag = vi.spyOn(db, 'deleteTag').mockResolvedValue({
      error: { message: 'detalle interno de PostgreSQL' },
    })

    const response = await dispatch('delete', '/api/client/tags/:id', {
      auth: authorization(),
      params: { id: 'tag-a' },
    })

    expect(deleteTag).toHaveBeenCalledWith('business-a', 'tag-a')
    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo eliminar la etiqueta' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })

  it('guarda y envía respuestas usando el canal y negocio de la conversación', async () => {
    const business = { id: 'business-a', whatsapp_provider: 'ycloud' }
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business)
    const saveMessage = vi.spyOn(db, 'saveMessage').mockResolvedValue({ error: null })
    const sendToContact = vi.spyOn(notify, 'sendToContact').mockResolvedValue()

    const response = await dispatch('post', '/api/client/sessions/:phone/send', {
      auth: authorization(),
      params: { phone: encodeURIComponent('+593999000001') },
      body: { message: 'Hola' },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(saveMessage).toHaveBeenCalledWith(
      'business-a', '+593999000001', 'owner', 'Hola',
    )
    expect(sendToContact).toHaveBeenCalledWith(business, '+593999000001', 'Hola')
  })

  it('rechaza respuestas vacías antes de consultar o escribir datos', async () => {
    const getBusiness = vi.spyOn(db, 'getBusinessById').mockResolvedValue({})
    const saveMessage = vi.spyOn(db, 'saveMessage').mockResolvedValue({})

    const response = await dispatch('post', '/api/client/sessions/:phone/send', {
      auth: authorization(),
      params: { phone: 'contacto' },
      body: { message: '   ' },
    })

    expect(response).toEqual({ status: 400, body: { error: 'Mensaje vacío' } })
    expect(getBusiness).not.toHaveBeenCalled()
    expect(saveMessage).not.toHaveBeenCalled()
  })

  it('no envía al contacto si el historial no pudo guardarse', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'business-a' })
    vi.spyOn(db, 'saveMessage').mockResolvedValue({
      error: { message: 'insert rechazado' },
    })
    const sendToContact = vi.spyOn(notify, 'sendToContact').mockResolvedValue()

    const response = await dispatch('post', '/api/client/sessions/:phone/send', {
      auth: authorization(),
      params: { phone: encodeURIComponent('+593999000001') },
      body: { message: 'Hola' },
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo guardar el mensaje' },
    })
    expect(sendToContact).not.toHaveBeenCalled()
  })
})
