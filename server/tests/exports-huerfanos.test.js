import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// GUARDIÁN DE EXPORTS DEL SERVIDOR QUE YA NO LLAMA NADIE
// ═══════════════════════════════════════════════════════════════════════════
//
// knip no puede hacer esto aquí, y no es culpa suya: el servidor importa con
// `require('...')` tipado —el patrón CommonJS del proyecto— y ninguna
// herramienta genérica lo rastrea. En su primera pasada marcó 71 exports como
// muertos y el primero que se comprobó, `authClient`, tenía 66 usos reales.
//
// Este test sí entiende el patrón: los módulos del servidor terminan en
//   export = { unaCosa, otraCosa }
// y quien los usa escribe `modulo.unaCosa(...)`. Así que basta con mirar si
// alguien nombra la clave en cualquier parte del código o de las pruebas.
//
// Deliberadamente CONSERVADOR: prefiere callar antes que dar un falso
// positivo, porque un guardián ruidoso se acaba ignorando. Solo caza lo que
// nadie nombra en ningún sitio, que es código muerto sin discusión.

const serverDir = fileURLToPath(new URL('..', import.meta.url))

function archivos(dir, extension) {
  return readdirSync(dir).flatMap((entrada) => {
    if (entrada === 'node_modules' || entrada === 'dist') return []
    const completa = path.join(dir, entrada)
    if (statSync(completa).isDirectory()) return archivos(completa, extension)
    return entrada.endsWith(extension) ? [completa] : []
  })
}

const fuentes = archivos(path.join(serverDir, 'src'), '.ts')
const pruebas = [
  ...archivos(path.join(serverDir, 'tests'), '.js'),
  ...archivos(path.join(serverDir, 'tests'), '.mjs'),
]
const todo = [...fuentes, ...pruebas].map(f => readFileSync(f, 'utf8')).join('\n')

/** Las claves de cada `export = { … }`, con el archivo que las expone. */
const exportados = fuentes.flatMap((archivo) => {
  const contenido = readFileSync(archivo, 'utf8')
  const bloque = contenido.match(/export\s*=\s*\{([\s\S]*?)\}/)
  if (!bloque) return []
  return bloque[1]
    .split(',')
    .map(linea => linea.split(':')[0].trim())
    .filter(nombre => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nombre))
    .map(nombre => ({ nombre, archivo: path.relative(serverDir, archivo) }))
})

describe('exports del servidor sin quien los llame', () => {
  it('encuentra los módulos que exportan con export = (si no, no probaría nada)', () => {
    expect(exportados.length).toBeGreaterThanOrEqual(50)
    expect(exportados.map(e => e.nombre)).toContain('getOrders')
  })

  it('nadie exporta algo que después no usa ni nombra', () => {
    const huerfanos = exportados.filter(({ nombre, archivo }) => {
      // Se cuentan las veces que aparece el nombre en TODO el servidor,
      // incluidas las pruebas. Su propia declaración en el `export = {}` es
      // una de ellas: con una sola aparición, no lo usa nadie.
      const apariciones = todo.split(new RegExp(`\\b${nombre}\\b`)).length - 1
      // Los repositorios declaran el nombre dos veces: la función y su
      // reexportación al final del archivo.
      const propias = archivo.includes('repositories/') ? 2 : 1
      return apariciones <= propias
    })

    expect(
      huerfanos.map(h => `${h.archivo} → ${h.nombre}`),
      huerfanos.length
        ? 'Estos exports no los nombra nadie en todo el servidor, ni siquiera\n'
          + 'una prueba. O sobran, o falta usarlos:\n'
          + `${huerfanos.map(h => `  · ${h.archivo} → ${h.nombre}`).join('\n')}`
        : '',
    ).toEqual([])
  })
})
