import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import jwt from 'jsonwebtoken'
import simulatorRouter from '../dist/routes/admin-simulator.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'admin-simulator-test-secret'
let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, businessId: 'business-a' }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = simulatorRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
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

describe('simulador del marketplace', () => {
  // ═════════════════════════════════════════════════════════════════════════
  // Estas pruebas SUSTITUYEN a las del simulador por negocio, no las borran.
  //
  // Hasta el 2026-08-23 el simulador despachaba por `businesses.chat_mode` y
  // fijaba tres ramas: menú, miniapp y «modo no reconocido». Con todos los
  // locales en el marketplace ninguna de las tres se ejecuta en producción: el
  // cliente escribe al número compartido y el local lo elige él navegando.
  // Se probaba, con el CI en verde, un camino por el que no entra nadie.
  //
  // Lo que se fija ahora es que el simulador corra la MISMA función que el
  // webhook, con los datos reales, y que NO escriba en el negocio del dueño.
  // ═════════════════════════════════════════════════════════════════════════

  const TELEFONO_SIMULADO = '000000000000'
  const CLIENTE = { id: 'customer-sim', name: null }

  /** El marketplace tal y como responde con una categoría y un local. */
  function mockMarketplace() {
    vi.spyOn(db, 'resolveMarketplaceCustomer').mockResolvedValue(CLIENTE)
    vi.spyOn(db, 'getConversation').mockResolvedValue(null)
    vi.spyOn(db, 'advanceConversation').mockResolvedValue({ conflicto: false })
    vi.spyOn(db, 'getMarketplaceCategories').mockResolvedValue([
      { code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', sort: 10, locales: 1 },
    ])
  }

  it('protege ambos endpoints exclusivamente con autenticación admin', async () => {
    expect(simulatorRouter.stack).toHaveLength(2)
    expect(simulatorRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('post', '/api/admin/simulate')).status).toBe(401)
    expect((await dispatch('post', '/api/admin/simulate', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  // ⚠️ Ya NO se pide `business_id`, y es el cambio que más importa: pedirlo
  // sería volver a simular «un bot por local». El local lo elige el cliente.
  it('no pide negocio: solo el mensaje', async () => {
    const getBusiness = vi.spyOn(db, 'getBusinessById')
    mockMarketplace()

    const vacio = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(), body: { message: '   ' },
    })
    expect(vacio.status).toBe(400)

    const conMensaje = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(), body: { message: 'hola' },
    })
    expect(conMensaje.status).toBe(200)
    expect(getBusiness).not.toHaveBeenCalled()
  })

  // Lo que hace que esto sea un simulador y no una maqueta: corre la misma
  // función que el webhook, contra el mismo estado y las mismas categorías.
  it('atiende el mensaje por el camino REAL del marketplace', async () => {
    mockMarketplace()

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(), body: { message: 'hola' },
    })

    expect(response.status).toBe(200)
    expect(db.resolveMarketplaceCustomer).toHaveBeenCalledWith(TELEFONO_SIMULADO)
    expect(response.body.replies.length).toBeGreaterThan(0)
    // Las categorías salen de la base, no de una lista fija del simulador.
    expect(response.body.replies[0].options).toContain('🍕 Pizzerías')
  })

  it('guarda el avance donde lo guarda producción, no en memoria', async () => {
    mockMarketplace()
    await dispatch('post', '/api/admin/simulate', {
      auth: authorization(), body: { message: 'hola' },
    })
    expect(db.advanceConversation).toHaveBeenCalled()
    expect(db.advanceConversation.mock.calls[0][0]).toBe(CLIENTE.id)
  })

  // ⚠️ LA LÍNEA QUE NO SE PUEDE CRUZAR. Un pedido de prueba entra en la cocina
  // del local, le suena la alarma al dueño y acaba en `sales` al entregarlo:
  // o sea, en su reporte de ventas y en la comisión de la plataforma.
  it('no crea pedidos ni direcciones de verdad', async () => {
    const fuente = fs.readFileSync(
      new URL('../src/routes/admin-simulator.routes.ts', import.meta.url), 'utf8',
    )
    expect(fuente).not.toMatch(/createStorefrontOrder|processOrderPayload/)
    expect(fuente).toMatch(/createCustomerAddress: async \(\) =>/)
  })

  it('el simulador no puede llamar a un modelo', () => {
    // Si alguien reintroduce la IA por aquí, esto lo caza.
    const fuente = fs.readFileSync(
      new URL('../src/routes/admin-simulator.routes.ts', import.meta.url), 'utf8',
    )
    expect(fuente).not.toMatch(/callAI|buildPrompt/)
  })

  // ⚠️ BORRA la conversación, no la suelta con la RPC de `MENÚ`. La diferencia
  // no es de estilo: `MENÚ` conserva la fila, y con fila el siguiente mensaje
  // deja de ser un primer contacto y recibe «🙏 No te entendí» en vez de la
  // bienvenida. Lo primero que hay que poder comprobar al dar de alta un local
  // es exactamente eso — qué ve quien escribe a Umbani por primera vez.
  it('reiniciar deja al cliente como si nunca hubiera escrito', async () => {
    vi.spyOn(db, 'resolveMarketplaceCustomer').mockResolvedValue(CLIENTE)
    const borrar = vi.spyOn(db, 'deleteConversation').mockResolvedValue(undefined)
    const avanzar = vi.spyOn(db, 'advanceConversation')

    const response = await dispatch('delete', '/api/admin/simulate/history', {
      auth: authorization(),
    })

    expect(response.status).toBe(200)
    expect(borrar).toHaveBeenCalledWith(CLIENTE.id)
    expect(avanzar).not.toHaveBeenCalled()
  })

  // La bienvenida de verdad, la que ve un cliente nuevo: sin conversación
  // previa NO puede salir un «no te entendí».
  it('el primer mensaje recibe la bienvenida, no un reproche', async () => {
    mockMarketplace()

    const response = await dispatch('post', '/api/admin/simulate', {
      auth: authorization(), body: { message: 'hola' },
    })

    expect(response.body.replies[0].reply).not.toMatch(/no te entendí/i)
  })

  it('un fallo al reiniciar se reporta, no se traga', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'resolveMarketplaceCustomer').mockRejectedValue(new Error('base caída'))

    const response = await dispatch('delete', '/api/admin/simulate/history', {
      auth: authorization(),
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo reiniciar la conversación' },
    })
  })
})
