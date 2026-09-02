import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { cachearEstaticos, esInmutable } = require('../dist/lib/cache-estaticos')
const router = require('../dist/routes/storefront.routes')

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE HACE QUE LA MINI APP ABRA RÁPIDO, Y LO QUE FRENA A QUIEN MOLESTA
//
// Las dos cosas se vigilan aquí porque las dos son INVISIBLES: una cabecera
// que se deja de mandar no rompe ninguna pantalla, no sale en ningún log y no
// falla ningún test de negocio. Simplemente, la app vuelve a tardar cinco
// segundos y nadie sabe desde cuándo.
//
// Medido contra producción el 2026-09-06, antes del arreglo:
//   · /t/assets/index-*.js  →  Cache-Control: public, max-age=0
//   · /api/store/:slug      →  1,3-1,6 s
//   · /api/store/:slug/catalog → 1,9-2,4 s
// ═══════════════════════════════════════════════════════════════════════════

describe('qué se guarda el navegador y qué no', () => {
  const cabecerasDe = (ruta) => {
    const puestas = {}
    cachearEstaticos({ setHeader: (k, v) => { puestas[k] = v } }, ruta)
    return puestas['Cache-Control']
  }

  // ⚠️ El fallo que esto vigila: `express.static` sin `setHeaders` para un
  // archivo manda `public, max-age=0`, y el navegador revalida SIEMPRE.
  it('los archivos con hash en el nombre se guardan un año', () => {
    expect(cabecerasDe('/app/dist/assets/index-BkwLoUoU.js')).toContain('immutable')
    expect(cabecerasDe('/app/dist/assets/index-Co-NY-ND.css')).toContain('immutable')
    expect(cabecerasDe('/app/dist/assets/index-BkwLoUoU.js')).toContain('max-age=31536000')
  })

  it('las fuentes también: cambian de nombre el día que cambian', () => {
    expect(cabecerasDe('/t/fuentes/plus-jakarta-sans-latin.woff2')).toContain('immutable')
    expect(esInmutable('/t/fuentes/otra.woff')).toBe(true)
    expect(esInmutable('/t/fuentes/otra.ttf')).toBe(true)
  })

  // ⚠️ Y este es el que NO puede cambiar nunca. El HTML dice qué assets tocan:
  // guardarlo dejaría la app congelada en el despliegue anterior, pidiendo
  // archivos viejos mientras los nuevos ya están publicados.
  it('el HTML NUNCA se guarda, o la app se queda en la versión vieja', () => {
    const html = cabecerasDe('/t/dist/index.html')
    expect(html).toContain('no-store')
    expect(html).not.toContain('immutable')
    expect(html).not.toContain('max-age=31536000')
  })

  it('lo que no lleva hash se guarda poco, no para siempre', () => {
    expect(esInmutable('/t/favicon.ico')).toBe(false)
    expect(cabecerasDe('/t/favicon.ico')).toBe('public, max-age=3600')
  })

  // Un archivo llamado «assets.js» NO está en la carpeta assets/: el nombre no
  // lleva hash y guardarlo un año lo congelaría.
  it('no confunde un archivo llamado «assets» con la carpeta assets/', () => {
    expect(esInmutable('/t/dist/assets.js')).toBe(false)
    expect(esInmutable('/t/dist/mis-assets/cosa.js')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL CATÁLOGO SE GUARDA UNOS SEGUNDOS — Y NUNCA EN UN PROXY COMPARTIDO
// ═══════════════════════════════════════════════════════════════════════════
describe('la caché del catálogo', () => {
  const ejecutarCatalogo = async () => {
    const db = require('../dist/db')
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({
      id: 'negocio-a', slug: 'pizzeria', name: 'Pizzería',
      takes_orders: true, storefront_enabled: true, active: true, suspended: false,
    })
    vi.spyOn(db, 'getSchedule').mockResolvedValue([])
    for (const fn of [
      'getStorefrontCategories', 'getStorefrontProducts', 'getStorefrontVariants',
      'getStorefrontExtras', 'getStorefrontOptionGroups', 'getStorefrontOptions',
      'getStorefrontRecommendations', 'getStorefrontPaymentMethods',
    ]) vi.spyOn(db, fn).mockResolvedValue([])
    vi.spyOn(db, 'getBusinessPricingRule').mockResolvedValue(null)
    // Sin esto la ruta consulta `server_settings` de verdad y la prueba se
    // cuelga cinco segundos esperando a Supabase.
    const canal = require('../dist/services/platform-channel')
    vi.spyOn(canal, 'getPlatformPhone').mockResolvedValue(null)

    const layer = router.stack.find(item => (
      item.route?.path === '/api/store/:slug/catalog' && item.route?.methods?.get
    ))
    const cabeceras = {}
    const req = {
      storeBusinessId: 'negocio-a', params: { slug: 'pizzeria' },
      query: {}, headers: {}, body: {},
    }
    const res = {
      status() { return this },
      json() { return this },
      setHeader(k, v) { cabeceras[k] = v },
    }
    await layer.route.stack.at(-1).handle(req, res, (e) => { if (e) throw e })
    vi.restoreAllMocks()
    return cabeceras
  }

  // ⚠️ `private`, y es una DEFENSA, no una preferencia. Con `public`, un proxy
  // compartido podría guardarse este 200 y servírselo luego a alguien
  // BLOQUEADO, que debe recibir el 403 de `readStorefrontSession`. La mejora
  // real sale igual del navegador de cada cliente.
  it('se guarda en el teléfono del cliente, NUNCA en un proxy compartido', async () => {
    const cabeceras = await ejecutarCatalogo()
    expect(cabeceras['Cache-Control']).toContain('private')
    expect(cabeceras['Cache-Control']).not.toContain('public')
  })

  it('poco tiempo: los precios y el horario viajan aquí', async () => {
    const cabeceras = await ejecutarCatalogo()
    const segundos = Number(/max-age=(\d+)/.exec(cabeceras['Cache-Control'])?.[1])
    expect(segundos).toBeGreaterThan(0)
    expect(segundos).toBeLessThanOrEqual(60)
  })

  // Si algún día esto pasara a `public`, dos enlaces distintos no pueden
  // compartir entrada de caché. Es barato ahora y evita que ese cambio futuro
  // sea silenciosamente inseguro.
  it('distingue por enlace, para que ese cambio futuro no sea inseguro', async () => {
    const cabeceras = await ejecutarCatalogo()
    expect(String(cabeceras.Vary).toLowerCase()).toContain('x-storefront-token')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DOS EJES DE LÍMITE, PORQUE CADA UNO TAPA EL AGUJERO DEL OTRO
// ═══════════════════════════════════════════════════════════════════════════
//
// Solo por IP falla en las dos direcciones con datos móviles: los clientes de
// un operador salen por la misma IP (CGNAT), así que uno que molesta gasta el
// cupo de vecinos que no hicieron nada; y quien apaga y enciende los datos
// estrena IP y recupera el cupo entero.
describe('el límite por enlace, además del de IP', () => {
  const middlewares = router.stack
    .filter(l => !l.route && l.regexp?.test('/api/store/pizzeria'))

  it('la tienda pasa por DOS limitadores, no por uno', () => {
    // Si alguien quita uno de los dos, esta cuenta lo dice.
    expect(middlewares.length).toBeGreaterThanOrEqual(2)
  })

  const correr = async (handler, req) => new Promise((resolve) => {
    const res = {
      status(code) { this.code = code; return this },
      json() { resolve(this.code || 200); return this },
      setHeader() { return this },
      getHeader() { return undefined },
      removeHeader() { return this },
      send() { resolve(this.code || 200); return this },
      headersSent: false,
    }
    handler(req, res, () => resolve(200))
  })

  const peticion = (token) => ({
    method: 'GET',
    url: '/api/store/pizzeria',
    ip: '1.2.3.4',
    ips: [],
    headers: token ? { 'x-storefront-token': token } : {},
    query: {},
    app: { get: () => true },
    socket: { remoteAddress: '1.2.3.4' },
  })

  // El corazón del asunto: dos enlaces distintos son dos contadores distintos,
  // aunque compartan la IP del operador.
  it('dos enlaces distintos NO comparten cupo aunque compartan IP', async () => {
    const limitador = middlewares.at(-1).handle
    let bloqueado = false
    for (let i = 0; i < 70; i += 1) {
      const codigo = await correr(limitador, peticion('enlace-de-ana'))
      if (codigo === 429) { bloqueado = true; break }
    }
    expect(bloqueado, 'el enlace que abusa debe toparse').toBe(true)

    // Y el de al lado, con la MISMA IP, sigue entrando.
    const otro = await correr(limitador, peticion('enlace-de-luis'))
    expect(otro, 'el vecino no paga el abuso del otro').not.toBe(429)
  })

  // Quien llega SIN enlace no lo cuenta este limitador: de ese se ocupa el de
  // IP, que sigue en pie. Sin este salto, todos los visitantes anónimos
  // compartirían una sola clave y se estorbarían entre sí.
  it('a quien llega sin enlace lo deja pasar: de ese se ocupa el de IP', async () => {
    const limitador = middlewares.at(-1).handle
    for (let i = 0; i < 80; i += 1) {
      const codigo = await correr(limitador, peticion(null))
      expect(codigo).not.toBe(429)
    }
  })
})
