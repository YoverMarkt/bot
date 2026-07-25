import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import router from '../dist/routes/menu-modifiers.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'menu-modifiers-test-secret'
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
    role: 'client', businessId: 'business-a', userId: 'user-a', urole: 'owner', ...claims,
  }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = router.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, query: {}, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(payload) { result.body = payload; return this },
  }
  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => { nextCalled = true; nextError = error })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }
  await run(0)
  return result
}

describe('rutas de modificadores de menú (sabores)', () => {
  it('exige autenticación', async () => {
    expect((await dispatch('get', '/api/client/menu-modifiers')).status).toBe(401)
  })

  it('lista usando exclusivamente el negocio del JWT', async () => {
    const getAll = vi.spyOn(db, 'getAllMenuModifiers').mockResolvedValue([
      { id: 'm1', category_tag: 'pizzas', group_label: 'Sabor', name: 'Hawaiana', description: 'Jamón y piña', sort: 0, active: true },
    ])
    const res = await dispatch('get', '/api/client/menu-modifiers', {
      auth: authorization(), body: {}, params: {},
    })
    expect(res.status).toBe(200)
    expect(res.body[0].name).toBe('Hawaiana')
    expect(getAll).toHaveBeenCalledWith('business-a')
  })

  it('crea saneando el payload y con el negocio del JWT', async () => {
    const create = vi.spyOn(db, 'createMenuModifier').mockResolvedValue({
      data: { id: 'm2', name: 'Monster' }, error: null,
    })
    const res = await dispatch('post', '/api/client/menu-modifiers', {
      auth: authorization(),
      body: { category_tag: 'Pizzas', group_label: 'Sabor', name: '  Monster  ', description: 'Pepperoni, carne', businessId: 'business-b' },
    })
    expect(res.status).toBe(201)
    expect(create).toHaveBeenCalledWith('business-a', expect.objectContaining({
      category_tag: 'Pizzas', name: 'Monster', group_label: 'Sabor',
    }))
    // el negocio nunca sale del body
    expect(create.mock.calls[0][0]).toBe('business-a')
  })

  it('rechaza sin nombre o categoría', async () => {
    const res = await dispatch('post', '/api/client/menu-modifiers', {
      auth: authorization(), body: { category_tag: 'pizzas' },
    })
    expect(res.status).toBe(400)
  })

  it('avisa cuando el nombre choca en la categoría (índice único)', async () => {
    vi.spyOn(db, 'createMenuModifier').mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } })
    const res = await dispatch('post', '/api/client/menu-modifiers', {
      auth: authorization(), body: { category_tag: 'pizzas', name: 'Hawaiana' },
    })
    expect(res.status).toBe(409)
  })

  it('no actualiza un modificador de otro negocio (404)', async () => {
    vi.spyOn(db, 'getMenuModifierById').mockResolvedValue(null)
    const res = await dispatch('put', '/api/client/menu-modifiers/:id', {
      auth: authorization(), params: { id: 'm9' }, body: { category_tag: 'pizzas', name: 'X' },
    })
    expect(res.status).toBe(404)
  })
})
