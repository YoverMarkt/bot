import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const router = require('../dist/routes/storefront.routes')

// Guardián de las rutas de la mini app.
//
// Son las ÚNICAS rutas públicas del proyecto: no llevan JWT, la credencial es
// el enlace que mandó el bot. Una ruta añadida aquí sin `requireStorefrontSession`
// deja la tienda abierta a cualquiera, así que se comprueba una por una.

const rutas = router.stack
  .filter(layer => layer.route)
  .map(layer => ({
    path: layer.route.path,
    // El primer handler es el propio router; los middlewares van antes del final.
    handlers: layer.route.stack.length,
  }))

// Dos rutas viven sin sesión, y cada una por su motivo:
//  · la portada, que es lo que ve quien no tiene enlace;
//  · el enlace corto, que NO devuelve datos — solo redirige. Con un token
//    inventado no se averigua nada, y quien llega con el suyo ya lo tenía.
const PUBLICA = '/api/store/:slug'
const ENLACE_CORTO = '/s/:code'
const SIN_SESION = [PUBLICA, ENLACE_CORTO]

describe('rutas de la mini app', () => {
  it('expone las rutas esperadas y ninguna más', () => {
    expect(rutas.map(r => r.path).sort()).toEqual([
      '/api/store/:slug',
      '/api/store/:slug/addresses',
      '/api/store/:slug/catalog',
      '/api/store/:slug/me',
      '/api/store/:slug/orders',
      '/api/store/:slug/orders/:id/proof',
      '/api/store/:slug/payment-info',
      '/api/store/:slug/stay/quote',
      '/api/store/:slug/stay/request',
      '/s/:code',
    ].sort())
  })

  // Si alguien añade una ruta y olvida el middleware, este test lo caza.
  it('toda ruta salvo la portada exige sesión del enlace', () => {
    const sinProteger = rutas
      .filter(ruta => !SIN_SESION.includes(ruta.path) && ruta.handlers < 2)
      .map(ruta => ruta.path)
    expect(sinProteger).toEqual([])
  })

  it('solo la portada y el enlace corto viven sin sesión', () => {
    for (const path of SIN_SESION) {
      const ruta = rutas.find(r => r.path === path)
      expect(ruta, path).toBeTruthy()
      expect(ruta.handlers, path).toBe(1)
    }
  })

  // El enlace corto es la puerta que se manda por WhatsApp: si algún día
  // devolviera datos en vez de redirigir, sería una tienda abierta a cualquiera
  // que pruebe tokens. Aquí se fija que su única salida es una redirección.
  it('el enlace corto solo redirige, nunca responde con datos', () => {
    const fuente = fs.readFileSync('dist/routes/storefront.routes.js', 'utf8')
    const bloque = fuente.slice(fuente.indexOf("'/s/:code'"))
    const cuerpo = bloque.slice(0, bloque.indexOf('router.get(\'/api/store/:slug\''))
    expect(cuerpo).toContain('res.redirect')
    expect(cuerpo).not.toContain('res.json')
  })

  // Crear pedidos lleva su propio límite, más estricto que el general.
  it('crear pedido tiene un middleware extra de límite', () => {
    const pedidos = rutas.find(ruta => ruta.path === '/api/store/:slug/orders')
    const catalogo = rutas.find(ruta => ruta.path === '/api/store/:slug/catalog')
    expect(pedidos.handlers).toBeGreaterThan(catalogo.handlers)
  })

  // Cotizar una estadía dispara una RPC cara y solicitarla crea una retención:
  // ninguna de las dos puede quedarse solo con el límite general.
  it('las rutas de hospedaje llevan su propio límite', () => {
    const catalogo = rutas.find(ruta => ruta.path === '/api/store/:slug/catalog')
    for (const path of ['/api/store/:slug/stay/quote', '/api/store/:slug/stay/request']) {
      const ruta = rutas.find(r => r.path === path)
      expect(ruta, path).toBeTruthy()
      expect(ruta.handlers, path).toBeGreaterThan(catalogo.handlers)
    }
  })

  it('el router aplica un límite de peticiones a todo /api/store', () => {
    const limitador = router.stack.find(
      layer => !layer.route && String(layer.regexp).includes('store'),
    )
    expect(limitador).toBeTruthy()
  })
})

// ── Comportamiento de los manejadores ──────────────────────────────────────
//
// Lo de arriba comprueba el CABLEADO: qué rutas existen y qué middleware
// llevan. Nada de eso ejecuta un manejador, y por eso la cobertura de este
// archivo estaba en 21%: nadie había hecho nunca un pedido por aquí.
//
// Es el camino que usa el cliente final desde su teléfono, así que estas
// pruebas van a lo que no se puede fallar: que el precio lo ponga el servidor
// y que un negocio no vea lo de otro.

const db = require('../dist/db')

// Ejecuta un manejador saltándose los middlewares: la sesión ya se comprueba
// en las pruebas de cableado y en storefront-session.test.js.
async function ejecutar(path, method, { storefront, body = {}, params = {} } = {}) {
  const layer = router.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
  const handler = layer.route.stack.at(-1).handle
  const req = { storefront, body, params, query: {}, headers: {} }
  const resultado = { status: 200, body: undefined }
  const res = {
    status(code) { resultado.status = code; return this },
    json(value) { resultado.body = value; return this },
  }
  await handler(req, res, error => { if (error) throw error })
  return resultado
}

const NEGOCIO_ABIERTO = {
  id: 'negocio-a', slug: 'pizzeria', name: 'Pizzería',
  takes_orders: true, storefront_enabled: true, active: true, suspended: false,
}

describe('crear pedido desde la mini app', () => {
  beforeEach(() => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(NEGOCIO_ABIERTO)
    vi.spyOn(db, 'getSchedule').mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  // Regla inviolable #8: la IA conversa, el CÓDIGO calcula. Aquí ni siquiera
  // hay IA — hay un teléfono, que es aún menos de fiar. Si un precio enviado
  // desde la app llegara a la base, cualquiera compraría una pizza a $0.01
  // abriendo las herramientas del navegador.
  it('descarta cualquier precio que mande el teléfono', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1', total: 1250 }, error: null,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        items: [{
          productId: 'producto-1', quantity: 2,
          price: 1, unit_price: 1, total: 1, precio: 1,
        }],
      },
    })

    expect(respuesta.status).toBe(201)
    const enviado = crear.mock.calls[0][0]
    // Del ítem solo sobreviven identificadores y cantidad.
    expect(enviado.items).toEqual([{
      product_id: 'producto-1', variant_id: null, extra_ids: [], quantity: 2, note: null,
    }])
    expect(JSON.stringify(enviado)).not.toContain('price')
    expect(JSON.stringify(enviado)).not.toContain('precio')
  })

  // El negocio sale de la SESIÓN, nunca del slug de la dirección. Si saliera
  // del slug, cambiar una palabra en la barra bastaría para pedir en otra
  // tienda con la sesión propia.
  it('usa el negocio de la sesión y no el slug de la dirección', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'otra-tienda' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(crear.mock.calls[0][0].businessId).toBe('negocio-a')
  })

  // 42501 lo lanza la RPC cuando el producto es de otro negocio. Devolver 500
  // lo haría parecer un fallo nuestro y escondería un intento de cruzar la
  // frontera entre negocios.
  it('traduce el rechazo por pertenencia a 403, no a error del servidor', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: null, error: { code: '42501', message: 'producto ajeno' },
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-de-otro', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(403)
  })

  it('rechaza un pedido sin productos antes de tocar la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder')

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [] },
    })

    expect(respuesta.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })

  // El horario del dueño manda también aquí, no solo en el bot.
  it('no acepta pedidos con el negocio cerrado', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder')
    vi.spyOn(db, 'getSchedule').mockResolvedValue([
      { day_of_week: 0, open_time: '00:00', close_time: '00:01', is_active: true },
      { day_of_week: 1, open_time: '00:00', close_time: '00:01', is_active: true },
      { day_of_week: 2, open_time: '00:00', close_time: '00:01', is_active: true },
      { day_of_week: 3, open_time: '00:00', close_time: '00:01', is_active: true },
      { day_of_week: 4, open_time: '00:00', close_time: '00:01', is_active: true },
      { day_of_week: 5, open_time: '00:00', close_time: '00:01', is_active: true },
      { day_of_week: 6, open_time: '00:00', close_time: '00:01', is_active: true },
    ])

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(409)
    expect(crear).not.toHaveBeenCalled()
  })
})
