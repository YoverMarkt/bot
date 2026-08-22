import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import jwt from 'jsonwebtoken'
import simulatorRouter from '../dist/routes/admin-simulator.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
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
  const business = { id: 'business-a', name: 'Demo', ai_provider: 'groq', chat_mode: 'ai' }
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

  // ⚠️ Aquí vivían SIETE pruebas del modo IA del simulador: el prompt que se
  // armaba, el parser de etiquetas, el descarte de totales inventados y el
  // HANDOFF. Se fueron con la IA el 2026-08-21. Lo que queda en su lugar es lo
  // único que importa ahora: que no haya forma de llegar a un modelo.
  it('un modo no reconocido avisa de la configuración en vez de inventar', async () => {
    mockBusinessContext()
    vi.spyOn(db, 'saveMessage').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(),
      // No un saludo: «hola» lo atiende antes el menú de bienvenida, que
      // sigue vivo y no depende de la IA.
      body: { business_id: 'business-a', message: 'quiero comprar algo' },
    })

    expect(response.status).toBe(200)
    expect(response.body.actionNote).toMatch(/modo de conversación/i)
    expect(response.body.reply).toMatch(/no tiene un modo/i)
  })

  it('el simulador ya no puede llamar a un modelo', async () => {
    // Si alguien reintroduce la IA por aquí, esto lo caza.
    const fuente = fs.readFileSync(
      new URL('../src/routes/admin-simulator.routes.ts', import.meta.url), 'utf8',
    )
    expect(fuente).not.toMatch(/callAI|buildPrompt/)
  })


  it(
    'en miniapp replica el corte sin IA y no finge una conversación',
    async () => {
      const business = { id: 'business-a', name: 'Demo', chat_mode: 'miniapp' }
      vi.spyOn(db, 'getBusinessById').mockResolvedValue(business)
      const getProducts = vi.spyOn(db, 'getProducts')
      const getPolicies = vi.spyOn(db, 'getPolicies')
      const getHistory = vi.spyOn(db, 'getContactHistory')
      const saveMessage = vi.spyOn(db, 'saveMessage').mockResolvedValue({ error: null })

      const response = await dispatch('post', '/api/admin/simulate', {
        auth: authorization(),
        body: { business_id: 'business-a', message: 'Quiero pedir' },
      })

      expect(getProducts).not.toHaveBeenCalled()
      expect(getPolicies).not.toHaveBeenCalled()
      expect(getHistory).not.toHaveBeenCalled()
      expect(saveMessage).toHaveBeenNthCalledWith(
        1, 'business-a', 'sim_admin', 'user', 'Quiero pedir',
      )
      expect(saveMessage).toHaveBeenNthCalledWith(
        2,
        'business-a',
        'sim_admin',
        'assistant',
        expect.stringContaining('enlace personal'),
      )
      expect(response.status).toBe(200)
      expect(response.body.reply).toContain('enlace personal')
      expect(response.body.actionNote).toContain('no se llamó a la IA')
      expect(response.body.options).toBeNull()
    },
  )

  it('en menú conduce la máquina de estados y tampoco llama a la IA', async () => {
    const business = {
      id: 'business-a', name: 'Demo', chat_mode: 'menu', takes_orders: true,
    }
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business)
    vi.spyOn(db, 'getProducts').mockResolvedValue([
      { id: 'p1', name: 'Pizza Familiar', price: 10.5, tags: ['pizzas'], stock: 'disponible', active: true },
    ])
    vi.spyOn(db, 'getMenuModifiers').mockResolvedValue([])
    vi.spyOn(db, 'getLastOrderForContact').mockResolvedValue(null)
    vi.spyOn(db, 'getPolicies').mockResolvedValue({})
    vi.spyOn(db, 'saveMessage').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(),
      body: { business_id: 'business-a', message: 'hola' },
    })

    // Lo que define el modo: el código conduce y el modelo no participa.
    expect(response.status).toBe(200)
    // La bienvenida llega con las opciones armadas desde el catálogo real.
    expect(Array.isArray(response.body.options)).toBe(true)
    expect(response.body.options.length).toBeGreaterThan(0)
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
  })})
