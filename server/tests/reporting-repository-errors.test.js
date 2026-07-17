import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const clientPath = require.resolve('../dist/db/client')
const repositoryPaths = [
  require.resolve('../dist/db/repositories/sales'),
  require.resolve('../dist/db/repositories/reporting'),
  require.resolve('../dist/db/repositories/sessions'),
  require.resolve('../dist/db/repositories/products'),
  require.resolve('../dist/db/repositories/client-users'),
]
const originalClientModule = require.cache[clientPath]

function queryResult(result) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gte: vi.fn(() => query),
    lte: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function loadRepository(name, results) {
  const path = require.resolve(`../dist/db/repositories/${name}`)
  let index = 0
  const client = {
    from: vi.fn(() => queryResult(results[Math.min(index++, results.length - 1)])),
  }
  require.cache[clientPath] = { exports: client }
  delete require.cache[path]
  return require(path)
}

afterEach(() => {
  for (const path of repositoryPaths) delete require.cache[path]
  if (originalClientModule) require.cache[clientPath] = originalClientModule
  else delete require.cache[clientPath]
})

describe('errores de Supabase en repositorios de reportes', () => {
  it('propaga fallos de ventas en vez de convertirlos en un reporte vacío', async () => {
    const sales = loadRepository('sales', [
      { data: null, error: { message: 'ventas no disponibles' } },
    ])

    await expect(sales.getSalesWithItems('business-a'))
      .rejects.toThrow('ventas no disponibles')
  })

  it('distingue cero escritores de un fallo al contar conversaciones', async () => {
    const emptyReporting = loadRepository('reporting', [{ data: [], error: null }])
    await expect(emptyReporting.getWritersInRange('business-a')).resolves.toBe(0)

    const failedReporting = loadRepository('reporting', [
      { data: null, error: { message: 'historial no disponible' } },
    ])
    await expect(failedReporting.getWritersInRange('business-a'))
      .rejects.toThrow('historial no disponible')
  })

  it('propaga el fallo de cualquiera de las fuentes de pedidos pendientes', async () => {
    const reporting = loadRepository('reporting', [
      { data: [], error: null },
      { data: null, error: { message: 'ventas pendientes no disponibles' } },
    ])

    await expect(reporting.getPendingOrders('business-a'))
      .rejects.toThrow('ventas pendientes no disponibles')
  })

  it('propaga fallos de sesiones sin ocultarlos como una lista vacía', async () => {
    const sessions = loadRepository('sessions', [
      { data: null, error: { message: 'sesiones no disponibles' } },
    ])

    await expect(sessions.getSessions('business-a'))
      .rejects.toThrow('sesiones no disponibles')
  })

  it.each([
    ['products', 'getProducts', 'catálogo no disponible'],
    ['client-users', 'getClientUsers', 'usuarios no disponibles'],
  ])('propaga fallos de %s usados por los reportes', async (repository, method, message) => {
    const loaded = loadRepository(repository, [
      { data: null, error: { message } },
    ])

    await expect(loaded[method]('business-a')).rejects.toThrow(message)
  })
})
