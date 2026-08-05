import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const {
  readStorefrontSession,
  requireStorefrontSession,
} = require('../dist/middleware/storefront')
const { hashToken } = require('../dist/services/storefront-session')

// ═══════════════════════════════════════════════════════════════════════════
// LA PUERTA DE TODAS LAS RUTAS DE LA TIENDA
// ═══════════════════════════════════════════════════════════════════════════
//
// Estaba al 18,9 % de cobertura, y es el único sitio donde se decide si quien
// abre el enlace puede ver el catálogo, sus direcciones o pedir a su nombre.
// Un endpoint que se olvide del middleware es una tienda abierta a cualquiera;
// que el middleware se equivoque es lo mismo para TODOS los endpoints a la vez.

const SESION = {
  id: 's1', business_id: 'biz-1', customer_id: 'c1',
  contact_phone: '593999111222',
  device_hash: null, claimed_at: null,
  expires_at: null, revoked_at: null, verified_at: null,
}

afterEach(() => { vi.restoreAllMocks() })

async function pasar({ token = 'tok', slug = 'pizzeria', device = 'movil-de-juan' } = {}) {
  const req = {
    headers: {
      ...(token ? { 'x-storefront-token': token } : {}),
      'x-storefront-device': device,
      'user-agent': 'iPhone', 'accept-language': 'es-EC',
    },
    params: { slug }, query: {},
  }
  const salida = { status: 200, body: undefined, siguio: false }
  const res = {
    status(code) { salida.status = code; return this },
    json(cuerpo) { salida.body = cuerpo; return this },
  }
  await requireStorefrontSession(req, res, (error) => {
    if (error) throw error
    salida.siguio = true
  })
  return { ...salida, req }
}

describe('quién puede entrar a la tienda', () => {
  it('sin token no pasa', async () => {
    const r = await pasar({ token: '' })
    expect(r.siguio).toBe(false)
    expect(r.status).toBe(401)
  })

  it('sin slug no pasa', async () => {
    const r = await pasar({ slug: '' })
    expect(r.siguio).toBe(false)
    expect(r.status).toBe(401)
  })

  it('tienda inexistente no pasa', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(null)
    const r = await pasar()
    expect(r.siguio).toBe(false)
    expect(r.status).toBe(401)
  })

  it('token sin confirmar el número no pasa, y lo dice', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(SESION)

    const r = await pasar()

    expect(r.siguio).toBe(false)
    expect(r.status).toBe(401)
    // El motivo importa: la app lo usa para pintar la pantalla del número en
    // vez de la de "pide otro enlace".
    expect(r.body.reason).toBe('necesita_telefono')
  })

  it('el dispositivo ya confirmado pasa, y deja resuelto quién es', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    const { deviceFingerprint } = require('../dist/services/storefront-session')
    const huella = deviceFingerprint({
      clientId: 'movil-de-juan', userAgent: 'iPhone', acceptLanguage: 'es-EC',
    })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue({
      ...SESION, device_hash: huella, claimed_at: '2026-08-02',
    })
    vi.spyOn(db, 'touchStorefrontSession').mockResolvedValue(undefined)

    const r = await pasar()

    expect(r.siguio).toBe(true)
    // Las rutas no vuelven a mirarlo: si esto se equivoca, se equivocan todas.
    expect(r.req.storefront).toEqual({
      businessId: 'biz-1', customerId: 'c1',
      contactPhone: '593999111222', sessionId: 's1',
    })
  })

  it('una sesión de OTRO negocio no abre esta tienda', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-2' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(SESION)

    const r = await pasar({ slug: 'hostal' })

    expect(r.siguio).toBe(false)
    expect(r.body.reason).toBe('otro_negocio')
  })

  it('una sesión revocada no pasa', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue({
      ...SESION, revoked_at: '2026-08-02',
    })
    const r = await pasar()
    expect(r.siguio).toBe(false)
    expect(r.body.reason).toBe('revocada')
  })

  it('el token se busca por hash, nunca en claro', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    const buscar = vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(null)

    await pasar({ token: 'mi-token-secreto' })

    expect(buscar).toHaveBeenCalledWith(hashToken('mi-token-secreto'))
    expect(buscar).not.toHaveBeenCalledWith('mi-token-secreto')
  })

  it('si la base revienta, no se cuela nadie', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockRejectedValue(new Error('base caída'))
    let recibido = null
    const req = { headers: { 'x-storefront-token': 'tok' }, params: { slug: 'x' }, query: {} }
    const res = { status() { return this }, json() { return this } }
    await requireStorefrontSession(req, res, (error) => { recibido = error })
    // Va al manejador de errores de Express, no a la ruta: un fallo de
    // infraestructura no puede acabar en "adelante, pasa".
    expect(recibido).toBeInstanceOf(Error)
    expect(req.storefront).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA PUERTA DEL CATÁLOGO, QUE ES PÚBLICA
// ═══════════════════════════════════════════════════════════════════════════
//
// Ver la carta no pide enlace: se reenvía por WhatsApp, se pega en una historia
// y se busca. Pero abrir el catálogo NO puede abrir nada más, y esa diferencia
// vive entera aquí.
//
// Lo que se comprueba es que sigue haciendo lo que hacía de paso cuando SÍ hay
// enlace —reclamar el dispositivo y refrescar la sesión—, porque abrir el
// catálogo era justo el momento en que eso ocurría.

/** Una sesión cuyo dueño ya confirmó su número desde ESTE dispositivo. */
function sesionConfirmada(device = 'movil-de-juan') {
  const { deviceFingerprint } = require('../dist/services/storefront-session')
  return {
    ...SESION,
    device_hash: deviceFingerprint({
      clientId: device, userAgent: 'iPhone', acceptLanguage: 'es-EC',
    }),
    claimed_at: '2026-08-02',
  }
}

async function mirar({ token = '', slug = 'pizzeria', device = 'movil-de-juan' } = {}) {
  const req = {
    headers: {
      ...(token ? { 'x-storefront-token': token } : {}),
      'x-storefront-device': device,
      'user-agent': 'iPhone', 'accept-language': 'es-EC',
    },
    params: { slug }, query: {},
  }
  const salida = { status: 200, body: undefined, siguio: false }
  const res = {
    status(code) { salida.status = code; return this },
    json(cuerpo) { salida.body = cuerpo; return this },
  }
  await readStorefrontSession(req, res, (error) => {
    if (error) throw error
    salida.siguio = true
  })
  return { ...salida, req }
}

describe('quién puede ver el catálogo', () => {
  it('sin enlace se ve la carta, pero sin ser nadie', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    const r = await mirar({ token: '' })
    expect(r.siguio).toBe(true)
    expect(r.req.storeBusinessId).toBe('biz-1')
    // Lo que sostiene todo lo demás: sin sesión no hay cliente.
    expect(r.req.storefront).toBeUndefined()
  })

  it('una tienda que no existe da 404, no un catálogo vacío', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(null)
    const r = await mirar({ token: '' })
    expect(r.siguio).toBe(false)
    expect(r.status).toBe(404)
  })

  it('con enlace válido sí identifica al cliente', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(sesionConfirmada())
    vi.spyOn(db, 'touchStorefrontSession').mockResolvedValue(undefined)

    const r = await mirar({ token: 'tok' })
    expect(r.siguio).toBe(true)
    expect(r.req.storefront.customerId).toBe('c1')
    expect(r.req.storefront.contactPhone).toBe('593999111222')
  })

  // Lo que HACÍA DE PASO el middleware obligatorio y no puede perderse. Ojo:
  // atar el dispositivo NO ocurre aquí —eso vive en `/session/verify`, que sigue
  // exigiendo el número—; lo que sí pasaba por el catálogo es el refresco de la
  // sesión, y sin él un cliente que solo mira la carta parecería inactivo.
  it('sigue refrescando la sesión de quien trae su enlace', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(sesionConfirmada())
    const refrescar = vi.spyOn(db, 'touchStorefrontSession').mockResolvedValue(undefined)

    await mirar({ token: 'tok' })

    expect(refrescar).toHaveBeenCalledWith('s1')
  })

  // Quien tiene enlace pero aún no ha confirmado su número ve la carta igual
  // que cualquiera. Antes se quedaba en la pantalla de confirmación sin llegar
  // a ver nada, que es la peor primera impresión posible.
  it('con enlace sin confirmar se ve la carta, sin ser nadie', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(SESION)
    const r = await mirar({ token: 'tok' })
    expect(r.siguio).toBe(true)
    expect(r.req.storeBusinessId).toBe('biz-1')
    expect(r.req.storefront).toBeUndefined()
  })

  // ── Las fronteras: un token que no vale NUNCA identifica a nadie ─────────

  it('un enlace de OTRO negocio no identifica al cliente aquí', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue({
      ...sesionConfirmada(), business_id: 'biz-2',
    })
    const r = await mirar({ token: 'tok' })
    // Ve el catálogo, como cualquiera…
    expect(r.siguio).toBe(true)
    expect(r.req.storeBusinessId).toBe('biz-1')
    // …pero no es el cliente de la otra tienda.
    expect(r.req.storefront).toBeUndefined()
  })

  it('un enlace revocado deja mirar, pero no ser nadie', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue({
      ...sesionConfirmada(), revoked_at: '2026-08-02',
    })
    const r = await mirar({ token: 'tok' })
    expect(r.siguio).toBe(true)
    expect(r.req.storefront).toBeUndefined()
  })

  it('un token inventado deja mirar, pero no ser nadie', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(null)
    const r = await mirar({ token: 'me-lo-invento' })
    expect(r.siguio).toBe(true)
    expect(r.req.storefront).toBeUndefined()
  })

  it('si la base revienta, no se cuela nadie tampoco por aquí', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockRejectedValue(new Error('base caída'))
    let recibido = null
    const req = { headers: {}, params: { slug: 'x' }, query: {} }
    const res = { status() { return this }, json() { return this } }
    await readStorefrontSession(req, res, (error) => { recibido = error })
    expect(recibido).toBeInstanceOf(Error)
    expect(req.storefront).toBeUndefined()
    expect(req.storeBusinessId).toBeUndefined()
  })
})
