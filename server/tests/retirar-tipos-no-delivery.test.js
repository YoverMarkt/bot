import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// FASE 5 — LA MIGRACIÓN Y EL SEED TIENEN QUE CONTAR LO MISMO
//
// El CI aplica `schema.sql` sobre una base VACÍA; producción recibe la
// migración sobre una base que ya tiene las cinco familias. Si los dos no
// dejan la base en el mismo estado, el CI sale verde sobre una ficción y la
// diferencia solo aparece el día que alguien mira la tabla de producción.
//
// Esto no ejecuta SQL —eso lo hace `verificar-en-docker.sh`—: lee los dos
// textos y comprueba que dicen lo mismo, que es lo que ningún otro guardián
// mira.
// ═══════════════════════════════════════════════════════════════════════════

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const leer = nombre => readFileSync(`${serverDir}/${nombre}`, 'utf8')

const MIGRACION = leer('migration-2026-08-20-retirar-tipos-no-delivery.sql')
const SCHEMA = leer('schema.sql')

/** Los tipos que el seed de `schema.sql` sigue clasificando. */
const tiposDelSeed = () => {
  const inicio = SCHEMA.indexOf('insert into public.business_type_families')
  const fin = SCHEMA.indexOf('on conflict (business_type) do nothing;', inicio)
  expect(inicio, 'falta el seed de business_type_families').toBeGreaterThanOrEqual(0)
  return [...SCHEMA.slice(inicio, fin).matchAll(/\('([^']+)','([^']+)'\)/g)]
    .map(([, tipo, familia]) => ({ tipo, familia }))
}

/** Los tipos que la migración borra. */
const tiposBorrados = () => {
  const bloques = [...MIGRACION.matchAll(
    /delete from public\.business_type_families\s+where business_type (?:in \(([^)]+)\)|= '([^']+)')/g,
  )]
  expect(bloques.length, 'la migración debería borrar tipos').toBeGreaterThan(0)
  return bloques.flatMap(([, lista, suelto]) => (
    suelto ? [suelto] : [...lista.matchAll(/'([^']+)'/g)].map(([, t]) => t)
  ))
}

describe('fase 5: el desplegable queda en comida y retail', () => {
  // Sin esto, un cambio de formato en el SQL dejaría los lectores devolviendo
  // listas vacías y TODAS las comprobaciones de abajo pasarían en falso.
  it('los lectores encuentran lo que dicen encontrar', () => {
    expect(tiposDelSeed()).toHaveLength(30)
    expect(tiposBorrados()).toHaveLength(22)
    expect(tiposDelSeed().map(t => t.tipo)).toContain('pizzería')
    expect(tiposBorrados()).toContain('barbería')
    // `negocio` se borra de la clasificación pero SIGUE en el desplegable: un
    // tipo genérico no hereda el margen de una familia que nadie eligió.
    expect(tiposBorrados()).toContain('negocio')
  })

  it('el seed solo clasifica comida y retail', () => {
    const familias = [...new Set(tiposDelSeed().map(t => t.familia))].sort()
    expect(familias).toEqual(['comida', 'retail'])
  })

  it('el seed de familias deja exactamente las dos que quedan', () => {
    const inicio = SCHEMA.indexOf('insert into public.business_families')
    const fin = SCHEMA.indexOf('on conflict (code) do nothing;', inicio)
    const codigos = [...SCHEMA.slice(inicio, fin).matchAll(/\('([a-z_]+)',/g)].map(([, c]) => c)
    expect(codigos.sort()).toEqual(['comida', 'retail'])
  })

  it('la migración borra las tres familias que el seed ya no siembra', () => {
    const borradas = MIGRACION.match(
      /delete from public\.business_families\s+where code in \(([^)]+)\)/,
    )
    expect(borradas, 'la migración debería borrar familias').not.toBeNull()
    const codigos = [...borradas[1].matchAll(/'([a-z_]+)'/g)].map(([, c]) => c)
    expect(codigos.sort()).toEqual(['hospedaje', 'salud_belleza', 'servicios'])
  })

  it('ningún tipo se borra y se siembra a la vez', () => {
    const sembrados = new Set(tiposDelSeed().map(t => t.tipo))
    const contradictorios = tiposBorrados().filter(tipo => sembrados.has(tipo))
    expect(
      contradictorios,
      'Estos tipos los borra la migración y los siembra schema.sql: producción y\n'
      + `el CI acabarían con tablas distintas:\n  · ${contradictorios.join('\n  · ')}`,
    ).toEqual([])
  })

  it('borra los mapeos ANTES que las familias, o el on delete restrict lo rechaza', () => {
    // `business_type_families.family_code references business_families(code)
    // on delete restrict`. Al revés, PostgreSQL aborta la migración entera.
    const ultimoMapeo = MIGRACION.lastIndexOf('delete from public.business_type_families')
    const familias = MIGRACION.indexOf('delete from public.business_families')
    expect(ultimoMapeo).toBeGreaterThanOrEqual(0)
    expect(familias).toBeGreaterThan(ultimoMapeo)
  })

  it('archiva las reglas de margen que apuntaban a lo retirado, sin borrarlas', () => {
    // Borrarlas rompería `orders.pricing_rule_id`: un pedido que congeló su
    // regla necesita esa fila para explicar lo que ya se cobró.
    expect(MIGRACION).toMatch(/update public\.pricing_rules\s+set status = 'archived'/)
    expect(MIGRACION).not.toMatch(/delete from public\.pricing_rules/)
  })

  it('no recrea ninguna función: esto son borrados de catálogo, no del dinero', () => {
    expect(MIGRACION).not.toMatch(/create or replace function/i)
    expect(MIGRACION).not.toMatch(/create_storefront_order|set_order_status/)
  })

  it('no toca ningún negocio: `businesses.type` es texto libre y se respeta', () => {
    // Un negocio de un tipo retirado sigue existiendo y vendiendo; solo deja de
    // heredar familia y cae a la regla global.
    expect(MIGRACION).not.toMatch(/(update|delete)\s+(from\s+)?public\.businesses/i)
  })
})
