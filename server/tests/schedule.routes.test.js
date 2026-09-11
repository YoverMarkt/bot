import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import scheduleRouter from '../dist/routes/schedule.routes.js'

// El horario de atención es lo ÚNICO que sobrevivió al módulo de citas, y no
// por nostalgia: decide si la mini app acepta pedidos y si el bot atiende o
// contesta que está cerrado. Estas pruebas venían de `bookings.routes.test.js`
// y se conservan aquí porque lo que protegen —auth, permiso y que el negocio
// salga del JWT— es exactamente lo que la retirada de la agenda podía romper.

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'schedule-route-test-secret'

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
  const signed = jwt.sign({
    role: 'client',
    businessId: 'business-a',
    urole: 'owner',
    ...claims,
  }, JWT_SECRET)
  return `Bearer ${signed}`
}

async function dispatch(method, path, { auth, body = {}, query = {}, params = {} } = {}) {
  const routeLayer = scheduleRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, query, params }
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

describe('rutas del horario de atención', () => {
  it('protege los dos endpoints con autenticación y permiso', async () => {
    const getSchedule = vi.spyOn(db, 'getSchedule')
    const upsertSchedule = vi.spyOn(db, 'upsertSchedule')

    const sinToken = await dispatch('get', '/api/client/schedule')
    expect(sinToken.status).toBe(401)

    // Un empleado sin el permiso de horarios no lo lee ni lo escribe.
    const sinPermiso = authorization({ urole: 'employee', perms: ['ventas'] })
    expect((await dispatch('get', '/api/client/schedule', { auth: sinPermiso })).status).toBe(403)
    expect((await dispatch('put', '/api/client/schedule', {
      auth: sinPermiso,
      body: { days: [{ day_of_week: 1 }] },
    })).status).toBe(403)

    // Ninguna de las dos llegó a la base.
    expect(getSchedule).not.toHaveBeenCalled()
    expect(upsertSchedule).not.toHaveBeenCalled()
  })

  it('lee y actualiza el horario usando solo el negocio del JWT', async () => {
    const getSchedule = vi.spyOn(db, 'getSchedule').mockResolvedValue([{ day_of_week: 1 }])
    const upsertSchedule = vi.spyOn(db, 'upsertSchedule').mockResolvedValue({ error: null })

    // El `businessId` de la consulta es manipulable por quien llama: el que
    // manda es siempre el del token.
    const lectura = await dispatch('get', '/api/client/schedule', {
      auth: authorization(),
      query: { businessId: 'business-b' },
    })
    expect(lectura.status).toBe(200)
    expect(getSchedule).toHaveBeenCalledWith('business-a')

    const days = [{ day_of_week: 1, open_time: '09:00', close_time: '18:00', is_active: true }]
    const escritura = await dispatch('put', '/api/client/schedule', {
      auth: authorization(),
      body: { days, businessId: 'business-b' },
    })
    expect(escritura.status).toBe(200)
    expect(upsertSchedule).toHaveBeenCalledWith('business-a', days)
  })

  it('rechaza un cuerpo sin horario en vez de reventar con 500', async () => {
    const upsertSchedule = vi.spyOn(db, 'upsertSchedule')

    for (const body of [{}, { days: [] }, { days: 'lunes' }, { days: [null] }]) {
      const respuesta = await dispatch('put', '/api/client/schedule', {
        auth: authorization(),
        body,
      })
      expect(respuesta.status, JSON.stringify(body)).toBe(400)
    }
    expect(upsertSchedule).not.toHaveBeenCalled()
  })

  // ── Abierto 24 horas ────────────────────────────────────────────────────
  // Antes de esto, «24 horas» se escribía «00:00 – 23:59» y su lectura natural
  // —«00:00 – 00:00»— se guardaba sin decir nada, dejando el local cerrado el
  // día entero. La ruta es la última puerta antes de la base: aquí se corta.

  it('rechaza un día activo que abre y cierra a la misma hora', async () => {
    const upsertSchedule = vi.spyOn(db, 'upsertSchedule')

    for (const horas of [
      { open_time: '00:00', close_time: '00:00' },   // «de medianoche a medianoche»
      { open_time: '09:00', close_time: '09:00' },
      { open_time: '09:00:00', close_time: '09:00' }, // la base devuelve HH:MM:SS
    ]) {
      const respuesta = await dispatch('put', '/api/client/schedule', {
        auth: authorization(),
        body: { days: [{ day_of_week: 1, ...horas, is_active: true }] },
      })
      expect(respuesta.status, JSON.stringify(horas)).toBe(400)
      // ⚠️ El mensaje tiene que decir DÓNDE está la salida. Un «horario no
      // válido» a secas deja al dueño probando horas hasta que se rinde.
      expect(respuesta.body.error).toContain('24 horas')
    }
    expect(upsertSchedule).not.toHaveBeenCalled()
  })

  it('deja guardar esas mismas horas cuando el día es de 24 horas', async () => {
    const upsertSchedule = vi.spyOn(db, 'upsertSchedule').mockResolvedValue({ error: null })

    // Es el caso REAL: la marca puesta y las horas como estaban. Si la guarda
    // mirara solo las horas, el dueño no podría guardar lo único correcto.
    const days = [
      { day_of_week: 1, open_time: '00:00', close_time: '00:00', is_24h: true, is_active: true },
      { day_of_week: 2, open_time: '09:00', close_time: '17:00', is_24h: true, is_active: true },
    ]
    const respuesta = await dispatch('put', '/api/client/schedule', {
      auth: authorization(),
      body: { days },
    })

    expect(respuesta.status).toBe(200)
    // La marca llega a la base tal cual: sin esto la casilla del panel no
    // pintaría nada al volver a entrar.
    expect(upsertSchedule).toHaveBeenCalledWith('business-a', days)
  })

  it('no se mete con un día cerrado ni acepta una marca que no sea booleana', async () => {
    const upsertSchedule = vi.spyOn(db, 'upsertSchedule').mockResolvedValue({ error: null })

    // Un día apagado está cerrado: sus horas dan igual y bloquear el guardado
    // por ellas sería impedir guardar el resto de la semana.
    const cerrado = await dispatch('put', '/api/client/schedule', {
      auth: authorization(),
      body: { days: [{ day_of_week: 1, open_time: '00:00', close_time: '00:00', is_active: false }] },
    })
    expect(cerrado.status).toBe(200)

    upsertSchedule.mockClear()
    const basura = await dispatch('put', '/api/client/schedule', {
      auth: authorization(),
      body: { days: [{ day_of_week: 1, open_time: '09:00', close_time: '17:00', is_24h: 'sí', is_active: true }] },
    })
    expect(basura.status).toBe(400)
    expect(upsertSchedule).not.toHaveBeenCalled()
  })

  it('no confirma un horario que la base rechazó ni filtra su error', async () => {
    vi.spyOn(db, 'upsertSchedule').mockResolvedValue({
      error: { message: 'duplicate key value violates unique constraint "…"' },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const respuesta = await dispatch('put', '/api/client/schedule', {
      auth: authorization(),
      body: { days: [{ day_of_week: 1 }] },
    })

    expect(respuesta.status).toBe(500)
    expect(respuesta.body).toEqual({ error: 'No se pudieron actualizar los horarios' })
    // El detalle de Supabase se queda en el registro, no viaja al cliente.
    expect(JSON.stringify(respuesta.body)).not.toContain('unique constraint')
  })
})
