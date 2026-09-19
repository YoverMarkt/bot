import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// LOS TIPOS DE LA BASE NO PUEDEN MENTIR
// ═══════════════════════════════════════════════════════════════════════════
//
// `src/db/tipos-generados.ts` lo escribe la CLI de Supabase leyendo el esquema
// real. El peligro de un archivo generado es que envejezca en silencio: alguien
// añade una tabla, no lo regenera, y el tipado sigue verde afirmando cosas de
// un esquema que ya no existe. Eso sería peor que no tenerlo.
//
// Estas pruebas corren SIN credenciales —en el CI no las hay— comparando el
// archivo contra `schema.sql`, que es el consolidado vivo. La comprobación
// contra la base de verdad es `npm run tipos:verificar`.

const servidor = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(`${servidor}/schema.sql`, 'utf8')
const tipos = readFileSync(`${servidor}/src/db/tipos-generados.ts`, 'utf8')

describe('el archivo generado sigue el ritmo del esquema', () => {
  it('toda tabla de schema.sql tiene sus tipos', () => {
    // Si esto falla, alguien creó una tabla y no regeneró:
    //   npm run tipos:generar -w @botpanel/server
    // Solo las de verdad: el regex se ancla a principio de línea porque la
    // cabecera del archivo MENCIONA «CREATE TABLE IF NOT EXISTS no agregan
    // columnas…» y eso colaba una tabla fantasma llamada «no».
    const tablas = [...schema.matchAll(/^create table if not exists (?:public\.)?(\w+)/gim)]
      .map(m => m[1])
      .filter(t => t !== 'schema_migrations')

    expect(tablas.length).toBeGreaterThan(40)
    const sinTipos = tablas.filter(tabla => !new RegExp(`\\b${tabla}: \\{`).test(tipos))
    expect(sinTipos, `tablas sin tipos generados: ${sinTipos.join(', ')}`).toEqual([])
  })

  it('no se edita a mano: lo dice en su cabecera', () => {
    expect(tipos).toContain('NO SE EDITA A MANO')
    expect(tipos).toContain('npm run tipos:generar')
  })
})

describe('los tipos están ENCHUFADOS, no solo generados', () => {
  // ⚠️ La lección del día: los tipos se generaron, el proyecto compiló a la
  // primera con CERO errores… y no comprobaban nada, porque 22 repositorios
  // declaraban `const db: SupabaseClient` — que es `SupabaseClient<any>` y
  // convierte la base entera en un `any` con buenos modales.
  const repos = `${servidor}/src/db/repositories`
  const archivos = readdirSync(repos).filter(f => f.endsWith('.ts'))

  /**
   * Los que TODAVÍA no llevan `<Database>`.
   *
   * No es una lista de vergüenza: es una lista de trabajo. Cada uno falla por
   * el mismo desajuste —el código pasa `null` explícito donde los tipos
   * generados de una RPC con DEFAULT esperan `undefined`—, y «arreglarlo»
   * metiendo conversiones sería volver a los `as` que causaron el incidente
   * del 2026-08-02. Se tipan cuando se toquen, uno a uno y con criterio.
   *
   * ⚠️ Esta lista solo puede ENCOGER. Un repositorio nuevo nace tipado.
   */
  const PENDIENTES = new Set([
    'billing.ts', 'businesses.ts', 'catalog.ts', 'client-users.ts',
    'marketplace-conversations.ts', 'menu-modifiers.ts', 'orders.ts',
    'outbox.ts', 'platform-errors.ts', 'pricing-rules.ts', 'product-options.ts',
    'products.ts', 'reporting.ts', 'schedule.ts', 'storefront.ts', 'usage.ts',
  ])

  const sinTipar = archivos.filter((f) => {
    const t = readFileSync(`${repos}/${f}`, 'utf8')
    return t.includes('const db: SupabaseClient = ')
  })

  it('el cliente de Supabase lleva el tipo de la base', () => {
    const cliente = readFileSync(`${servidor}/src/db/client.ts`, 'utf8')
    expect(cliente).toContain('createClient<Database>')
  })

  it('ningún repositorio NUEVO nace sin tipar', () => {
    const nuevos = sinTipar.filter(f => !PENDIENTES.has(f))
    expect(nuevos, `sin \`SupabaseClient<Database>\`: ${nuevos.join(', ')}`).toEqual([])
  })

  it('la lista de pendientes solo puede encoger', () => {
    // Si tipaste uno, bórralo de PENDIENTES y esta prueba te lo recuerda.
    const yaTipados = [...PENDIENTES].filter(f => !sinTipar.includes(f))
    expect(yaTipados, `ya están tipados, quítalos de PENDIENTES: ${yaTipados.join(', ')}`)
      .toEqual([])
  })

  it('y hay al menos unos cuantos ya conectados de verdad', () => {
    const tipados = archivos.filter((f) => {
      const t = readFileSync(`${repos}/${f}`, 'utf8')
      return t.includes('SupabaseClient<Database>')
    })
    expect(tipados.length).toBeGreaterThanOrEqual(6)
  })
})
