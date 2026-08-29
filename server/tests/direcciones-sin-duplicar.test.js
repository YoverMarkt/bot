// ═══════════════════════════════════════════════════════════════════════════
// LA MISMA CASA NO SE GUARDA DOS VECES
// ═══════════════════════════════════════════════════════════════════════════
//
// Medido en producción el 2026-08-29: un cliente tenía **12 direcciones, siete
// borradas a mano por él** y la misma calle repetida cinco veces.
//
// El camino que las creaba: si la app no consigue leer la libreta —un 401 al
// arrancar, la sesión que se estrena, la red— enseña «no tienes direcciones» y
// la persona escribe la suya otra vez. Eso ya se corrigió en el teléfono, pero
// esa defensa vive en el teléfono. Esta vive donde se ESCRIBE, así que aguanta
// aunque el frontend falle por un motivo que nadie ha previsto todavía.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const clientPath = require.resolve('../dist/db/client')
const repoPath = require.resolve('../dist/db/repositories/storefront')
const originalClientModule = require.cache[clientPath]

/** Un `from(...)` encadenable que devuelve lo que se le diga. */
function consulta(resultado, registro) {
  const q = {
    select: vi.fn(() => q),
    insert: vi.fn((fila) => { registro.insertadas.push(fila); return q }),
    update: vi.fn((fila) => { registro.actualizadas.push(fila); return q }),
    eq: vi.fn(() => q),
    order: vi.fn(() => q),
    single: vi.fn(() => q),
    then: (ok, mal) => Promise.resolve(resultado).then(ok, mal),
  }
  return q
}

function cargarRepositorio(resultados) {
  const registro = { insertadas: [], actualizadas: [], tablas: [] }
  let i = 0
  const client = {
    from: vi.fn((tabla) => {
      registro.tablas.push(tabla)
      return consulta(resultados[Math.min(i++, resultados.length - 1)], registro)
    }),
  }
  require.cache[clientPath] = { exports: client }
  delete require.cache[repoPath]
  return { repo: require(repoPath), registro }
}

afterEach(() => {
  delete require.cache[repoPath]
  if (originalClientModule) require.cache[clientPath] = originalClientModule
  else delete require.cache[clientPath]
})

const NUEVA = {
  businessId: 'negocio-1',
  customerId: 'cliente-1',
  label: 'Casa',
  address: 'Av. Amazonas N34-120',
}

describe('guardar una dirección', () => {
  it('crea la dirección cuando NO existe ninguna igual', async () => {
    const { repo, registro } = cargarRepositorio([
      // 1ª consulta: la libreta, vacía.
      { data: [], error: null },
      // 2ª: el insert.
      { data: { id: 'dir-nueva', address: NUEVA.address }, error: null },
    ])

    const creada = await repo.createCustomerAddress(NUEVA)

    expect(creada.id).toBe('dir-nueva')
    expect(registro.insertadas).toHaveLength(1)
    expect(registro.actualizadas).toHaveLength(0)
  })

  it('REUTILIZA la que ya está en vez de crear una repetida', async () => {
    const { repo, registro } = cargarRepositorio([
      { data: [{ id: 'dir-vieja', address: 'Av. Amazonas N34-120' }], error: null },
      { data: { id: 'dir-vieja', address: 'Av. Amazonas N34-120' }, error: null },
    ])

    const guardada = await repo.createCustomerAddress(NUEVA)

    // Devuelve la de siempre, CON SU ID: es lo que el checkout necesita para
    // dejarla elegida en este pedido.
    expect(guardada.id).toBe('dir-vieja')
    expect(registro.insertadas).toHaveLength(0)
    expect(registro.actualizadas).toHaveLength(1)
  })

  it('las reconoce aunque se escriban distinto', async () => {
    // Quien teclea en el móvil de una tienda no piensa en tildes ni en dobles
    // espacios. «AV. AMAZONAS  n34-120» es la misma casa.
    const { repo, registro } = cargarRepositorio([
      { data: [{ id: 'dir-vieja', address: '  av. amazonás   N34-120 ' }], error: null },
      { data: { id: 'dir-vieja' }, error: null },
    ])

    await repo.createCustomerAddress({ ...NUEVA, address: 'AV. AMAZONAS N34-120' })

    expect(registro.insertadas).toHaveLength(0)
  })

  it('una dirección DISTINTA sí se crea', async () => {
    const { repo, registro } = cargarRepositorio([
      { data: [{ id: 'dir-vieja', address: 'Av. Amazonas N34-120' }], error: null },
      { data: { id: 'dir-2' }, error: null },
    ])

    await repo.createCustomerAddress({ ...NUEVA, address: 'Av. República del Salvador 890' })

    expect(registro.insertadas).toHaveLength(1)
  })

  it('al reutilizar NO borra el pin que ya tenía', async () => {
    // Si esta vez el navegador negó el permiso de ubicación, perder la
    // coordenada guardada sería un paso atrás para el repartidor.
    const { repo, registro } = cargarRepositorio([
      { data: [{ id: 'dir-vieja', address: 'Av. Amazonas N34-120' }], error: null },
      { data: { id: 'dir-vieja' }, error: null },
    ])

    await repo.createCustomerAddress({ ...NUEVA, latitude: null, longitude: null })

    const cambio = registro.actualizadas[0]
    expect(cambio).not.toHaveProperty('latitude')
    expect(cambio).not.toHaveProperty('longitude')
  })

  it('al reutilizar SÍ guarda un pin nuevo', async () => {
    const { repo, registro } = cargarRepositorio([
      { data: [{ id: 'dir-vieja', address: 'Av. Amazonas N34-120' }], error: null },
      { data: { id: 'dir-vieja' }, error: null },
    ])

    await repo.createCustomerAddress({ ...NUEVA, latitude: -0.17, longitude: -78.48, accuracyM: 12 })

    expect(registro.actualizadas[0]).toMatchObject({ latitude: -0.17, longitude: -78.48 })
  })
})
