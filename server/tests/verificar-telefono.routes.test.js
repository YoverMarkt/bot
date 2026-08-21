import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import storefrontRouter from '../dist/routes/storefront.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const { hashToken } = require('../dist/services/storefront-session')

// ═══════════════════════════════════════════════════════════════════════════
// LA PUERTA DEL ENLACE: POST /api/store/:slug/session/verify
// ═══════════════════════════════════════════════════════════════════════════
//
// El enlace ya no caduca, así que esta ruta ES lo que lo protege. Merece test
// propio: es el único sitio donde un número equivocado tiene que separar al
// dueño del enlace de quien lo recibió reenviado.
//
// Lo que se comprueba aquí y no en `enlace-permanente.test.js` (que prueba la
// función pura) es el contrato HTTP: qué código sale, qué se le cuenta a quien
// falla, y —lo más importante— que la sesión NO se ate cuando el número no
// coincide.

const RUTA = '/api/store/:slug/session/verify'
const TOKEN = 'token-de-juan'

const sesionDeJuan = {
  id: 's1', business_id: 'biz-1', customer_id: 'c1',
  contact_phone: '593999111222',
  device_hash: null, claimed_at: null,
  expires_at: null, revoked_at: null, verified_at: null,
}

afterEach(() => { vi.restoreAllMocks() })

async function llamar({ slug = 'pizzeria', body = {}, token = TOKEN } = {}) {
  const capa = storefrontRouter.stack.find(l => (
    l.route?.path === RUTA && l.route?.methods?.post
  ))
  // Solo el handler final. El rate limit necesita un `req` de Express de
  // verdad, y que esté puesto ya lo fija `storefront.routes.test.js`; aquí lo
  // que se prueba es la decisión de dejar entrar o no.
  const handlers = capa.route.stack.map(l => l.handle).slice(-1)
  const req = {
    headers: {
      'x-storefront-token': token,
      'x-storefront-device': 'movil-de-quien-abre',
      'user-agent': 'iPhone', 'accept-language': 'es-EC',
    },
    body, params: { slug }, query: {},
  }
  const salida = { status: 200, body: undefined }
  const res = {
    status(code) { salida.status = code; return this },
    json(cuerpo) { salida.body = cuerpo; return this },
    setHeader() { return this },
    getHeader() { return undefined },
  }
  for (const handler of handlers) {
    let siguiente = false
    await handler(req, res, () => { siguiente = true })
    if (!siguiente) break
  }
  return salida
}

describe('confirmar el número para entrar', () => {
  it('sin número → 400, y no se toca la sesión', async () => {
    const bind = vi.spyOn(db, 'bindStorefrontSession')
    const r = await llamar({ body: {} })
    expect(r.status).toBe(400)
    expect(bind).not.toHaveBeenCalled()
  })

  it('tienda que no existe → 404', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(null)
    const r = await llamar({ body: { phone: '0999111222' } })
    expect(r.status).toBe(404)
  })

  it('EL CASO QUE IMPORTA: número del amigo → 401 y la sesión NO se ata', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1', slug: 'pizzeria' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(sesionDeJuan)
    const bind = vi.spyOn(db, 'bindStorefrontSession')

    const r = await llamar({ body: { phone: '0988777666' } })

    expect(r.status).toBe(401)
    expect(r.body.reason).toBe('necesita_telefono')
    // Lo que de verdad protege: el amigo no se queda el enlace de Juan.
    expect(bind).not.toHaveBeenCalled()
  })

  it('el número de Juan → 200 y la sesión se ata a ESTE teléfono', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1', slug: 'pizzeria' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(sesionDeJuan)
    const bind = vi.spyOn(db, 'bindStorefrontSession').mockResolvedValue(true)

    const r = await llamar({ body: { phone: '0999 111 222' } })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(bind).toHaveBeenCalledTimes(1)
    const [sessionId, deviceHash] = bind.mock.calls[0]
    expect(sessionId).toBe('s1')
    expect(deviceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('entra aunque el amigo lo hubiera abierto antes que él', async () => {
    // Esta es la propiedad nueva: llegar segundo ya no te deja fuera.
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1', slug: 'pizzeria' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue({
      ...sesionDeJuan, device_hash: 'movil-del-amigo', claimed_at: '2026-08-02',
    })
    const bind = vi.spyOn(db, 'bindStorefrontSession').mockResolvedValue(true)

    const r = await llamar({ body: { phone: '593999111222' } })

    expect(r.status).toBe(200)
    expect(bind).toHaveBeenCalled()
  })

  it('sesión revocada → 401 aunque el número sea correcto', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1', slug: 'pizzeria' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue({
      ...sesionDeJuan, revoked_at: '2026-08-02',
    })
    const bind = vi.spyOn(db, 'bindStorefrontSession')

    const r = await llamar({ body: { phone: '593999111222' } })

    expect(r.status).toBe(401)
    expect(bind).not.toHaveBeenCalled()
  })

  it('token de OTRO negocio → 401, sin revelar que existe', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-2', slug: 'panaderia' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(sesionDeJuan)
    const bind = vi.spyOn(db, 'bindStorefrontSession')

    const r = await llamar({ slug: 'panaderia', body: { phone: '593999111222' } })

    expect(r.status).toBe(401)
    expect(bind).not.toHaveBeenCalled()
    // El texto no delata que el token es real y pertenece a otra tienda.
    expect(String(r.body.error)).not.toContain('negocio')
  })

  it('token inexistente → 401', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1', slug: 'pizzeria' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(null)
    const r = await llamar({ body: { phone: '593999111222' } })
    expect(r.status).toBe(401)
  })

  it('el token se busca SIEMPRE por hash, nunca en claro', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1', slug: 'pizzeria' })
    const buscar = vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(sesionDeJuan)
    vi.spyOn(db, 'bindStorefrontSession').mockResolvedValue(true)

    await llamar({ body: { phone: '593999111222' } })

    expect(buscar).toHaveBeenCalledWith(hashToken(TOKEN))
    expect(buscar).not.toHaveBeenCalledWith(TOKEN)
  })

  it('si la base no puede atar la sesión → 500, no un falso "entraste"', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ id: 'biz-1', slug: 'pizzeria' })
    vi.spyOn(db, 'getStorefrontSessionByHash').mockResolvedValue(sesionDeJuan)
    vi.spyOn(db, 'bindStorefrontSession').mockResolvedValue(false)

    const r = await llamar({ body: { phone: '593999111222' } })

    expect(r.status).toBe(500)
    expect(r.body.ok).toBeUndefined()
  })
})
