import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import blockedRouter from '../dist/routes/blocked-contacts.routes.js'

// ═══════════════════════════════════════════════════════════════════════════
// CONTACTOS BLOQUEADOS
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ SUSTITUYE a `sessions.routes.test.js`, que fijaba catorce rutas. Doce se
// fueron el 2026-08-23 con la pantalla de Conversaciones —lista de chats,
// historial, modo manual, cerrar, marcar leído, renombrar, cuatro de etiquetas
// y responder a mano—: un local del marketplace no tiene chats que leer,
// porque sus clientes escriben al número de Umbani y `marketplace-entry.ts` no
// escribe una sola fila en `conversation_history`.
//
// Estas DOS se quedaron, y lo que se fija aquí es por qué: el bloqueo sigue
// impidiendo pedir (403 de la tienda + disparador `orders_reject_blocked`), y
// borrar su interruptor habría dejado `blocked_at` sin nadie que lo escriba —
// una defensa con las comprobaciones puestas y sin forma de encenderla.

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'blocked-contacts-test-secret'

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
  return `Bearer ${jwt.sign({
    role: 'client',
    businessId: 'business-a',
    urole: 'owner',
    ...claims,
  }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const routeLayer = blockedRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  if (!routeLayer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
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

describe('bloqueo de contactos', () => {
  it('deja exactamente dos rutas, y las dos con autenticación y permiso', () => {
    expect(blockedRouter.stack).toHaveLength(2)
    expect(blockedRouter.stack.every(layer => layer.route.stack.length === 3)).toBe(true)
  })

  // Quién puede bloquear cambió con la mudanza: `conversaciones` gobernaba una
  // pantalla que ya no existe, así que un empleado con ese permiso guardado no
  // podría entrar en ninguna parte y uno de ventas se quedaría sin poder
  // bloquear a quien le pide para molestar.
  it('lo gobierna el permiso de ventas, no el de una pantalla retirada', async () => {
    vi.spyOn(db, 'getBlockedContacts').mockResolvedValue([])

    expect((await dispatch('get', '/api/client/blocked')).status).toBe(401)
    expect((await dispatch('get', '/api/client/blocked', {
      auth: authorization({ urole: 'employee', perms: ['conversaciones'] }),
    })).status).toBe(403)
    expect((await dispatch('get', '/api/client/blocked', {
      auth: authorization({ urole: 'employee', perms: ['ventas'] }),
    })).status).toBe(200)
  })

  it('lee los bloqueados del negocio del JWT, nunca de un parámetro', async () => {
    const leer = vi.spyOn(db, 'getBlockedContacts').mockResolvedValue([
      { phone: '593990978367', until: null, permanent: true },
    ])

    const response = await dispatch('get', '/api/client/blocked', {
      auth: authorization(),
      body: { business_id: 'business-b' },
    })

    expect(response.body).toEqual([
      { phone: '593990978367', until: null, permanent: true },
    ])
    expect(leer).toHaveBeenCalledWith('business-a')
  })

  /**
   * ⚠️ La lista lleva el PLAZO desde el 2026-08-29, y no es un adorno.
   *
   * Antes devolvía teléfonos sueltos y el servidor listaba a todo el que
   * tuviera `blocked_at`. El bloqueo automático de Umbani también lo pone, así
   * que un cliente que ya había cumplido sus 30 minutos —y que la tienda
   * dejaba pedir— seguía saliendo «Bloqueado» en el panel para siempre. El
   * dueño decidía sobre un dato falso.
   */
  it('cada bloqueado viaja con su plazo, para distinguir los dos tipos', async () => {
    vi.spyOn(db, 'getBlockedContacts').mockResolvedValue([
      { phone: '593990978367', until: null, permanent: true },
      { phone: '593991112222', until: '2026-08-29T07:30:00.000Z', permanent: false },
    ])

    const response = await dispatch('get', '/api/client/blocked', {
      auth: authorization(),
    })

    expect(response.status).toBe(200)
    const [delDueno, automatico] = response.body
    // El del dueño no promete plazo: no caduca, y solo él lo levanta.
    expect(delDueno.permanent).toBe(true)
    expect(delDueno.until).toBeNull()
    // El automático sí, porque se va solo y el panel tiene que poder decirlo.
    expect(automatico.permanent).toBe(false)
    expect(automatico.until).toBe('2026-08-29T07:30:00.000Z')
  })

  it('bloquea y desbloquea sobre el negocio autenticado', async () => {
    const marcar = vi.spyOn(db, 'setContactBlocked').mockResolvedValue({ blocked: true })

    const bloquear = await dispatch('put', '/api/client/blocked/:phone', {
      auth: authorization(), params: { phone: '%2B593990978367' }, body: { blocked: true },
    })
    expect(bloquear.body).toEqual({ blocked: true })
    expect(marcar).toHaveBeenCalledWith('business-a', '+593990978367', true)

    await dispatch('put', '/api/client/blocked/:phone', {
      auth: authorization(), params: { phone: '%2B593990978367' }, body: {},
    })
    // Sin `blocked: true` explícito se DESbloquea: un cuerpo raro no puede
    // acabar bloqueando a alguien por accidente.
    expect(marcar).toHaveBeenLastCalledWith('business-a', '+593990978367', false)
  })

  // ⚠️ `resolveCustomer` guarda a los clientes por DÍGITOS, así que un `tg_123`
  // se convertiría en el cliente `123` — el WhatsApp de otra persona, que
  // quedaría bloqueada sin haber hecho nada.
  it('se niega a bloquear un contacto de Telegram', async () => {
    const marcar = vi.spyOn(db, 'setContactBlocked')

    const response = await dispatch('put', '/api/client/blocked/:phone', {
      auth: authorization(), params: { phone: 'tg_123' }, body: { blocked: true },
    })

    expect(response.status).toBe(400)
    expect(marcar).not.toHaveBeenCalled()
  })

  it('no responde éxito cuando la base rechaza el cambio', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'setContactBlocked').mockRejectedValue(new Error('rechazado'))

    const response = await dispatch('put', '/api/client/blocked/:phone', {
      auth: authorization(), params: { phone: '593990978367' }, body: { blocked: true },
    })

    expect(response.status).toBe(500)
    expect(response.body.error).not.toContain('rechazado')
  })
})
