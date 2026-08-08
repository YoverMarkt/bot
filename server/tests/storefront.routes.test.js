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

// Tres rutas viven sin `requireStorefrontSession`, y cada una por su motivo:
//  · la portada, que es lo que ve quien no tiene enlace;
//  · el enlace corto, que NO devuelve datos — solo redirige. Con un token
//    inventado no se averigua nada, y quien llega con el suyo ya lo tenía;
//  · la verificación del número, que no PUEDE llevar el middleware: rechaza
//    justo el estado en el que se llega a ella ('necesita_telefono'). Es la
//    puerta, no una habitación.
const PUBLICA = '/api/store/:slug'
const ENLACE_CORTO = '/s/:code'
const VERIFICACION = '/api/store/:slug/session/verify'
const CATALOGO = '/api/store/:slug/catalog'
const SIN_SESION = [PUBLICA, ENLACE_CORTO, VERIFICACION]
// El catálogo es público: se ve sin enlace. Va aparte de `SIN_SESION` porque sí
// lleva middleware —`readStorefrontSession`, que reclama el dispositivo cuando
// el enlace SÍ viene— y contarlo con los demás lo daría por protegido.
const COTIZAR = '/api/store/:slug/quote'
const PUBLICAS = [...SIN_SESION, CATALOGO, COTIZAR]

describe('rutas de la mini app', () => {
  it('expone las rutas esperadas y ninguna más', () => {
    expect(rutas.map(r => r.path).sort()).toEqual([
      '/api/store/:slug',
      '/api/store/:slug/addresses',
      '/api/store/:slug/catalog',
      '/api/store/:slug/me',
      '/api/store/:slug/orders',
      '/api/store/:slug/orders/:id',
      '/api/store/:slug/orders/:id/proof',
      '/api/store/:slug/payment-info',
      '/api/store/:slug/quote',
      '/api/store/:slug/session/verify',
      '/api/store/:slug/stay/quote',
      '/api/store/:slug/stay/request',
      '/s/:code',
    ].sort())
  })

  // Si alguien añade una ruta y olvida el middleware, este test lo caza.
  it('toda ruta salvo las públicas exige sesión del enlace', () => {
    const sinProteger = rutas
      .filter(ruta => !PUBLICAS.includes(ruta.path) && ruta.handlers < 2)
      .map(ruta => ruta.path)
    expect(sinProteger).toEqual([])
  })

  // Contar middlewares no basta: `readStorefrontSession` también cuenta como
  // uno, y el catálogo pasaría por protegido sin estarlo. Aquí se mira CUÁL
  // lleva cada ruta, que es lo que de verdad decide quién entra.
  //
  // La distinción es la que sostiene el catálogo público: mirar la carta no
  // pide enlace; crear un pedido, ver direcciones o el perfil, sí.
  it('cada ruta lleva el middleware que le toca, no uno cualquiera', () => {
    const fuente = fs.readFileSync('dist/routes/storefront.routes.js', 'utf8')
    const middlewareDe = (path) => {
      const desde = fuente.indexOf(`'${path}'`)
      expect(desde, `no se encontró la ruta ${path}`).toBeGreaterThan(-1)
      const linea = fuente.slice(desde, fuente.indexOf('\n', desde))
      if (linea.includes('requireStorefrontSession')) return 'exige'
      if (linea.includes('readStorefrontSession')) return 'opcional'
      return 'ninguno'
    }

    // El catálogo se ve sin enlace, y cotizar tampoco lo pide: no crea nada,
    // solo dice cuánto costaría. Crear el pedido sí.
    expect(middlewareDe(CATALOGO)).toBe('opcional')
    expect(middlewareDe(COTIZAR)).toBe('opcional')

    // Todo lo que escribe o devuelve datos de una PERSONA lo sigue exigiendo.
    for (const path of [
      '/api/store/:slug/me',
      '/api/store/:slug/addresses',
      '/api/store/:slug/orders',
      '/api/store/:slug/orders/:id',
      '/api/store/:slug/orders/:id/proof',
      '/api/store/:slug/payment-info',
      '/api/store/:slug/stay/quote',
      '/api/store/:slug/stay/request',
    ]) {
      expect(middlewareDe(path), path).toBe('exige')
    }
  })

  // La garantía que hace que abrir el catálogo no abra nada más: el middletware
  // opcional deja el negocio en `storeBusinessId` y el cliente SOLO en
  // `storefront`. Si el negocio sin sesión entrara en `storefront`, una ruta
  // que lea `storefront.customerId` crearía un pedido sin cliente.
  it('el catálogo público no puede dejar una sesión a medias', () => {
    const fuente = fs.readFileSync('dist/middleware/storefront.js', 'utf8')
    const bloque = fuente.slice(fuente.indexOf('readStorefrontSession'))
    expect(bloque).toContain('storeBusinessId')
    // Solo se asigna `storefront` cuando hay sesión completa.
    expect(bloque).toMatch(/if \(session\)\s*req\.storefront = session/)
  })

  it('las rutas sin sesión son exactamente esas tres, y no más', () => {
    for (const path of [PUBLICA, ENLACE_CORTO]) {
      const ruta = rutas.find(r => r.path === path)
      expect(ruta, path).toBeTruthy()
      expect(ruta.handlers, path).toBe(1)
    }
  })

  // La verificación no lleva sesión, pero SÍ tiene que llevar freno: es donde
  // se adivinarían números de teléfono a lo bruto. Sin esto pasaría el
  // guardián de arriba por tener dos handlers, sin que el segundo protegiera
  // nada — un verde por accidente.
  it('la verificación del número va con rate limit propio', () => {
    const ruta = rutas.find(r => r.path === VERIFICACION)
    expect(ruta).toBeTruthy()
    expect(ruta.handlers).toBe(2)
    const fuente = fs.readFileSync('dist/routes/storefront.routes.js', 'utf8')
    expect(fuente).toContain('verifyLimiter')
    // Ocho por minuto: suficiente para quien se equivoca escribiendo, inútil
    // para quien prueba números en serie.
    const bloque = fuente.slice(fuente.indexOf('verifyLimiter'))
    expect(bloque).toMatch(/max:\s*8/)
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
          // Las opciones son la puerta nueva por la que podría colarse un
          // importe: llevan su propio recargo en el catálogo.
          options: [{ optionId: 'opcion-1', quantity: 3, price: 0.01, recargo: -99 }],
        }],
      },
    })

    expect(respuesta.status).toBe(201)
    const enviado = crear.mock.calls[0][0]
    // Del ítem solo sobreviven identificadores y cantidades.
    expect(enviado.items).toEqual([{
      product_id: 'producto-1',
      variant_id: null,
      extra_ids: [],
      options: [{ option_id: 'opcion-1', quantity: 3 }],
      quantity: 2,
      note: null,
    }])
    expect(JSON.stringify(enviado)).not.toContain('price')
    expect(JSON.stringify(enviado)).not.toContain('precio')
    expect(JSON.stringify(enviado)).not.toContain('recargo')
  })

  // Un doble toque en «Confirmar» creaba dos comandas en la cocina y un
  // cliente pagando dos veces. La app manda una clave por carrito; la base
  // devuelve el mismo pedido si ya existe uno con ella.
  it('pasa la clave del pedido tal cual, para que no se dupliquen', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        idempotencyKey: 'clave-del-carrito',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })

    expect(crear.mock.calls[0][0].idempotencyKey).toBe('clave-del-carrito')
  })

  // Elegir «entrega» o «retiro» pasó a hacerse también en la portada de la
  // tienda, no solo en el carrito. Lo que llegue aquí decide si el pedido sale
  // con dirección y si se cobra envío, así que se comprueba que viaja entero
  // hasta la base y que un valor inventado no se cuela.
  it('el modo de entrega elegido viaja hasta la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    for (const modo of ['delivery', 'pickup', 'onsite']) {
      crear.mockClear()
      await ejecutar('/api/store/:slug/orders', 'post', {
        storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
        params: { slug: 'pizzeria' },
        body: { fulfillment: modo, items: [{ productId: 'producto-1', quantity: 1 }] },
      })
      expect(crear.mock.calls[0][0].fulfillment).toBe(modo)
    }
  })

  it('un modo de entrega inventado no llega a la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    // Nulo, no el texto tal cual: la base decide entonces su propio defecto en
    // vez de guardar «gratis_para_mi» en la columna del modo de entrega.
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { fulfillment: 'gratis_para_mi', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(crear.mock.calls[0][0].fulfillment).toBeNull()
  })

  // ── Seguimiento del pedido ─────────────────────────────────────────────
  //
  // Aquí se devuelve el pedido de UNA persona, con su número y su estado. La
  // sesión no basta por sí sola: hay que atarlo al TELÉFONO de esa sesión, o
  // cualquiera con un enlace válido de esta tienda leería pedidos ajenos
  // probando identificadores.
  it('el seguimiento filtra por el teléfono de la sesión, no solo por el pedido', async () => {
    const consultar = vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1', order_number: 8, status: 'preparacion', events: [] }, error: null,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders/:id', 'get', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria', id: 'pedido-1' },
    })

    expect(respuesta.status).toBe(200)
    expect(consultar).toHaveBeenCalledWith({
      businessId: 'negocio-a',
      contactPhone: '+593999',
      orderId: 'pedido-1',
    })
  })

  // Un pedido ajeno y uno inexistente responden IGUAL. Si se distinguieran,
  // se podría averiguar qué pedidos tiene el vecino probando identificadores.
  it('un pedido que no es suyo responde 404, como uno que no existe', async () => {
    vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({ data: null, error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders/:id', 'get', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria', id: 'pedido-de-otro' },
    })

    expect(respuesta.status).toBe(404)
    expect(respuesta.body.error).toMatch(/No encontramos/)
  })

  // ── El método de pago y las instrucciones ──────────────────────────────

  it('«pago al retirar» no se acepta en un pedido a domicilio', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    // En retiro sí: es cuando de verdad se puede cumplir.
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        fulfillment: 'pickup', paymentMethod: 'pago_al_retirar',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].paymentMethod).toBe('pago_al_retirar')

    // A domicilio no: prometerle al negocio que alguien pasará a recoger un
    // pedido que va a llevarle el repartidor es prometer lo que no ocurrirá.
    crear.mockClear()
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        fulfillment: 'delivery', paymentMethod: 'pago_al_retirar',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].paymentMethod).toBeNull()
  })

  it('las instrucciones del cliente viajan, recortadas al tope de la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        deliveryNotes: '  Llame al llegar, timbre roto  ',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].deliveryNotes).toBe('Llame al llegar, timbre roto')

    // El CHECK de la base corta en 300: recortar aquí evita que un texto largo
    // reviente el pedido entero en vez de perder solo la cola del mensaje.
    crear.mockClear()
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        deliveryNotes: 'x'.repeat(500),
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].deliveryNotes).toHaveLength(300)
  })

  it('sin clave se sigue creando un pedido por envío, como el bot', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(crear.mock.calls[0][0].idempotencyKey).toBeNull()
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
  //
  // ⚠️ La hora se FIJA. Antes el horario de prueba era 00:00–00:01 todos los
  // días, así que el test fallaba si se corría dentro de ese minuto — y pasó,
  // justo a las 00:00. Un test que depende del reloj real es una alarma que
  // suena sola una vez al día.
  it('no acepta pedidos con el negocio cerrado', async () => {
    // Un lunes a las 22:00 de Ecuador, con el local cerrado desde las 18:00.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T03:00:00Z'))

    const crear = vi.spyOn(db, 'createStorefrontOrder')
    vi.spyOn(db, 'getSchedule').mockResolvedValue(
      [1, 2, 3, 4, 5].map(day => ({
        day_of_week: day, open_time: '09:00', close_time: '18:00', is_active: true,
      })),
    )

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(409)
    expect(crear).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  // Un negocio SUSPENDIDO no recibe pedidos: `cerrada` es temporal y puede
  // abrir en una hora; `suspendida` significa que esta tienda no vende.
  it('un negocio suspendido no acepta pedidos', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder')
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({
      id: 'negocio-a', active: true, suspended: true,
      storefront_enabled: true, takes_orders: true,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(409)
    expect(crear).not.toHaveBeenCalled()
  })
})
