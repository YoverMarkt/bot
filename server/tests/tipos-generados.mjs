#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// LOS TIPOS DE LA BASE, GENERADOS DESDE LA BASE
// ═══════════════════════════════════════════════════════════════════════════
//
//   npm run tipos:generar -w @botpanel/server     regenera el archivo
//   npm run tipos:generar -w @botpanel/server -- --verificar
//                                                 falla si está desactualizado
//
// ⚠️ Cierra la familia del incidente del 2026-08-02: había 115 `as` en la capa
// de datos que el compilador no comprobaba, porque **afirmar un tipo no es
// verificarlo**. Destapó cuatro bugs reales.
//
// ⚠️ Y el archivo generado NO sirve de nada por sí solo. Lo que hace que se
// compruebe algo es que el cliente y los repositorios lleven `<Database>`:
// `SupabaseClient` a secas es `SupabaseClient<any>` y convierte la base entera
// en un `any` con buenos modales. Se descubrió aquí mismo: los tipos se
// generaron, compilaron a la primera con CERO errores… porque 22 repositorios
// los estaban anulando. Es el patrón «construido y desconectado» otra vez.
//
// Usa el POOLER (IPv4). Ver `VERIFICACION.md`.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const servidor = path.resolve(aqui, '..')
const DESTINO = path.join(servidor, 'src/db/tipos-generados.ts')

const CABECERA = `// ═══════════════════════════════════════════════════════════════════════════
// TIPOS GENERADOS DESDE LA BASE — NO SE EDITA A MANO
// ═══════════════════════════════════════════════════════════════════════════
//
// Los escribe la CLI de Supabase leyendo el esquema REAL, no una copia:
//
//   npm run tipos:generar -w @botpanel/server
//
// ⚠️ Cierra la familia del incidente del 2026-08-02: 115 \`as\` en la capa de
// datos que el compilador NO comprobaba, porque afirmar un tipo no es
// verificarlo. Destapó cuatro bugs reales.
//
// ⚠️ Generarlos no basta: sin \`SupabaseClient<Database>\` en cada repositorio,
// esto es decoración. \`SupabaseClient\` a secas es \`SupabaseClient<any>\`.
//
// ⚠️ Si al regenerar salen cambios que no esperabas, NO los edites: mira qué
// cambió en la base. Este archivo es el reflejo, no la fuente.
`

const directa = process.env.DATABASE_URL
if (!directa) {
  console.error('❌ Falta DATABASE_URL en server/.env')
  process.exit(1)
}

// El host directo de Supabase es IPv6 puro; la CLI va por el pooler IPv4.
const url = new URL(directa)
const ref = url.hostname.replace(/^db\./, '').replace(/\.supabase\.co$/, '')
const pooler = new URL(directa)
pooler.hostname = process.env.POOLER_HOST || 'aws-1-sa-east-1.pooler.supabase.com'
pooler.username = `postgres.${ref}`
pooler.port = '5432'

console.log('🔎 Leyendo el esquema de la base…')
let generado
try {
  generado = execFileSync(
    'supabase',
    ['gen', 'types', 'typescript', '--db-url', pooler.toString(), '--schema', 'public'],
    { encoding: 'utf8', cwd: path.resolve(servidor, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  )
} catch (error) {
  // Nunca imprimir el error crudo: lleva la URI con la contraseña.
  console.error('\n❌ No se pudieron generar los tipos.')
  console.error('   ¿Está instalada la CLI?  brew install supabase/tap/supabase')
  console.error('   La contraseña de la base no se ha mostrado.')
  process.exit(1)
}

const contenido = CABECERA + generado

if (process.argv.includes('--verificar')) {
  const actual = readFileSync(DESTINO, 'utf8')
  if (actual.trim() === contenido.trim()) {
    console.log('✅ Los tipos están al día con la base.')
    process.exit(0)
  }
  console.error('\n❌ `src/db/tipos-generados.ts` NO coincide con la base.')
  console.error('   Alguien cambió el esquema sin regenerarlos.')
  console.error('   Arréglalo con:  npm run tipos:generar -w @botpanel/server\n')
  process.exit(1)
}

writeFileSync(DESTINO, contenido)
const tablas = (generado.match(/Row:/g) || []).length
const funciones = (generado.match(/Args:/g) || []).length
console.log(`✅ ${tablas} tablas y ${funciones} funciones escritas en src/db/tipos-generados.ts`)
