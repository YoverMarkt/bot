import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import healthRouter from '../dist/routes/health.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const client = require('../dist/db/client')
const repo = require('../dist/db/repositories/platform-errors')

// ═══════════════════════════════════════════════════════════════════════════
// EL DETALLE DE SALUD QUE LEE EL VIGÍA EXTERNO
// ═══════════════════════════════════════════════════════════════════════════
//
// Es un endpoint PÚBLICO protegido solo por un token: cualquiera en internet
// puede llamarlo, así que lo que se comprueba aquí no es que funcione, sino
// que no se le escape nada cuando NO debería contestar.
//
// Y una cosa más, que es la que de verdad se ha roto antes en este proyecto:
// que el resumen cuente los errores SIN negocio. Su antecesor
// (`getErrorCountsByBusiness`, retirado el 2026-08-23) los descartaba y
// enseñaba ceros mientras el canal del marketplace se caía a pedazos.

const TOKEN = 'token-de-vigia-suficientemente-largo-2026'
let tokenOriginal

beforeEach(() => {
  tokenOriginal = process.env.HEALTH_DETAIL_TOKEN
  process.env.HEALTH_DETAIL_TOKEN = TOKEN
})

afterEach(() => {
  vi.restoreAllMocks()
  if (tokenOriginal === undefined) delete process.env.HEALTH_DETAIL_TOKEN
  else process.env.HEALTH_DETAIL_TOKEN = tokenOriginal
})

async function pedir({ autorizacion, query } = {}) {
  const capa = healthRouter.stack.find(item => (
    item.route?.path === '/api/health/detalle' && item.route?.methods?.get
  ))
  const handlers = capa.route.stack.map(item => item.handle)
  const req = { headers: autorizacion ? { authorization: autorizacion } : {}, query: query || {} }
  const resultado = { status: 200, body: undefined }
  const res = {
    status(code) { resultado.status = code; return this },
    json(value) { resultado.body = value; return this },
  }

  async function correr(indice) {
    if (indice >= handlers.length) return
    await new Promise((resolve, reject) => {
      let siguiente = false
      const next = error => { siguiente = true; error ? reject(error) : resolve() }
      Promise.resolve(handlers[indice](req, res, next))
        .then(() => { if (!siguiente) resolve() })
        .catch(reject)
    })
    if (resultado.body === undefined) await correr(indice + 1)
  }

  await correr(0)
  return resultado
}

describe('la puerta del detalle de salud', () => {
  it('sin token configurado la ruta NO EXISTE, aunque presenten uno', async () => {
    delete process.env.HEALTH_DETAIL_TOKEN
    const consulta = vi.spyOn(db, 'getPlatformErrorSummary')

    const respuesta = await pedir({ autorizacion: `Bearer ${TOKEN}` })

    expect(respuesta.status).toBe(404)
    // Un despliegue que se olvide la variable deja una pared, no una puerta.
    expect(consulta).not.toHaveBeenCalled()
  })

  it('con la variable vacía tampoco abre (una cadena en blanco no es un token)', async () => {
    process.env.HEALTH_DETAIL_TOKEN = '   '
    const respuesta = await pedir({ autorizacion: 'Bearer    ' })
    expect(respuesta.status).toBe(404)
  })

  it('sin cabecera de autorización responde 404, no 401', async () => {
    const respuesta = await pedir()
    // 401 confirmaría que aquí hay algo que vale la pena forzar.
    expect(respuesta.status).toBe(404)
    expect(respuesta.body).toEqual({ error: 'no encontrado' })
  })

  it('un token equivocado responde lo MISMO que uno ausente', async () => {
    const sinNada = await pedir()
    const equivocado = await pedir({ autorizacion: 'Bearer token-que-no-es' })
    expect(equivocado.status).toBe(sinNada.status)
    expect(equivocado.body).toEqual(sinNada.body)
  })

  it('un token de otra longitud no revienta la comparación', async () => {
    // `timingSafeEqual` lanza si los búferes miden distinto: por eso se comparan
    // los sha256. Si alguien quita el hash, esto explota en vez de dar 404.
    const respuesta = await pedir({ autorizacion: 'Bearer x' })
    expect(respuesta.status).toBe(404)
  })

  it('ignora un esquema que no sea Bearer', async () => {
    const respuesta = await pedir({ autorizacion: `Basic ${TOKEN}` })
    expect(respuesta.status).toBe(404)
  })

  it('con el token correcto contesta el resumen', async () => {
    vi.spyOn(db, 'getPlatformErrorSummary').mockResolvedValue({ sinceHours: 24, rows: [] })

    const respuesta = await pedir({ autorizacion: `Bearer ${TOKEN}` })

    expect(respuesta.status).toBe(200)
    expect(respuesta.body).toEqual({ ok: true, ventana_horas: 24, problemas: [] })
  })
})

describe('lo que el vigía recibe', () => {
  const FILAS = [
    { category: 'canal', code: 'saldo_bajo', occurrences: 209, last_seen_at: '2026-09-18T04:00:00.000Z' },
    { category: 'canal', code: 'saldo_bajo', occurrences: 3, last_seen_at: '2026-09-18T05:00:00.000Z' },
    { category: 'ia', code: 'timeout', occurrences: 2, last_seen_at: '2026-09-18T03:00:00.000Z' },
  ]

  it('agrupa por categoría y código, y ordena por lo más reciente', async () => {
    vi.spyOn(db, 'getPlatformErrorSummary').mockResolvedValue({ sinceHours: 24, rows: FILAS })

    const { body } = await pedir({ autorizacion: `Bearer ${TOKEN}` })

    expect(body.ok).toBe(false)
    expect(body.problemas).toEqual([
      { categoria: 'canal', codigo: 'saldo_bajo', veces: 212, ultima_vez: '2026-09-18T05:00:00.000Z' },
      { categoria: 'ia', codigo: 'timeout', veces: 2, ultima_vez: '2026-09-18T03:00:00.000Z' },
    ])
  })

  it('no deja salir mensajes, contexto ni el negocio', async () => {
    vi.spyOn(db, 'getPlatformErrorSummary').mockResolvedValue({
      sinceHours: 24,
      rows: [{
        category: 'canal',
        code: 'saldo_bajo',
        occurrences: 1,
        last_seen_at: '2026-09-18T05:00:00.000Z',
        // Aunque la base devolviera de más, esto no puede cruzar el endpoint.
        message: 'el cliente [telefono] no pudo pagar',
        business_id: '98a67b29-7a2c-47eb-94cb-f465c391e16f',
        context: { secreto: 'no' },
      }],
    })

    const { body } = await pedir({ autorizacion: `Bearer ${TOKEN}` })

    expect(Object.keys(body).sort()).toEqual(['ok', 'problemas', 'ventana_horas'])
    expect(Object.keys(body.problemas[0]).sort())
      .toEqual(['categoria', 'codigo', 'ultima_vez', 'veces'])
    expect(JSON.stringify(body)).not.toContain('telefono')
    expect(JSON.stringify(body)).not.toContain('98a67b29')
  })

  it('acepta una ventana distinta y descarta la basura', async () => {
    const consulta = vi.spyOn(db, 'getPlatformErrorSummary')
      .mockResolvedValue({ sinceHours: 1, rows: [] })

    await pedir({ autorizacion: `Bearer ${TOKEN}`, query: { horas: '1' } })
    expect(consulta).toHaveBeenCalledWith({ sinceHours: 1 })

    await pedir({ autorizacion: `Bearer ${TOKEN}`, query: { horas: 'ayer' } })
    expect(consulta).toHaveBeenLastCalledWith({ sinceHours: 24 })
  })
})

// ── El repositorio, que es donde se rompió la vez anterior ──────────────────

function encadenable(resultado = { data: [], error: null }) {
  const cadena = {}
  const registro = { select: null, eqs: [], gte: null, limite: null }
  for (const metodo of ['select', 'eq', 'gte', 'order', 'limit']) {
    cadena[metodo] = vi.fn((...args) => {
      if (metodo === 'select') registro.select = args[0]
      if (metodo === 'eq') registro.eqs.push(args)
      if (metodo === 'gte') registro.gte = args
      if (metodo === 'limit') registro.limite = args[0]
      return cadena
    })
  }
  cadena.then = resolve => Promise.resolve(resultado).then(resolve)
  cadena.__registro = registro
  return cadena
}

describe('getPlatformErrorSummary', () => {
  it('NO filtra por negocio — es la lección de su antecesor', async () => {
    const cadena = encadenable()
    vi.spyOn(client, 'from').mockReturnValue(cadena)

    await repo.getPlatformErrorSummary()

    // Cinco de cada seis errores tienen `business_id` NULL: son los del canal
    // del marketplace, que no pertenece a ningún local. Filtrar por negocio
    // aquí volvería a enseñar ceros durante una caída.
    expect(cadena.__registro.eqs).toEqual([])
  })

  it('pide columnas explícitas y ninguna con datos dentro', async () => {
    const cadena = encadenable()
    vi.spyOn(client, 'from').mockReturnValue(cadena)

    await repo.getPlatformErrorSummary()

    const columnas = cadena.__registro.select.split(',').map(c => c.trim()).sort()
    expect(columnas).toEqual(['category', 'code', 'last_seen_at', 'occurrences'])
    expect(cadena.__registro.select).not.toContain('message')
    expect(cadena.__registro.select).not.toContain('context')
    expect(cadena.__registro.select).not.toContain('*')
  })

  it('acota la ventana de tiempo y el número de filas', async () => {
    const cadena = encadenable()
    vi.spyOn(client, 'from').mockReturnValue(cadena)
    const antes = Date.now()

    await repo.getPlatformErrorSummary({ sinceHours: 2 })

    const [columna, desde] = cadena.__registro.gte
    expect(columna).toBe('last_seen_at')
    const distanciaHoras = (antes - new Date(desde).getTime()) / 3_600_000
    expect(distanciaHoras).toBeGreaterThan(1.99)
    expect(distanciaHoras).toBeLessThan(2.01)
    expect(cadena.__registro.limite).toBe(500)
  })

  it('no deja pedir una ventana absurda', async () => {
    const cadena = encadenable()
    vi.spyOn(client, 'from').mockReturnValue(cadena)

    const muchas = await repo.getPlatformErrorSummary({ sinceHours: 99999 })
    expect(muchas.sinceHours).toBe(168)

    const ninguna = await repo.getPlatformErrorSummary({ sinceHours: 0 })
    expect(ninguna.sinceHours).toBe(24)
  })

  it('propaga el fallo de la base en vez de fingir que no hay problemas', async () => {
    const cadena = encadenable({ data: null, error: { message: 'se cayó la base' } })
    vi.spyOn(client, 'from').mockReturnValue(cadena)

    // Si esto devolviera [] en silencio, el vigía cantaría «todo en orden»
    // justo cuando la base no contesta.
    await expect(repo.getPlatformErrorSummary()).rejects.toThrow('se cayó la base')
  })
})

describe('guardián: el freno está ENCHUFADO', () => {
  const arranque = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('el limitador se monta ANTES que el router', () => {
    // Express recorre el stack en orden de registro. Con el router montado
    // primero, contesta él y el limitador queda escrito, revisado y MUERTO —
    // y las pruebas de aquí arriba, que despachan el router directamente,
    // seguirían todas en verde sin enterarse.
    //
    // Pasó al escribir esto: el freno estaba 16 líneas por debajo del router.
    const freno = arranque.indexOf("app.use('/api/health/detalle', healthDetailLimiter)")
    const router = arranque.indexOf('app.use(healthRouter)')
    expect(freno).toBeGreaterThan(-1)
    expect(router).toBeGreaterThan(-1)
    expect(freno).toBeLessThan(router)
  })

  it('el router está montado de verdad en el arranque', () => {
    // Un endpoint que nadie monta es un endpoint que no existe, por muy
    // probado que esté su archivo.
    expect(arranque).toContain("import healthRouter = require('./routes/health.routes')")
    expect(arranque).toContain('app.use(healthRouter)')
  })
})
