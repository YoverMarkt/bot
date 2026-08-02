// Compara lo que schema.sql PRODUCE (leído de un PostgreSQL real, no parseado)
// contra lo que hay en la base de producción.
//
// Lo lanza `comparar-con-produccion.sh`, que es quien levanta el PostgreSQL y
// le pregunta qué salió. Aquí solo se lee el catálogo de producción y se
// comparan las dos fotos.
//
// Ver la cabecera del .sh para el porqué de todo esto.

import { readFileSync } from 'node:fs'

const rutaEsperado = process.argv[2]
if (!rutaEsperado) {
  console.error('❌ Úsalo con: bash server/tests/sql/comparar-con-produccion.sh')
  process.exit(1)
}

const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: llave } = process.env
if (!url || !llave) {
  console.error('❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en server/.env')
  process.exit(1)
}

const esperado = JSON.parse(readFileSync(rutaEsperado, 'utf8'))

// ── Producción, vía el catálogo que publica PostgREST ───────────────────────
const respuesta = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: llave, authorization: `Bearer ${llave}` },
})
if (!respuesta.ok) {
  console.error(`❌ No se pudo leer el catálogo de producción (${respuesta.status})`)
  process.exit(1)
}
const catalogo = await respuesta.json()

const tablasReales = new Map(
  Object.entries(catalogo.definitions || {}).map(([tabla, definicion]) => [
    tabla.toLowerCase(),
    new Set(Object.keys(definicion.properties || {}).map(c => c.toLowerCase())),
  ]),
)
const funcionesReales = new Set(
  Object.keys(catalogo.paths || {})
    .filter(ruta => ruta.startsWith('/rpc/'))
    .map(ruta => ruta.slice(5).toLowerCase()),
)

const tablasEsperadas = new Map(
  Object.entries(esperado.tablas || {}).map(([tabla, columnas]) => [
    tabla.toLowerCase(),
    new Set(columnas.map(c => String(c).toLowerCase())),
  ]),
)

// Solo se comparan las funciones que PostgREST expone. Las de disparador
// (`returns trigger`) no salen por la API y compararlas daría falsos positivos.
const funcionesEsperadas = new Set(
  (esperado.funciones || []).map(f => String(f).toLowerCase()),
)

// ── Comparación ─────────────────────────────────────────────────────────────
console.log('\nComparando schema.sql contra la base REAL (solo lectura)\n')
console.log(`   schema.sql produce: ${tablasEsperadas.size} tablas`)
console.log(`   producción tiene:   ${tablasReales.size} tablas expuestas`)

let problemas = 0

console.log('\n── Tablas')
const faltan = [...tablasEsperadas.keys()].filter(t => !tablasReales.has(t)).sort()
const sobran = [...tablasReales.keys()].filter(t => !tablasEsperadas.has(t)).sort()

if (faltan.length) {
  problemas += faltan.length
  console.log(`   ❌ ${faltan.length} que schema.sql crea y producción NO tiene:`)
  console.log('      Falta correr una migración. El código que las use fallará.')
  for (const t of faltan) console.log(`      · ${t}`)
}
if (sobran.length) {
  problemas += sobran.length
  console.log(`   ❌ ${sobran.length} que producción tiene y schema.sql NO crea:`)
  console.log('      Se corrió una migración sin actualizar el consolidado.')
  console.log('      Una instalación nueva quedaría sin ellas.')
  for (const t of sobran) console.log(`      · ${t}`)
}
if (!faltan.length && !sobran.length) console.log('   ✅ las mismas en ambos lados')

console.log('\n── Columnas')
let conDeriva = 0
for (const [tabla, columnas] of tablasEsperadas) {
  const reales = tablasReales.get(tabla)
  if (!reales) continue
  const sinCrear = [...columnas].filter(c => !reales.has(c)).sort()
  const deMas = [...reales].filter(c => !columnas.has(c)).sort()
  if (!sinCrear.length && !deMas.length) continue
  conDeriva += 1
  problemas += sinCrear.length + deMas.length
  console.log(`   ❌ ${tabla}`)
  if (sinCrear.length) {
    console.log(`      schema.sql las crea y producción no las tiene: ${sinCrear.join(', ')}`)
  }
  if (deMas.length) {
    console.log(`      producción las tiene y schema.sql no las crea: ${deMas.join(', ')}`)
  }
}
if (!conDeriva) console.log('   ✅ coinciden en todas las tablas')

console.log('\n── Funciones expuestas por la API')
const funcionesQueFaltan = [...funcionesReales]
  .filter(f => !funcionesEsperadas.has(f))
  .sort()
if (funcionesQueFaltan.length) {
  problemas += funcionesQueFaltan.length
  console.log(`   ❌ ${funcionesQueFaltan.length} en producción que schema.sql no crea:`)
  for (const f of funcionesQueFaltan) console.log(`      · ${f}`)
} else {
  console.log('   ✅ producción no tiene funciones que el archivo desconozca')
}

// Informativo: los BEFORE son la familia del fallo del alta de clientes.
const before = (esperado.disparadores || []).filter(d => String(d).endsWith('BEFORE'))
console.log(`\n── Disparadores BEFORE en schema.sql (${before.length})`)
console.log('   Un BEFORE que escribe en otra tabla apuntando a la fila que aún no')
console.log('   existe rompe la clave foránea. Fue el fallo del 2026-08-02.')
for (const d of before) console.log(`   · ${String(d).replace(' BEFORE', '')}`)

console.log(
  problemas
    ? `\n❌ ${problemas} diferencias entre schema.sql y la base real`
    : '\n✅ La base real coincide con lo que produce schema.sql',
)
console.log(
  '\n⚠️  Compara NOMBRES. No ve el cuerpo de las funciones ni los disparadores\n'
  + '   de producción. Para eso: npm run verify:schema -w @botpanel/server',
)
process.exit(problemas ? 1 : 0)
