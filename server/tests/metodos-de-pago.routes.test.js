import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import profileRouter from '../dist/routes/business-profile.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')

// ═══════════════════════════════════════════════════════════════════════════
// CÓMO LE PAGAN AL NEGOCIO
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta el 2026-08-16 `businesses.payment_methods` era texto libre que solo
// alimentaba el prompt del bot, y la tienda tenía los tres métodos escritos a
// mano: el dueño creía que elegía y no elegía nada. Se notó en los datos —
// 3 de 43 pedidos se pagaron en efectivo sin que nadie lo activara.
//
// Lo que se protege aquí es que el interruptor sea de verdad Y que no se pueda
// dejar una tienda sin ninguna forma de cobrar.

const JWT_SECRET = 'metodos-pago-test-secret'
const BIZ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTRO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

const duenoAuth = (businessId = BIZ) =>
  `Bearer ${jwt.sign({ role: 'client', businessId, urole: 'owner' }, JWT_SECRET)}`

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = profileRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`No existe ${method.toUpperCase()} ${path}`)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params, query: {} }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
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

const metodos = (activos = ['transferencia', 'efectivo']) =>
  ['transferencia', 'efectivo', 'pago_al_retirar'].map(code => ({
    method_code: code,
    enabled: activos.includes(code),
    payment_methods: { label: code, help_text: null, is_prepaid: false, requires_proof: false },
  }))

describe('métodos de pago del negocio', () => {
  it('sin token no se ven', async () => {
    expect((await dispatch('get', '/api/client/payment-methods')).status).toBe(401)
  })

  it('el negocio sale del JWT, nunca de la petición', async () => {
    const leer = vi.spyOn(db, 'getBusinessPaymentMethods').mockResolvedValue(metodos())
    await dispatch('get', '/api/client/payment-methods', { auth: duenoAuth(OTRO) })
    // Si viniera de un parámetro, bastaría un id ajeno para ver la
    // configuración de otro local.
    expect(leer).toHaveBeenCalledWith(OTRO)
  })

  it('enciende un método', async () => {
    vi.spyOn(db, 'getBusinessPaymentMethods').mockResolvedValue(metodos())
    const escribir = vi.spyOn(db, 'setBusinessPaymentMethod').mockResolvedValue({ error: null })
    const r = await dispatch('put', '/api/client/payment-methods/:code', {
      auth: duenoAuth(), params: { code: 'pago_al_retirar' }, body: { enabled: true },
    })
    expect(r.status).toBe(200)
    expect(escribir).toHaveBeenCalledWith(BIZ, 'pago_al_retirar', true)
  })

  // Una tienda sin ningún método no puede cobrar, y el cliente lo descubriría
  // al confirmar el pedido — después de haber elegido todo.
  it('no deja apagar el último que queda', async () => {
    vi.spyOn(db, 'getBusinessPaymentMethods').mockResolvedValue(metodos(['transferencia']))
    const escribir = vi.spyOn(db, 'setBusinessPaymentMethod').mockResolvedValue({ error: null })
    const r = await dispatch('put', '/api/client/payment-methods/:code', {
      auth: duenoAuth(), params: { code: 'transferencia' }, body: { enabled: false },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('al menos un método')
    expect(escribir).not.toHaveBeenCalled()
  })

  it('sí deja apagar uno si queda otro', async () => {
    vi.spyOn(db, 'getBusinessPaymentMethods').mockResolvedValue(metodos(['transferencia', 'efectivo']))
    const escribir = vi.spyOn(db, 'setBusinessPaymentMethod').mockResolvedValue({ error: null })
    const r = await dispatch('put', '/api/client/payment-methods/:code', {
      auth: duenoAuth(), params: { code: 'efectivo' }, body: { enabled: false },
    })
    expect(r.status).toBe(200)
    expect(escribir).toHaveBeenCalledWith(BIZ, 'efectivo', false)
  })

  it('rechaza un código inventado', async () => {
    const r = await dispatch('put', '/api/client/payment-methods/:code', {
      auth: duenoAuth(), params: { code: 'BitCoin!!' }, body: { enabled: true },
    })
    expect(r.status).toBe(400)
  })

  it('exige decir si se enciende o se apaga', async () => {
    const r = await dispatch('put', '/api/client/payment-methods/:code', {
      auth: duenoAuth(), params: { code: 'efectivo' }, body: {},
    })
    expect(r.status).toBe(400)
  })

  // La base rechaza activar un método que la plataforma no procesa todavía
  // (tarjeta, pasarela). La ruta lo traduce a algo que se entiende.
  it('explica que un método no disponible no se puede activar', async () => {
    vi.spyOn(db, 'getBusinessPaymentMethods').mockResolvedValue(metodos())
    vi.spyOn(db, 'setBusinessPaymentMethod').mockResolvedValue({
      error: { message: 'Ese método de pago todavía no está disponible en la plataforma.' },
    })
    const r = await dispatch('put', '/api/client/payment-methods/:code', {
      auth: duenoAuth(), params: { code: 'tarjeta' }, body: { enabled: true },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('no está disponible')
  })
})
