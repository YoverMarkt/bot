#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// PRESUPUESTO DE TAMAÑO DE LA MINI APP
// ═══════════════════════════════════════════════════════════════════════════
//
// Por qué existe: esta app la abre el cliente final desde WhatsApp, con datos
// móviles y a menudo con mala señal. Cada kilobyte se paga en gente que cierra
// antes de que cargue — y una venta perdida así no deja rastro en ningún log.
//
// Por eso la tienda va DELIBERADAMENTE sin router y sin cliente de datos, algo
// que un `import` distraído deshace en un segundo: react-router son ~10 kB
// gzip y react-query ~13 kB, cifras que nadie nota revisando un diff pero que
// se notan en el teléfono de quien compra.
//
// El presupuesto no premia adelgazar; solo impide engordar sin darse cuenta.
// Si un cambio lo necesita de verdad, se sube el número a propósito y queda
// escrito en el historial quién decidió que valía la pena.
import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(RAIZ, 'dist')

// Medido el 2026-08-02: 76,0 kB.
//
// El margen (6 kB) está calibrado a propósito por DEBAJO de la librería más
// pequeña que querríamos cazar: react-router son ~10 kB gzip. Un presupuesto
// con más holgura que eso deja pasar justo lo que dice vigilar y solo sirve
// para dar tranquilidad falsa. Seis kilobytes dan para una pantalla o dos, que
// es como crece esta app de verdad.
const PRESUPUESTO_KB = 82

const recorrer = dir => readdirSync(dir).flatMap(entrada => {
  const completa = path.join(dir, entrada)
  return statSync(completa).isDirectory() ? recorrer(completa) : [completa]
})

// Lo que el navegador descarga para pintar la primera pantalla. Las fuentes y
// las imágenes quedan fuera a propósito: llegan después y no bloquean.
const CUENTA = new Set(['.js', '.css', '.html'])

const archivos = recorrer(DIST)
  .filter(f => CUENTA.has(path.extname(f)))
  .map(f => ({
    nombre: path.relative(DIST, f),
    gzip: gzipSync(readFileSync(f)).length,
  }))
  .sort((a, b) => b.gzip - a.gzip)

if (!archivos.length) {
  console.error('❌ No hay nada en dist/. Compila primero: npm run build -w @botpanel/store')
  process.exit(1)
}

const total = archivos.reduce((suma, a) => suma + a.gzip, 0)
const kb = n => (n / 1024).toFixed(1)

console.log('\n📦 Tamaño de la mini app (gzip, primera carga)\n')
for (const a of archivos) {
  console.log(`   ${kb(a.gzip).padStart(7)} kB  ${a.nombre}`)
}
console.log(`   ${'─'.repeat(9)}`)
console.log(`   ${kb(total).padStart(7)} kB  TOTAL   (presupuesto: ${PRESUPUESTO_KB} kB)\n`)

if (total > PRESUPUESTO_KB * 1024) {
  console.error(`❌ La tienda pesa ${kb(total)} kB y el presupuesto son ${PRESUPUESTO_KB} kB.`)
  console.error('')
  console.error('   Quien abre esto lo hace desde WhatsApp, con datos móviles. Antes de')
  console.error('   subir el número, mira qué entró: casi siempre es una librería que')
  console.error('   resuelve en 30 kB algo que aquí se hace en 30 líneas.')
  console.error('')
  console.error(`   Si de verdad hace falta, sube PRESUPUESTO_KB en ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`)
  console.error('   y explica en el commit por qué valía la pena.')
  process.exit(1)
}

const margen = PRESUPUESTO_KB - total / 1024
console.log(`✅ Dentro del presupuesto (quedan ${margen.toFixed(1)} kB de margen).\n`)
