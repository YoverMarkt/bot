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
    // Sin duplicar: `/orders` existe dos veces —GET para la lista de la Cuenta
    // y POST para crear— y son la misma ruta con dos verbos.
    expect([...new Set(rutas.map(r => r.path))].sort()).toEqual([
      '/api/store/:slug',
      '/api/store/:slug/addresses',
      '/api/store/:slug/addresses/:id',
      '/api/store/:slug/addresses/:id/location',
      '/api/store/:slug/catalog',
      '/api/store/:slug/me',
      '/api/store/:slug/orders',
      '/api/store/:slug/orders/:id',
      '/api/store/:slug/orders/:id/proof',
      '/api/store/:slug/payment-info',
      '/api/store/:slug/quote',
      '/api/store/:slug/session/verify',
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
      '/api/store/:slug/addresses/:id',
      '/api/store/:slug/addresses/:id/location',
      '/api/store/:slug/orders',
      '/api/store/:slug/orders/:id',
      '/api/store/:slug/orders/:id/proof',
      '/api/store/:slug/payment-info',
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
    // Sin esto la ruta consulta la base de verdad y la prueba se cuelga cinco
    // segundos: crear un pedido comprueba antes que el cliente no esté
    // bloqueado.
    vi.spyOn(db, 'isCustomerBlocked').mockResolvedValue(false)
  })
  afterEach(() => vi.restoreAllMocks())

  // Regla inviolable #8: la IA conversa, el CÓDIGO calcula. Aquí ni siquiera
  // hay IA — hay un teléfono, que es aún menos de fiar. Si un precio enviado
  // desde la app llegara a la base, cualquiera compraría una pizza a $0.01
  // abriendo las herramientas del navegador.
  // ⚠️ El bloqueo del dueño es TOTAL: si solo callara al bot, quien tenga su
  // enlace guardado seguiría metiendo pedidos y el bloqueo no bloquearía nada.
  it('un cliente bloqueado no puede pedir, ni con su enlace', async () => {
    vi.spyOn(db, 'isCustomerBlocked').mockResolvedValue(true)
    const crear = vi.spyOn(db, 'createStorefrontOrder')

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-a', contactPhone: '593900000001' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'p1', quantity: 1 }], fulfillment: 'pickup' },
    })

    expect(respuesta.status).toBe(403)
    // Ni se intenta: el pedido no llega a la base.
    expect(crear).not.toHaveBeenCalled()
    // Y no se le dice «estás bloqueado»: quien molesta busca una reacción.
    expect(respuesta.body.error).not.toMatch(/bloquead/i)
  })

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

  // ── El nombre se escribe UNA vez ─────────────────────────────────────────
  //
  // La mini app ya precargaba `me.name` en el checkout, pero nadie escribía
  // nunca `business_customers.display_name`: `ensureCustomer` lo intenta con
  // un `upsert` que la fila existente ignora —la crea el bot al mandar el
  // enlace, sin nombre—, y en ese momento el nombre todavía no existe. En la
  // base real: 25 pedidos del mismo cliente y `display_name` en nulo.
  it('recuerda el nombre del cliente para el próximo pedido', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    const recordar = vi.spyOn(db, 'setCustomerDisplayName').mockResolvedValue({ error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { name: '  Yover Rosado  ', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(201)
    expect(recordar).toHaveBeenCalledWith('negocio-a', 'cliente-1', 'Yover Rosado')
  })

  it('no guarda un nombre que no lo es', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    const recordar = vi.spyOn(db, 'setCustomerDisplayName').mockResolvedValue({ error: null })

    for (const name of ['', '   ', 'A']) {
      await ejecutar('/api/store/:slug/orders', 'post', {
        storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
        params: { slug: 'pizzeria' },
        body: { name, items: [{ productId: 'producto-1', quantity: 1 }] },
      })
    }

    expect(recordar).not.toHaveBeenCalled()
  })

  // Recordar el nombre es una comodidad. El pedido ya está creado y aceptado
  // por la base cuando se intenta: que esto falle no puede quitárselo al
  // cliente ni devolverle un error por algo que sí funcionó.
  it('un fallo al recordar el nombre no rompe el pedido', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    vi.spyOn(db, 'setCustomerDisplayName').mockRejectedValue(new Error('base caída'))

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { name: 'Yover', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(201)
    expect(respuesta.body).toEqual({ id: 'pedido-1' })
  })

  // El nombre pertenece al negocio de la SESIÓN, igual que el pedido. Si
  // saliera del slug, se escribiría en la ficha del cliente en otra tienda.
  it('recuerda el nombre en el negocio de la sesión, no en el del slug', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    const recordar = vi.spyOn(db, 'setCustomerDisplayName').mockResolvedValue({ error: null })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'otra-tienda' },
      body: { name: 'Yover', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(recordar.mock.calls[0][0]).toBe('negocio-a')
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

// ── El pin de la dirección ─────────────────────────────────────────────────
//
// La ubicación decide a dónde va un repartidor. Lo que se prueba aquí es que
// ningún fallo del navegador deje al cliente sin poder pedir, y que lo que se
// guarda sea un punto de verdad y no medio dato con pinta de dato.
describe('la ubicación de la dirección', () => {
  const SESION = { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' }
  const DIRECCION = { label: 'Casa', address: 'Calle 4 de Mayo 37' }

  afterEach(() => vi.restoreAllMocks())

  it('guarda el pin y su precisión cuando el cliente lo comparte', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
      body: {
        ...DIRECCION,
        latitude: -1.0546211, longitude: -80.454472, accuracy: 12.55,
        buildingType: 'departamento', courierNotes: 'el timbre no sirve',
      },
    })

    expect(respuesta.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(expect.objectContaining({
      latitude: -1.0546211,
      longitude: -80.454472,
      accuracyM: 12.6,
      buildingType: 'departamento',
      courierNotes: 'el timbre no sirve',
    }))
  })

  // El pin es OPCIONAL. Quien niega el permiso —o abre el enlace dentro de
  // WhatsApp, que no siempre lo reenvía— tiene que poder pedir igual: perder
  // la venta por un dato de ayuda es peor que repartir con la dirección
  // escrita, que es como se repartió siempre.
  it('sin ubicación la dirección se guarda igual', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION, params: { slug: 'pizzeria' }, body: DIRECCION,
    })

    expect(respuesta.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(expect.objectContaining({
      latitude: null, longitude: null, accuracyM: null,
    }))
  })

  // Media coordenada no es medio pin: es un punto en el ecuador o en
  // Greenwich, que es PEOR que no tener nada porque parece un dato.
  it('rechaza media coordenada en vez de guardar un punto inventado', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress')

    for (const mitad of [{ latitude: -1.05 }, { longitude: -80.45 }]) {
      const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
        storefront: SESION, params: { slug: 'pizzeria' }, body: { ...DIRECCION, ...mitad },
      })
      expect(respuesta.status).toBe(400)
      expect(respuesta.body.error).toBe('La ubicación llegó incompleta')
    }
    expect(crear).not.toHaveBeenCalled()
  })

  it('rechaza coordenadas fuera del planeta antes de que las rechace el CHECK', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress')

    for (const fuera of [
      { latitude: 200, longitude: 0 },
      { latitude: 0, longitude: -900 },
      { latitude: 'aquí', longitude: 'allá' },
    ]) {
      const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
        storefront: SESION, params: { slug: 'pizzeria' }, body: { ...DIRECCION, ...fuera },
      })
      expect(respuesta.status).toBe(400)
      expect(respuesta.body.error).toBe('La ubicación no es válida')
    }
    expect(crear).not.toHaveBeenCalled()
  })

  // La precisión es accesoria: el punto vale aunque no sepamos cuánto se
  // equivoca. Descartarla es mejor que tumbar el dato bueno por el adorno.
  it('una precisión rara se descarta sin tumbar el pin', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
      body: { ...DIRECCION, latitude: -1.05, longitude: -80.45, accuracy: -5 },
    })

    expect(respuesta.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(expect.objectContaining({
      latitude: -1.05, longitude: -80.45, accuracyM: null,
    }))
  })

  it('un tipo de edificio inventado no llega a la base', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress')

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
      body: { ...DIRECCION, buildingType: 'castillo' },
    })

    expect(respuesta.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })

  // ── Ponerle el pin a una dirección que ya existía ────────────────────────

  it('le pone la ubicación a una dirección guardada', async () => {
    const ubicar = vi.spyOn(db, 'setCustomerAddressLocation')
      .mockResolvedValue({ id: 'dir-1', latitude: -1.05 })

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id/location', 'put', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-1' },
      body: { latitude: -1.05, longitude: -80.45, accuracy: 9 },
    })

    expect(respuesta.status).toBe(200)
    expect(ubicar).toHaveBeenCalledWith({
      businessId: 'negocio-a',
      customerId: 'cliente-1',
      addressId: 'dir-1',
      latitude: -1.05,
      longitude: -80.45,
      accuracyM: 9,
    })
  })

  // Regla #1: la dirección de otro cliente no se mueve ni sabiendo su id. El
  // `where` de la consulta lleva negocio Y cliente, y aquí se comprueba que la
  // ruta no invente un 200 cuando la base no encontró nada suyo.
  it('una dirección ajena responde 404, sin decir que existe', async () => {
    vi.spyOn(db, 'setCustomerAddressLocation').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id/location', 'put', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-de-otro' },
      body: { latitude: -1.05, longitude: -80.45 },
    })

    expect(respuesta.status).toBe(404)
    expect(respuesta.body.error).toBe('Esa dirección no existe')
  })

  it('sin ubicación no se llama a la base: no hay nada que guardar', async () => {
    const ubicar = vi.spyOn(db, 'setCustomerAddressLocation')

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id/location', 'put', {
      storefront: SESION, params: { slug: 'pizzeria', id: 'dir-1' }, body: {},
    })

    expect(respuesta.status).toBe(400)
    expect(ubicar).not.toHaveBeenCalled()
  })
})

// ── Retirar una dirección ──────────────────────────────────────────────────
//
// Se marca inactiva, no se borra: `orders.address_id` apunta aquí y con él se
// sabe a qué casa pide más un cliente. El destino de cada pedido va congelado
// aparte desde el 2026-08-10, así que retirarla no deja ningún reparto sin
// dirección — antes sí lo habría hecho.
describe('eliminar una dirección', () => {
  const SESION = { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' }

  afterEach(() => vi.restoreAllMocks())

  it('la retira con el negocio y el cliente de la sesión', async () => {
    const retirar = vi.spyOn(db, 'deactivateCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id', 'delete', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-1' },
    })

    expect(respuesta.status).toBe(200)
    // ⚠️ REGLA #1: el negocio y el cliente salen de la sesión, nunca de la URL.
    expect(retirar).toHaveBeenCalledWith({
      businessId: 'negocio-a', customerId: 'cliente-1', addressId: 'dir-1',
    })
  })

  // Decir «existe pero no es tuya» ya sería contar algo de otro cliente.
  it('una dirección ajena responde 404, igual que una que no existe', async () => {
    vi.spyOn(db, 'deactivateCustomerAddress').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id', 'delete', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-de-otro' },
    })

    expect(respuesta.status).toBe(404)
    expect(respuesta.body.error).toBe('Esa dirección no existe')
  })
})

// ── Mis pedidos ────────────────────────────────────────────────────────────
//
// La pestaña de abajo abría el ÚLTIMO pedido directamente. Servía mientras
// solo hubiera uno del que preocuparse; quien ha pedido cinco veces tiene un
// historial, no «un pedido».
describe('la lista de mis pedidos', () => {
  const SESION = { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '593999' }

  afterEach(() => vi.restoreAllMocks())

  // ⚠️ REGLA #1 con un matiz propio de la tienda: aquí no hay JWT, la
  // credencial es el enlace. El teléfono de la SESIÓN es lo único que separa
  // «mis pedidos» de «la bandeja del local».
  it('filtra por el negocio y el teléfono de la sesión', async () => {
    const leer = vi.spyOn(db, 'getStorefrontOrders').mockResolvedValue({ data: [], error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
    })

    expect(respuesta.status).toBe(200)
    expect(leer).toHaveBeenCalledWith({ businessId: 'negocio-a', contactPhone: '593999' })
  })

  // La lista pinta lo que se pidió, igual que el pedido suelto: sin agrupar,
  // cada línea saldría con el nombre a secas y dos pizzas distintas se leerían
  // idénticas en el historial.
  it('devuelve las opciones ya agrupadas', async () => {
    vi.spyOn(db, 'getStorefrontOrders').mockResolvedValue({
      data: [{
        id: 'p1',
        order_items: [{
          product_name: 'Pizza',
          order_item_options: [
            { option_group_name: 'Sabor', option_name: 'Criolla', quantity: 1, group_sort: 0 },
          ],
        }],
      }],
      error: null,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })

    expect(respuesta.body[0].order_items[0].options).toEqual([
      { group: 'Sabor', items: [{ name: 'Criolla', quantity: 1 }] },
    ])
  })

  it('un fallo de la base responde 500, no una lista vacía que parece cierta', async () => {
    vi.spyOn(db, 'getStorefrontOrders').mockResolvedValue({
      data: null, error: { message: 'se cayó' },
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })

    expect(respuesta.status).toBe(500)
  })
})
