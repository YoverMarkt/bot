import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import clientsRouter from '../dist/routes/admin-clients.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'sin-canal-propio-test-secret'

// ═══════════════════════════════════════════════════════════════════════════
// UN NEGOCIO PUEDE EXISTIR SIN CANAL PROPIO
//
// Fase 1 del marketplace. Todo el mundo escribirá al mismo número, así que un
// local ya no necesita el suyo. Lo que se prueba aquí es lo que puede romperse
// en silencio:
//
//   · que el número vaya como NULL y no como cadena vacía —la columna es
//     UNIQUE, así que dos cadenas vacías chocarían y el error hablaría de un
//     índice, no de lo que pasó;
//   · que los negocios con canal propio SIGAN exigiéndolo, porque para ellos
//     el número es lo único que dice de quién es un mensaje entrante;
//   · y que un negocio de marketplace no se quede con un teléfono suelto, que
//     daría dos respuestas a «¿de quién es este número?».
// ═══════════════════════════════════════════════════════════════════════════

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const leer = nombre => readFileSync(`${serverDir}/${nombre}`, 'utf8')
const MIGRACION = leer('migration-2026-08-20-negocio-sin-canal-propio.sql')
const SCHEMA = leer('schema.sql')

/** Un comentario que nombra algo no es ejecutarlo. Sin esto, el propio texto
 *  explicativo de la migración dispara falsos positivos — pasó al escribirla. */
const sinComentarios = sql => sql.replace(/--[^\n]*/g, '')

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET
  vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(null)
})
afterEach(() => { vi.restoreAllMocks() })

const authorization = () => `Bearer ${jwt.sign({ role: 'admin' }, JWT_SECRET)}`

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = clientsRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
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
    await handlers[index](req, res, error => { nextCalled = true; nextError = error })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }
  await run(0)
  return result
}

const altaBase = {
  client_email: 'duenio@ceviche.test',
  client_password: 'contrasena-larga-12',
  plan: 'micro',
}

describe('el alta de un negocio del marketplace', () => {
  it('no pide número, ni cuenta de YCloud, ni webhook', async () => {
    const onboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'biz-ceviche', name: 'Cevichería El Puerto' }, error: null,
    })

    const respuesta = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: { ...altaBase, name: 'Cevichería El Puerto', whatsapp_provider: 'marketplace' },
    })

    expect(respuesta.status).toBe(201)
    expect(onboarding).toHaveBeenCalled()
    // Y llega sin canal propio. El número puede ir como '' porque la RPC lo
    // convierte con `nullif` —hay una prueba propia de eso—, pero NUNCA puede
    // llevar un teléfono de verdad.
    const [payload] = onboarding.mock.calls[0]
    expect(payload.whatsapp_provider).toBe('marketplace')
    expect(String(payload.whatsapp_number ?? '')).toBe('')
  })

  it('rechaza que además tenga un número propio, y dice por qué', async () => {
    const onboarding = vi.spyOn(db, 'createBusinessOnboarding')

    for (const campo of ['whatsapp_number', 'ycloud_number', 'meta_phone_id']) {
      const respuesta = await dispatch('post', '/api/admin/clients', {
        auth: authorization(),
        body: {
          ...altaBase,
          name: 'Cevichería El Puerto',
          whatsapp_provider: 'marketplace',
          [campo]: campo === 'meta_phone_id' ? '123456789' : '+593999000001',
        },
      })
      expect(respuesta.status, `${campo} debería rechazarse`).toBe(400)
      expect(respuesta.body.error).toMatch(/número de la plataforma/)
    }
    // Se rechaza ANTES de tocar la base: la restricción de la base es la red,
    // no el mensaje que lee el superadmin.
    expect(onboarding).not.toHaveBeenCalled()
  })

  it('los negocios con canal propio siguen exigiendo credenciales', async () => {
    const onboarding = vi.spyOn(db, 'createBusinessOnboarding')
    const previo = process.env.YCLOUD_API_KEY
    delete process.env.YCLOUD_API_KEY

    const respuesta = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        ...altaBase, name: 'Con canal', whatsapp_provider: 'ycloud',
        whatsapp_number: '+593999000001',
      },
    })

    expect(respuesta.status).toBe(400)
    expect(onboarding).not.toHaveBeenCalled()
    if (previo !== undefined) process.env.YCLOUD_API_KEY = previo
  })
})

describe('convertir un negocio existente al marketplace', () => {
  it('guarda NULL y no cadena vacía en las columnas de canal', async () => {
    // ⚠️ `whatsapp_number` es UNIQUE. Con '' el primer convertido se guardaría
    // y el segundo chocaría contra el índice, con un mensaje que habla de un
    // número que ese negocio no tiene.
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'biz-1', plan: 'micro' })
    const actualizar = vi.spyOn(db, 'updateBusiness').mockResolvedValue({
      data: { id: 'biz-1' }, error: null,
    })

    const respuesta = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(),
      params: { id: 'biz-1' },
      body: {
        whatsapp_provider: 'marketplace',
        whatsapp_number: '',
        ycloud_number: '   ',
        meta_phone_id: '',
      },
    })

    expect(respuesta.status).toBe(200)
    const [, cambios] = actualizar.mock.calls[0]
    expect(cambios.whatsapp_number).toBeNull()
    expect(cambios.ycloud_number).toBeNull()
    expect(cambios.meta_phone_id).toBeNull()
    expect(cambios.whatsapp_provider).toBe('marketplace')
  })
})

describe('la migración de la fase 1', () => {
  it('el CHECK del proveedor admite los cuatro, en la base y en el esquema', () => {
    for (const [nombre, sql] of [['migración', MIGRACION], ['schema.sql', SCHEMA]]) {
      const inicio = sql.lastIndexOf('businesses_whatsapp_provider_check check')
      expect(inicio, `${nombre}: falta el CHECK del proveedor`).toBeGreaterThan(0)
      const cuerpo = sql.slice(inicio, inicio + 300)
      for (const proveedor of ['ycloud', 'meta', 'telegram', 'marketplace']) {
        expect(cuerpo, `${nombre} debería admitir ${proveedor}`).toContain(`'${proveedor}'`)
      }
    }
  })

  it('prohíbe en la BASE que un negocio de marketplace tenga identificadores', () => {
    // La ruta da el mensaje legible; esta restricción es la que de verdad
    // cierra la puerta, y cubre cualquier camino futuro que no pase por ahí.
    for (const [nombre, sql] of [['migración', MIGRACION], ['schema.sql', SCHEMA]]) {
      expect(sql, `${nombre}`).toContain('businesses_marketplace_sin_canal_check')
    }
    const guarda = MIGRACION.slice(MIGRACION.indexOf('businesses_marketplace_sin_canal_check check'))
    for (const columna of ['whatsapp_number', 'ycloud_number', 'meta_phone_id']) {
      expect(guarda.slice(0, 400)).toContain(columna)
    }
  })

  it('inserta el número con nullif: la columna es UNIQUE y dos «» chocarían', () => {
    // Sin esto, el PRIMER negocio del marketplace se crea y el SEGUNDO revienta
    // contra un índice único con un error que no explica nada.
    expect(MIGRACION).toMatch(/nullif\(v_whatsapp_number, ''\)/)
    expect(SCHEMA).toMatch(/nullif\(v_whatsapp_number, ''\)/)
  })

  it('el número sigue siendo obligatorio para quien tiene canal propio', () => {
    expect(MIGRACION).toMatch(
      /v_whatsapp_provider <> 'marketplace'\s+and v_whatsapp_number = ''/,
    )
  })

  it('el refresco de identificadores sale antes de exigir credenciales', () => {
    const funcion = MIGRACION.slice(
      MIGRACION.indexOf('function public.refresh_business_channel_identifiers'),
      MIGRACION.indexOf('function public.create_business_onboarding'),
    )
    const salida = funcion.indexOf("if v_whatsapp_provider = 'marketplace' then")
    const exigeYcloud = funcion.indexOf('YCloud requiere un teléfono de canal válido')
    expect(salida, 'falta la salida temprana del marketplace').toBeGreaterThan(0)
    expect(exigeYcloud, 'la validación de YCloud debería seguir ahí').toBeGreaterThan(salida)
    expect(funcion).toMatch(/delete from public\.business_channel_identifiers/)
  })

  it('schema.sql y la migración dicen lo mismo de las dos funciones', () => {
    // El CI aplica `schema.sql` sobre una base vacía; producción recibe la
    // migración. Si divergen, el CI sale verde sobre una ficción. El onboarding
    // ya lo vigila `retirement-onboarding-migrations.test.js`; esta es la otra.
    const extraer = (sql, nombre) => {
      const i = sql.lastIndexOf(`create or replace function public.${nombre}`)
      expect(i, `falta ${nombre}`).toBeGreaterThan(0)
      return sql.slice(i, sql.indexOf('\n$$;', i) + 4)
    }
    expect(extraer(SCHEMA, 'refresh_business_channel_identifiers'))
      .toBe(extraer(MIGRACION, 'refresh_business_channel_identifiers'))
  })

  it('vuelve a declarar los permisos de las dos funciones que recrea', () => {
    // `create or replace` conserva la ACL, pero aplicada sobre una base donde
    // la función no exista nacería con EXECUTE para PUBLIC — y el refresco es
    // `security definer`.
    const ejecutable = sinComentarios(MIGRACION)
    for (const funcion of [
      'refresh_business_channel_identifiers',
      'create_business_onboarding',
    ]) {
      expect(ejecutable, funcion).toMatch(
        new RegExp(`revoke all on function public\\.${funcion}`),
      )
      expect(ejecutable, funcion).toMatch(
        new RegExp(`grant execute on function public\\.${funcion}[\\s\\S]{0,120}service_role`),
      )
    }
  })

  it('no abre su propia transacción, pero sí acota los bloqueos', () => {
    // El ejecutor ya abre una: abrir otra dejaría fuera el registro de la
    // migración. `set local` sí vale, y evita que un `add constraint` con
    // ACCESS EXCLUSIVE bloquee el alta de clientes.
    expect(sinComentarios(MIGRACION)).not.toMatch(/^\s*(begin|commit)\s*;/im)
    expect(MIGRACION).toContain("set local lock_timeout")
  })

  it('no recrea ninguna función del dinero', () => {
    expect(sinComentarios(MIGRACION)).not.toMatch(/create_storefront_order|set_order_status/)
  })

  it('es aditiva: no borra columnas, tablas ni datos', () => {
    const ejecutable = sinComentarios(MIGRACION)
    expect(ejecutable).not.toMatch(/drop\s+(table|column)/i)
    expect(ejecutable).not.toMatch(/delete\s+from\s+public\.businesses/i)
    // Los únicos `drop constraint` son los dos `if exists` que preceden a cada
    // `add constraint`, que es como se reemplaza un CHECK sin duplicarlo.
    const drops = ejecutable.match(/drop constraint[^\n;]*/gi) || []
    expect(drops).toHaveLength(2)
    expect(drops.every(linea => /if exists/i.test(linea))).toBe(true)
  })
})
