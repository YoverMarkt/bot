import { describe, expect, it } from 'vitest'
import { huellaDelEsquema } from './staging.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// PONER EL STAGING AL DÍA
// ═══════════════════════════════════════════════════════════════════════════
//
// `npm run staging:actualizar` existe porque «tengo el staging levantado» NO
// significa «el staging tiene lo último»: hay que traer el código, reconstruir
// TAMBIÉN los paneles (el build del servidor no los toca) y reiniciar.
//
// Lo que se prueba aquí es la única rama del comando que no se puede ver a
// mano sin romper la base: el aviso de que lo que acabas de traer cambia el
// esquema. Sin ese aviso, el staging arranca con la base de ayer y la
// aplicación falla con errores de columna que parecen bugs de la app.

const MIGRACIONES = ['migration-a.sql', 'migration-b.sql']

describe('la huella del esquema', () => {
  it('no cambia si no cambió nada', () => {
    expect(huellaDelEsquema('create table x;', MIGRACIONES))
      .toBe(huellaDelEsquema('create table x;', MIGRACIONES))
  })

  it('cambia si cambia el consolidado', () => {
    // Una columna nueva en `schema.sql` sin resetear la base = errores raros.
    expect(huellaDelEsquema('create table x;', MIGRACIONES))
      .not.toBe(huellaDelEsquema('create table x; alter table x add y int;', MIGRACIONES))
  })

  it('cambia si llega una migración nueva', () => {
    expect(huellaDelEsquema('create table x;', MIGRACIONES))
      .not.toBe(huellaDelEsquema('create table x;', [...MIGRACIONES, 'migration-c.sql']))
  })

  it('NO depende del orden en que el disco liste los archivos', () => {
    // `readdirSync` no garantiza orden entre sistemas. Sin ordenar, la huella
    // cambiaría sola y el comando pediría resetear la base sin motivo — un
    // aviso que se equivoca se deja de leer.
    expect(huellaDelEsquema('create table x;', ['b.sql', 'a.sql']))
      .toBe(huellaDelEsquema('create table x;', ['a.sql', 'b.sql']))
  })

  it('distingue dos migraciones de una con el nombre pegado', () => {
    expect(huellaDelEsquema('x', ['ab.sql']))
      .not.toBe(huellaDelEsquema('x', ['a.sql', 'b.sql']))
  })
})
