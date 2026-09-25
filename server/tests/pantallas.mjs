import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// LEER LAS PANTALLAS SIN CONFUNDIR UN COMENTARIO CON CÓDIGO
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo comparten los guardianes que recorren el código de las apps buscando algo
// que no debe estar (los vistos dibujados a mano, los controles a pelo). Vivía
// dentro de `iconos-guardian.test.js`; se sacó aquí el 2026-09-24 cuando nació
// el segundo guardián, para no tener dos copias que un día dejen de coincidir.

export const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Las líneas que son comentario, marcadas de una pasada.
 *
 * ⚠️ Hay que RASTREAR el bloque, no mirar línea a línea: la segunda línea de
 * un comentario `{/* … *\/}` de JSX no empieza por `*` ni por `//`, y un
 * detector ingenuo la daba por código. Lo destapó el guardián de iconos
 * señalando el comentario que explica su propia regla.
 */
export function lineasDeComentario(lineas) {
  const marcadas = new Set()
  let dentro = false
  lineas.forEach((linea, i) => {
    const limpia = linea.trim()
    if (dentro) {
      marcadas.add(i)
      if (limpia.includes('*/')) dentro = false
      return
    }
    if (limpia.startsWith('//')) return marcadas.add(i)
    const abre = linea.indexOf('/*')
    if (abre === -1) return
    marcadas.add(i)
    // Un bloque que abre y cierra en la misma línea no deja nada abierto.
    if (linea.indexOf('*/', abre) === -1) dentro = true
  })
  return marcadas
}

/** Todos los `.ts` y `.tsx` bajo `dir` (relativo a la raíz del monorepo). */
export function fuentes(dir) {
  const completa = path.join(raiz, dir)
  let entradas = []
  try { entradas = readdirSync(completa) } catch { return [] }
  return entradas.flatMap((nombre) => {
    const ruta = path.join(dir, nombre)
    if (statSync(path.join(raiz, ruta)).isDirectory()) return fuentes(ruta)
    return /\.tsx?$/.test(nombre) ? [ruta] : []
  })
}
