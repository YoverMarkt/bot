import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import simulatorRouter from '../dist/routes/admin-simulator.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const bot = require('../dist/services/bot-entry')
const JWT_SECRET = 'admin-simulator-test-secret'
let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, businessId: 'business-a' }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = simulatorRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
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

function mockBusinessContext() {
  const business = { id: 'business-a', name: 'Demo', ai_provider: 'groq' }
  vi.spyOn(db, 'getBusinessById').mockResolvedValue(business)
  vi.spyOn(db, 'getProducts').mockResolvedValue([{ id: 'product-a' }])
  vi.spyOn(db, 'getPolicies').mockResolvedValue({ bot_prompt: 'Vende bien' })
  vi.spyOn(db, 'getContactHistory').mockResolvedValue([{ role: 'user', content: 'Antes' }])
  return business
}

describe('simulador del superadmin', () => {
  it('protege ambos endpoints exclusivamente con autenticación admin', async () => {
    expect(simulatorRouter.stack).toHaveLength(2)
    expect(simulatorRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('post', '/api/admin/simulate')).status).toBe(401)
    expect((await dispatch('post', '/api/admin/simulate', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  it('valida negocio y mensaje antes de ejecutar el bot', async () => {
    const getBusiness = vi.spyOn(db, 'getBusinessById').mockResolvedValue(null)

    const missing = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(), body: { business_id: 'business-a', message: '   ' },
    })
    const unknown = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(), body: { business_id: 'business-a', message: 'Hola' },
    })

    expect(missing.status).toBe(400)
    expect(unknown.status).toBe(404)
    expect(getBusiness).toHaveBeenCalledOnce()
  })

  it('usa y persiste únicamente el contexto del negocio seleccionado', async () => {
    const business = mockBusinessContext()
    const saveMessage = vi.spyOn(db, 'saveMessage')
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null })
    const buildPrompt = vi.spyOn(bot, 'buildPrompt').mockReturnValue('prompt del negocio')
    const callAI = vi.spyOn(bot, 'callAI').mockResolvedValue(
      'Respuesta final ##IMG##https://img.example.com/producto.jpg##',
    )

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(),
      body: { business_id: 'business-a', message: '  Quiero comprar  ' },
    })

    expect(db.getProducts).toHaveBeenCalledWith('business-a')
    expect(db.getPolicies).toHaveBeenCalledWith('business-a')
    expect(db.getContactHistory).toHaveBeenCalledWith('business-a', 'sim_admin', 8)
    expect(buildPrompt).toHaveBeenCalledWith(
      business,
      [{ id: 'product-a' }],
      { bot_prompt: 'Vende bien' },
      false,
      'Quiero comprar',
    )
    expect(callAI).toHaveBeenCalledWith(
      'prompt del negocio',
      [{ role: 'user', content: 'Antes' }],
      'Quiero comprar',
      'groq',
    )
    expect(saveMessage).toHaveBeenNthCalledWith(
      1, 'business-a', 'sim_admin', 'user', 'Quiero comprar',
    )
    expect(saveMessage).toHaveBeenNthCalledWith(
      2, 'business-a', 'sim_admin', 'assistant', 'Respuesta final',
    )
    expect(response.body).toEqual({
      reply: 'Respuesta final',
      image: 'https://img.example.com/producto.jpg',
    })
  })

  it('convierte HANDOFF en respuesta segura y retira etiquetas internas', async () => {
    mockBusinessContext()
    vi.spyOn(db, 'saveMessage').mockResolvedValue({ error: null })
    vi.spyOn(bot, 'buildPrompt').mockReturnValue('prompt')
    vi.spyOn(bot, 'callAI').mockResolvedValue('Texto interno ##HANDOFF## ##BOOKING##')

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(),
      body: { business_id: 'business-a', message: 'Necesito ayuda' },
    })

    expect(response.body.reply).toContain('un asesor de nuestro equipo')
    expect(response.body.reply).not.toContain('##')
  })

  it('no llama a la IA si el mensaje del usuario no pudo guardarse', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockBusinessContext()
    vi.spyOn(db, 'saveMessage').mockResolvedValue({
      error: { message: 'insert rechazado' },
    })
    vi.spyOn(bot, 'buildPrompt').mockReturnValue('prompt')
    const callAI = vi.spyOn(bot, 'callAI').mockResolvedValue('Respuesta')

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(),
      body: { business_id: 'business-a', message: 'Hola' },
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo completar la simulación' },
    })
    expect(callAI).not.toHaveBeenCalled()
  })

  it('no responde éxito si la respuesta del bot no pudo persistirse', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockBusinessContext()
    vi.spyOn(db, 'saveMessage')
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'fallo respuesta' } })
    vi.spyOn(bot, 'buildPrompt').mockReturnValue('prompt')
    vi.spyOn(bot, 'callAI').mockResolvedValue('Respuesta')

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(),
      body: { business_id: 'business-a', message: 'Hola' },
    })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'No se pudo completar la simulación' })
  })

  it('comprueba el resultado al limpiar el historial del negocio', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const clear = vi.spyOn(db, 'clearSimHistory').mockResolvedValue({
      error: { message: 'delete rechazado' },
    })

    const response = await dispatch('delete', '/api/admin/simulate/:bizId/history', {
      auth: authorization(), params: { bizId: 'business-a' },
    })

    expect(clear).toHaveBeenCalledWith('business-a')
    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo limpiar el historial' },
    })
  })
})
