import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import router from '../dist/routes/catalog-structure.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'catalogo-test-secret'
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

function authorization(businessId = 'negocio-a', claims = {}) {
  return `Bearer ${jwt.sign({
    role: 'client', businessId, userId: 'usuario-1', urole: 'owner', ...claims,
  }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = router.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params, query: {} }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
  }
  async function run(index) {
    if (index >= handlers.length) return
    let siguiente = false
    let fallo
    await handlers[index](req, res, error => { siguiente = true; fallo = error })
    if (fallo) throw fallo
    if (siguiente) await run(index + 1)
  }
  await run(0)
  return result
}

describe('estructura del catálogo (categorías y variantes)', () => {
  it('ninguna ruta queda sin autenticación ni sin permiso de catálogo', async () => {
    // Dos middlewares antes del manejador: sesión de cliente y permiso.
    expect(router.stack.every(layer => layer.route.stack.length === 3)).toBe(true)
    expect((await dispatch('get', '/api/client/categories')).status).toBe(401)
    expect((await dispatch('get', '/api/client/variants')).status).toBe(401)
  })

  // ⚠️ La razón de ser de esta comprobación: `product_variants` lleva
  // `business_id` Y `product_id`, y la clave foránea de `product_id` apunta a
  // `products` SIN mirar de quién es. El negocio sale del JWT, pero el
  // producto viaja en el cuerpo — y ahí es donde se cruza la frontera.
  it('no deja colgar una variante del producto de otro negocio', async () => {
    const pertenece = vi.spyOn(db, 'productBelongsToBusiness').mockResolvedValue(false)
    const crear = vi.spyOn(db, 'createVariant')

    const respuesta = await dispatch('post', '/api/client/variants', {
      auth: authorization('negocio-a'),
      body: { product_id: 'producto-de-negocio-b', name: 'Grande', price: 12 },
    })

    expect(respuesta.status).toBe(404)
    expect(crear).not.toHaveBeenCalled()
    expect(pertenece).toHaveBeenCalledWith('negocio-a', 'producto-de-negocio-b')
  })

  it('crea la variante con el negocio del JWT, no con el que venga en el cuerpo', async () => {
    vi.spyOn(db, 'productBelongsToBusiness').mockResolvedValue(true)
    const crear = vi.spyOn(db, 'createVariant').mockResolvedValue({
      data: { id: 'variante-1' }, error: null,
    })

    await dispatch('post', '/api/client/variants', {
      auth: authorization('negocio-a'),
      body: {
        product_id: 'producto-1', name: 'Grande', price: 12,
        business_id: 'negocio-b', id: 'id-inventado',
      },
    })

    expect(crear.mock.calls[0][0]).toBe('negocio-a')
    // Solo pasan los campos saneados: nada de colar un id o un negocio ajeno.
    expect(crear.mock.calls[0][1]).toEqual({
      product_id: 'producto-1', name: 'Grande', price: 12,
      price_sale: null, stock: 'disponible', sort: 0, active: true,
    })
  })

  // Una oferta más cara que el precio normal es un error de dedo que el
  // cliente vería en la tienda. La base no lo comprueba.
  it('rechaza un precio de oferta mayor que el precio normal', async () => {
    vi.spyOn(db, 'productBelongsToBusiness').mockResolvedValue(true)
    const crear = vi.spyOn(db, 'createVariant')

    const respuesta = await dispatch('post', '/api/client/variants', {
      auth: authorization(),
      body: { product_id: 'producto-1', name: 'Grande', price: 10, price_sale: 15 },
    })

    expect(respuesta.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })

  it('rechaza precios fuera del rango que acepta la base', async () => {
    vi.spyOn(db, 'productBelongsToBusiness').mockResolvedValue(true)
    const crear = vi.spyOn(db, 'createVariant')

    for (const price of [-1, 100_001, 'gratis']) {
      const respuesta = await dispatch('post', '/api/client/variants', {
        auth: authorization(),
        body: { product_id: 'producto-1', name: 'Grande', price },
      })
      expect(respuesta.status, `precio ${price}`).toBe(400)
    }
    expect(crear).not.toHaveBeenCalled()
  })

  it('traduce el choque del índice único a un mensaje entendible', async () => {
    vi.spyOn(db, 'productBelongsToBusiness').mockResolvedValue(true)
    vi.spyOn(db, 'createVariant').mockResolvedValue({
      data: null, error: { code: '23505', message: 'duplicate key value' },
    })

    const respuesta = await dispatch('post', '/api/client/variants', {
      auth: authorization(),
      body: { product_id: 'producto-1', name: 'Grande', price: 12 },
    })

    expect(respuesta.status).toBe(409)
    expect(respuesta.body.error).toContain('variante con ese nombre')
    expect(JSON.stringify(respuesta.body)).not.toContain('duplicate key')
  })

  it('borra y edita siempre dentro del negocio del JWT', async () => {
    const borrar = vi.spyOn(db, 'deleteVariant').mockResolvedValue({ error: null })
    const editar = vi.spyOn(db, 'updateVariant').mockResolvedValue({ error: null })

    await dispatch('delete', '/api/client/variants/:id', {
      auth: authorization('negocio-a'), params: { id: 'variante-1' },
    })
    await dispatch('put', '/api/client/variants/:id', {
      auth: authorization('negocio-a'), params: { id: 'variante-1' },
      body: { name: 'Mediana', price: 9 },
    })

    expect(borrar).toHaveBeenCalledWith('negocio-a', 'variante-1')
    expect(editar.mock.calls[0][0]).toBe('negocio-a')
  })

  it('la categoría se crea saneada y en su propio negocio', async () => {
    const crear = vi.spyOn(db, 'createCategory').mockResolvedValue({
      data: { id: 'categoria-1' }, error: null,
    })

    const respuesta = await dispatch('post', '/api/client/categories', {
      auth: authorization('negocio-a'),
      body: { name: '  Pizzas  ', sort: 2, business_id: 'negocio-b' },
    })

    expect(respuesta.status).toBe(201)
    expect(crear).toHaveBeenCalledWith('negocio-a', {
      name: 'Pizzas', description: null, image_url: null, image_public_id: null,
      sort: 2, active: true,
    })
  })

  // Mismo agujero que las variantes, en otra tabla: la clave foránea de
  // `products.category_id` apunta a `product_categories` sin mirar de quién es,
  // y el cuerpo de la petición de producto entra casi tal cual.
  it('limpia la categoría de otro negocio al crear un producto', async () => {
    const productos = require('../dist/routes/products-core.routes.js')
    vi.spyOn(db, 'getCategories').mockResolvedValue([{ id: 'categoria-propia' }])
    const crear = vi.spyOn(db, 'createProduct').mockResolvedValue({
      data: { id: 'producto-1' }, error: null,
    })
    vi.spyOn(require('../dist/services/bot-entry.js'), 'indexProduct').mockResolvedValue(true)

    const layer = productos.stack.find(item => (
      item.route?.path === '/api/client/products' && item.route?.methods?.post
    ))
    const handlers = layer.route.stack.map(item => item.handle)
    const req = {
      headers: { authorization: authorization('negocio-a') },
      body: { name: 'Pizza', price: 10, category_id: 'categoria-de-negocio-b' },
      params: {}, query: {},
    }
    const res = { status() { return this }, json() { return this } }
    for (const handler of handlers) {
      let siguiente = false
      await handler(req, res, () => { siguiente = true })
      if (!siguiente) break
    }

    expect(crear.mock.calls[0][1].category_id).toBeNull()
  })

  it('rechaza una categoría sin nombre', async () => {
    const crear = vi.spyOn(db, 'createCategory')

    const respuesta = await dispatch('post', '/api/client/categories', {
      auth: authorization(), body: { name: '   ' },
    })

    expect(respuesta.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })
})
