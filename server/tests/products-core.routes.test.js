import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import productsRouter from '../dist/routes/products-core.routes.js'

const require = createRequire(import.meta.url)
const bot = require('../dist/services/bot-entry')
const cloud = require('../dist/integrations/cloudinary')
const db = require('../dist/db')
const JWT_SECRET = 'products-core-test-secret'

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
  const token = jwt.sign({
    role: 'client',
    businessId: 'business-a',
    urole: 'owner',
    ...claims,
  }, JWT_SECRET)
  return `Bearer ${token}`
}

async function dispatch(method, path, { auth, body = {}, query = {}, params = {} } = {}) {
  const routeLayer = productsRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, query, params }
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

describe('catálogo TypeScript', () => {
  it('protege los cinco endpoints y reserva las mutaciones para catálogo', async () => {
    const routes = [
      ['get', '/api/client/products', 2],
      ['post', '/api/client/products', 3],
      ['put', '/api/client/products/:id', 3],
      ['delete', '/api/client/products/:id', 3],
      ['post', '/api/client/reindex', 3],
    ]
    for (const [method, path, handlers] of routes) {
      const layer = productsRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      ))
      expect(layer.route.stack).toHaveLength(handlers)
    }

    expect((await dispatch('get', '/api/client/products')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: ['citas'] })
    expect((await dispatch('post', '/api/client/products', { auth: employee })).status).toBe(403)
  })

  it('lista y crea productos usando únicamente el negocio del JWT', async () => {
    const products = [{ id: 'product-a', business_id: 'business-a', name: 'Producto' }]
    const getProducts = vi.spyOn(db, 'getProducts').mockResolvedValue(products)
    const createProduct = vi.spyOn(db, 'createProduct').mockResolvedValue({
      data: products[0], error: null,
    })
    const indexProduct = vi.spyOn(bot, 'indexProduct').mockResolvedValue(true)
    const auth = authorization()

    const read = await dispatch('get', '/api/client/products', { auth })
    const created = await dispatch('post', '/api/client/products', {
      auth,
      body: { name: 'Producto', price: '12.50', business_id: 'business-b' },
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(read.body).toEqual(products)
    expect(created.status).toBe(201)
    expect(getProducts).toHaveBeenCalledWith('business-a')
    expect(createProduct).toHaveBeenCalledWith(
      'business-a',
      // `category_id` se normaliza SIEMPRE, aunque no venga en la petición:
      // así una categoría ajena nunca llega a la base (ver la prueba del
      // cruce entre negocios en catalog-structure.routes.test.js).
      { name: 'Producto', price: 12.5, category_id: null },
    )
    expect(indexProduct).toHaveBeenCalledWith(products[0])
  })

  it('valida nombre y precio antes de crear', async () => {
    const createProduct = vi.spyOn(db, 'createProduct').mockResolvedValue({ data: null, error: null })

    const response = await dispatch('post', '/api/client/products', {
      auth: authorization(), body: { name: 'Producto' },
    })

    expect(response).toEqual({ status: 400, body: { error: 'Nombre y precio requeridos' } })
    expect(createProduct).not.toHaveBeenCalled()
  })

  it('impide editar productos de otro negocio', async () => {
    const getProduct = vi.spyOn(db, 'getProductById').mockResolvedValue({
      id: 'product-b', business_id: 'business-b', image_public_id: 'image-b',
    })
    const updateProduct = vi.spyOn(db, 'updateProduct').mockResolvedValue({})
    const deleteMedia = vi.spyOn(cloud, 'deleteMedia').mockResolvedValue(undefined)

    const response = await dispatch('put', '/api/client/products/:id', {
      auth: authorization(), params: { id: 'product-b' }, body: { name: 'Intento' },
    })

    expect(response).toEqual({ status: 404, body: { error: 'No encontrado' } })
    expect(getProduct).toHaveBeenCalledWith('business-a', 'product-b')
    expect(updateProduct).not.toHaveBeenCalled()
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('edita un producto propio, limpia media reemplazada y reindexa', async () => {
    const previous = {
      id: 'product-a',
      business_id: 'business-a',
      image_public_id: 'old-image',
      video_public_id: 'old-video',
    }
    const updated = { ...previous, image_public_id: 'new-image', video_public_id: null }
    const getProduct = vi.spyOn(db, 'getProductById')
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(updated)
    const updateProduct = vi.spyOn(db, 'updateProduct').mockResolvedValue({})
    const deleteMedia = vi.spyOn(cloud, 'deleteMedia').mockResolvedValue(undefined)
    const indexProduct = vi.spyOn(bot, 'indexProduct').mockResolvedValue(true)
    const body = { image_public_id: 'new-image', video_public_id: null }

    const response = await dispatch('put', '/api/client/products/:id', {
      auth: authorization(), params: { id: 'product-a' }, body,
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(response.body).toEqual({ ok: true })
    expect(getProduct).toHaveBeenNthCalledWith(1, 'business-a', 'product-a')
    expect(getProduct).toHaveBeenNthCalledWith(2, 'business-a', 'product-a')
    expect(updateProduct).toHaveBeenCalledWith('business-a', 'product-a', body)
    expect(deleteMedia).toHaveBeenCalledWith('old-image', 'image')
    expect(deleteMedia).toHaveBeenCalledWith('old-video', 'video')
    expect(indexProduct).toHaveBeenCalledWith(updated)
  })

  it('elimina lógicamente y reindexa productos pendientes del negocio', async () => {
    const pending = [
      { id: 'product-1', business_id: 'business-a' },
      { id: 'product-2', business_id: 'business-a' },
    ]
    const deleteProduct = vi.spyOn(db, 'deleteProduct').mockResolvedValue({})
    const getPending = vi.spyOn(db, 'getProductsWithoutEmbedding').mockResolvedValue(pending)
    const indexProduct = vi.spyOn(bot, 'indexProduct').mockResolvedValue(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const auth = authorization()

    await dispatch('delete', '/api/client/products/:id', {
      auth, params: { id: 'product-1' },
    })
    const reindex = await dispatch('post', '/api/client/reindex', { auth })

    expect(deleteProduct).toHaveBeenCalledWith('business-a', 'product-1')
    expect(getPending).toHaveBeenCalledWith('business-a')
    expect(indexProduct).toHaveBeenCalledTimes(2)
    expect(reindex.body).toMatchObject({ ok: true, pending: 2 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL TIPO DE PRODUCTO, Y EL FALLO QUE DESTAPÓ
// ═══════════════════════════════════════════════════════════════════════════
//
// `product_type` dice si el producto se ARMA eligiendo otros —un combo—, no de
// qué comida es. Al añadirlo salió a la luz algo peor: editar un producto NO
// miraba si la base había aceptado el cambio, así que un dato inválido
// devolvía «guardado» y el dueño se quedaba creyendo que estaba puesto.
//
// La causa estaba en el tipo: la interfaz declaraba `Promise<unknown>`, o sea
// «aquí no hay error que mirar».

describe('tipo de producto', () => {
  it('acepta los cinco tipos del motor', async () => {
    const crear = vi.spyOn(db, 'createProduct')
      .mockResolvedValue({ data: { id: 'p1' }, error: null })
    vi.spyOn(db, 'getCategories').mockResolvedValue([])
    vi.spyOn(bot, 'indexProduct').mockResolvedValue(undefined)

    for (const tipo of ['simple', 'configurable', 'combo', 'daily_menu', 'weighted']) {
      const r = await dispatch('post', '/api/client/products', {
        auth: authorization(),
        body: { name: 'X', price: 5, product_type: tipo },
      })
      expect(r.status, tipo).toBe(201)
    }
    expect(crear).toHaveBeenCalledTimes(5)
  })

  it('rechaza un tipo inventado con un motivo que se entiende', async () => {
    const crear = vi.spyOn(db, 'createProduct')

    const r = await dispatch('post', '/api/client/products', {
      auth: authorization(),
      body: { name: 'X', price: 5, product_type: 'pizza_gigante' },
    })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/simple, configurable, combo/)
    // Y no llega a la base: el CHECK de PostgreSQL responde con jerga.
    expect(crear).not.toHaveBeenCalled()
  })

  it('al editar también se rechaza antes de escribir', async () => {
    vi.spyOn(db, 'getProductById').mockResolvedValue({ id: 'p1', business_id: 'business-a' })
    const actualizar = vi.spyOn(db, 'updateProduct')

    const r = await dispatch('put', '/api/client/products/:id', {
      auth: authorization(), params: { id: 'p1' },
      body: { product_type: 'lo_que_sea' },
    })

    expect(r.status).toBe(400)
    expect(actualizar).not.toHaveBeenCalled()
  })
})

describe('editar un producto no puede mentir', () => {
  // El fallo real: decía «ok» aunque la base hubiera rechazado el cambio.
  it('si la base rechaza la edición, NO se responde ok', async () => {
    vi.spyOn(db, 'getProductById').mockResolvedValue({ id: 'p1', business_id: 'business-a' })
    vi.spyOn(db, 'updateProduct').mockResolvedValue({
      error: { message: 'violates check constraint "products_motor_check"' },
    })

    const r = await dispatch('put', '/api/client/products/:id', {
      auth: authorization(), params: { id: 'p1' },
      body: { name: 'Nuevo nombre' },
    })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/No se pudo guardar/)
    // El error crudo de PostgreSQL no sale al panel: filtraría nombres de
    // restricciones y tablas.
    expect(JSON.stringify(r.body)).not.toContain('products_motor_check')
  })

  it('una edición que la base acepta sí responde ok', async () => {
    vi.spyOn(db, 'getProductById').mockResolvedValue({ id: 'p1', business_id: 'business-a' })
    vi.spyOn(db, 'updateProduct').mockResolvedValue({ error: null })

    const r = await dispatch('put', '/api/client/products/:id', {
      auth: authorization(), params: { id: 'p1' },
      body: { name: 'Nuevo nombre' },
    })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })
})
