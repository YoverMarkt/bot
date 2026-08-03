import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'

// ═══════════════════════════════════════════════════════════════════════════
// CONTRATO ENTRE LOS PANELES Y EL SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════
//
// Nace de la auditoría del 2026-08-02, que encontró un hueco estructural: si
// una ruta se renombra o se retira, NADIE se entera hasta que un cliente ve la
// pantalla en blanco.
//
//   · TypeScript no lo ve: los paneles declaran sus propios tipos y no
//     comparten nada con el servidor. Cada lado compila feliz por su cuenta.
//   · Los tests del servidor no lo ven: falsean la capa `db`, no el contrato.
//   · Los E2E no lo ven: interceptan `**/api/client/**` con `route.fulfill`,
//     así que el backend Node NUNCA arranca en Playwright.
//
// Este test cierra ese hueco por el lado que más duele y que se puede
// comprobar sin ambigüedad: **toda ruta que un panel llama tiene que existir
// en el servidor**.
//
// No es una lista mantenida a mano —eso sería otra sensación de cobertura—:
// los dos lados se LEEN. Las llamadas salen de `api<Tipo>('/ruta')` en los
// paneles; las rutas salen de montar los routers REALES en un Express REAL y
// recorrer su stack.
//
// Lo que este test NO comprueba, a propósito: los campos de cada respuesta.
// Casi todas las rutas devuelven lo que les da `db` tal cual, así que
// falsear `db` para mirar la forma sería asegurarse de que el propio simulacro
// tiene los campos que se le pusieron. Eso no probaría nada.

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const raiz = path.resolve(serverDir, '..')
const require = createRequire(import.meta.url)

// ── Lado servidor: los routers REALES sobre un Express REAL ────────────────
//
// Se montan igual que en `src/index.ts`: en la raíz, porque cada router
// declara rutas absolutas. No se usa `index.ts` mismo porque abre el puerto y
// se conecta a Supabase; aquí solo hace falta el árbol de rutas.
const ROUTERS = [
  'auth.routes', 'admin.routes', 'business.routes', 'sessions.routes',
  'sales.routes', 'reports.routes', 'bookings.routes', 'products.routes',
  'orders.routes', 'webhooks.routes', 'lodging.routes', 'menu-modifiers.routes',
  'catalog-structure.routes', 'storefront.routes',
]

const app = express()
for (const nombre of ROUTERS) {
  app.use(require(path.join(serverDir, 'dist/routes', nombre)))
}

/** `:id`, `:slug`… se vuelven `:_`: lo que importa es la FORMA de la ruta. */
const canonica = ruta => ruta.replace(/:[^/]+/g, ':_').replace(/\/+$/, '') || '/'

/** Recorre el stack de Express y devuelve `METODO /ruta` de cada capa. */
function rutasDelServidor(capas, prefijo = '') {
  return capas.flatMap((capa) => {
    if (capa.route) {
      const ruta = canonica(prefijo + capa.route.path)
      return Object.keys(capa.route.methods)
        .filter(m => m !== '_all')
        .map(m => `${m.toUpperCase()} ${ruta}`)
    }
    if (capa.handle?.stack) return rutasDelServidor(capa.handle.stack, prefijo)
    return []
  })
}

const DEL_SERVIDOR = new Set(rutasDelServidor(app._router?.stack || app.router.stack))

// ── Lado panel: lo que los paneles llaman de verdad ────────────────────────

function archivos(dir) {
  return readdirSync(dir).flatMap((entrada) => {
    if (entrada === 'node_modules' || entrada === 'dist') return []
    const completa = path.join(dir, entrada)
    if (statSync(completa).isDirectory()) return archivos(completa)
    return /\.tsx?$/.test(entrada) ? [completa] : []
  })
}

/**
 * Normaliza la ruta escrita en el panel a la forma que declara el servidor.
 *
 * La regla que distingue los dos usos de `${…}` en estas plantillas:
 *
 *   · precedido de `/` es un PARÁMETRO      → `/sessions/${phone}/quote`
 *   · no precedido de `/` es un SUFIJO      → `/errors${category ? '?…' : ''}`
 *
 * El sufijo siempre construye la query, que el servidor no declara, así que se
 * corta ahí. Sin esta distinción salían falsos positivos como
 * `/api/admin/errors${category`, y un guardián ruidoso se acaba ignorando.
 */
function rutaDelPanel(crudo) {
  const sinQuery = crudo.split('?')[0]
  const sufijo = [...sinQuery.matchAll(/\$\{/g)]
    .find(m => sinQuery[m.index - 1] !== '/')
  const soloRuta = sufijo ? sinQuery.slice(0, sufijo.index) : sinQuery
  return canonica(soloRuta.replace(/\$\{[^}]*\}/g, ':_'))
}

/** Cada `api<Tipo>('/ruta', { method: 'PUT' })` de los paneles. */
const LLAMADAS = ['apps/client/src', 'apps/admin/src'].flatMap((relativo) => {
  const base = path.join(raiz, relativo)
  return archivos(base).flatMap((archivo) => {
    const contenido = readFileSync(archivo, 'utf8')
    const encontradas = []
    const patron = /\bapi<[^>]*>\(\s*([`'"])([^`'"]*)\1([^)]*)/g
    let coincidencia
    while ((coincidencia = patron.exec(contenido)) !== null) {
      const [, , crudo, resto] = coincidencia
      const metodo = (resto.match(/method:\s*['"](\w+)['"]/) || [])[1] || 'GET'
      const ruta = rutaDelPanel(crudo)
      if (!ruta.startsWith('/api')) continue
      encontradas.push({
        llamada: `${metodo.toUpperCase()} ${ruta}`,
        archivo: path.relative(raiz, archivo),
      })
    }
    return encontradas
  })
})

describe('contrato entre los paneles y el servidor', () => {
  it('encuentra rutas en el servidor y llamadas en los paneles (si no, no probaría nada)', () => {
    // Si un día los routers dejan de montarse o el patrón deja de casar, este
    // test se quedaría en verde comparando dos listas vacías.
    expect(DEL_SERVIDOR.size).toBeGreaterThan(60)
    expect(LLAMADAS.length).toBeGreaterThan(50)
    expect([...DEL_SERVIDOR]).toContain('GET /api/client/orders')
  })

  it('toda ruta que un panel llama existe en el servidor', () => {
    const huerfanas = LLAMADAS
      .filter(({ llamada }) => !DEL_SERVIDOR.has(llamada))
      .map(({ llamada, archivo }) => `${llamada}  ← ${archivo}`)

    expect(
      [...new Set(huerfanas)],
      'El panel llama a rutas que el servidor no sirve. O se renombró la ruta '
      + 'sin tocar el panel, o el panel se adelantó al servidor.',
    ).toEqual([])
  })

  it('el guardián detecta una ruta que el servidor no sirve', () => {
    // Que el test corra no significa que vea. Se comprueba el detector mismo.
    const inventada = 'GET /api/client/esta-ruta-no-existe'
    expect(DEL_SERVIDOR.has(inventada)).toBe(false)
  })
})
