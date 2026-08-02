import { describe, expect, it } from 'vitest'
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
