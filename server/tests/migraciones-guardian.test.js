import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// GUARDIÁN DE MIGRACIONES
//
// Los demás tests de SQL revisan UNA migración que alguien se acordó de cubrir.
// Este revisa TODAS, incluidas las que aún no existen. Nació del apagón de julio
// de 2026: `record_inbound_message_usage()` llamaba a digest() de pgcrypto sin
// tener `extensions` en su search_path, el trigger reventaba en cada mensaje
// entrante y el bot estuvo cinco días mudo.
//
// Lo grave es que el SQL se aplicó "con éxito": PostgreSQL no valida el cuerpo
// de una función plpgsql al crearla, así que el fallo solo aparece al
// ejecutarse. Ningún test podía verlo, porque los tests simulan la base.
// Estas reglas leen el SQL y atrapan esa familia de errores antes de aplicarlo.

const serverDir = fileURLToPath(new URL('..', import.meta.url))

// Marcado como OBSOLETO en el propio archivo y en CLAUDE.md: conserva el
// esquema viejo solo como historial y no debe ejecutarse nunca.
const OBSOLETAS = new Set(['migration-integraciones.sql'])

const archivosSql = readdirSync(serverDir)
  .filter(name => name.endsWith('.sql') && !OBSOLETAS.has(name))
  .sort()

/** Sin comentarios: si no, el propio texto explicativo dispara falsos positivos. */
const sinComentarios = sql => sql
  .replace(/--[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // Los LITERALES tampoco son SQL ejecutable. Sin esto, una función que filtra
  // eventos DDL por su etiqueta —`command_tag in ('CREATE TABLE AS', …)`— se
  // leía como si estuviera creando una tabla llamada «as» (2026-08-02).
  .replace(/'[^']*'/g, "''")

const leer = name => sinComentarios(readFileSync(`${serverDir}/${name}`, 'utf8'))

const FUNCIONES_PGCRYPTO = /\b(digest|crypt|hmac|gen_random_bytes|gen_salt|pgp_sym_\w+)\s*\(/i

/**
 * Funciones que usan pgcrypto pero declaran un search_path que no incluye
 * `extensions`, el esquema donde Supabase instala esa extensión.
 */
export function funcionesConPgcryptoInalcanzable(sql) {
  const fallos = []
  const bloques = sql.split(/create\s+or\s+replace\s+function/i).slice(1)
  for (const bloque of bloques) {
    const nombre = (bloque.match(/^\s*(?:public\.)?([a-z_]+)/i) || [])[1] || 'desconocida'
    const finCuerpo = bloque.indexOf('$$;')
    const cuerpo = finCuerpo === -1 ? bloque : bloque.slice(0, finCuerpo)
    const searchPath = cuerpo.match(/set\s+search_path\s*=\s*([^\n;]+)/i)
    if (!searchPath) continue
    if (/extensions/i.test(searchPath[1])) continue
    if (FUNCIONES_PGCRYPTO.test(cuerpo)) fallos.push(nombre)
  }
  return fallos
}

/** Tablas creadas en el archivo que no habilitan RLS en ese mismo archivo. */
export function tablasSinRls(sql) {
  const fallos = []
  for (const match of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)/gi,
  )) {
    const tabla = match[1].toLowerCase()
    const activa = new RegExp(
      `alter\\s+table\\s+(?:public\\.)?${tabla}\\s+enable\\s+row\\s+level\\s+security`,
      'i',
    )
    if (!activa.test(sql)) fallos.push(tabla)
  }
  return fallos
}

/** Claves foráneas a businesses que no borran en cascada. */
export function fksSinCascada(sql) {
  const fallos = []
  for (const match of sql.matchAll(
    /references\s+(?:public\.)?businesses\s*\([^)]*\)([^,;\n]*)/gi,
  )) {
    if (!/on\s+delete\s+cascade/i.test(match[1])) {
      fallos.push(match[0].replace(/\s+/g, ' ').slice(0, 60))
    }
  }
  return fallos
}

// ── Las 16 migraciones que YA llevaban su propia transacción ───────────────
//
// Están aplicadas y un `.sql` aplicado no se edita nunca: quien lo lea creería
// que la base dice lo que dice el archivo, y el ejecutor las marcaría como
// modificadas. Se indultan por eso, no porque estén bien.
//
// La lista NO puede crecer. Una migración nueva con `begin`/`commit` propio
// cierra la transacción del ejecutor antes de tiempo: el `insert` en
// `schema_migrations` queda fuera y, si fallara, el `rollback` no desharía el
// DDL. Resultado: esquema cambiado sin constancia, que es el peor estado en el
// que se puede quedar una migración. Pasó el 2026-08-13.
const CON_TRANSACCION_PROPIA = new Set([
  'migration-agrupado-webhooks.sql',
  'migration-atomicidad-reservas.sql',
  'migration-catalogo-tienda.sql',
  'migration-clientes-tienda.sql',
  'migration-consumo-planes.sql',
  'migration-eliminar-kapso-retell.sql',
  'migration-facturacion-planes.sql',
  'migration-firmas-webhooks.sql',
  'migration-hospedaje.sql',
  'migration-identificadores-canales.sql',
  'migration-inbox-webhooks.sql',
  'migration-integridad-tenants.sql',
  'migration-modificadores-menu.sql',
  'migration-pedidos-tienda.sql',
  'migration-preparacion-produccion.sql',
  'migration-registro-errores.sql',
  // `schema.sql` no es una migración: no lo aplica el ejecutor, se aplica
  // entero contra una base vacía en el CI. Su transacción es suya.
  'schema.sql',
])

describe('guardián de migraciones SQL', () => {
  describe('la transacción la pone el ejecutor, no el archivo', () => {
    const nuevas = archivosSql.filter(name => !CON_TRANSACCION_PROPIA.has(name))

    it('hay migraciones nuevas que vigilar (si no, esto no probaría nada)', () => {
      expect(nuevas.length).toBeGreaterThan(20)
    })

    it.each(nuevas)('%s no abre su propia transacción', (name) => {
      const sinComentarios = leer(name)
        .split('\n')
        .filter(linea => !linea.trimStart().startsWith('--'))
        .join('\n')
      expect(
        /^\s*(begin|commit)\s*;/im.test(sinComentarios),
        `${name} abre su propia transacción: el ejecutor ya abre una y el registro quedaría fuera`,
      ).toBe(false)
    })
  })

  it('encuentra archivos que revisar', () => {
    expect(archivosSql.length).toBeGreaterThan(20)
    expect(archivosSql).toContain('schema.sql')
  })

  // ── La regla que habría evitado el apagón de julio de 2026 ────────────────
  describe('pgcrypto alcanzable desde el search_path', () => {
    it.each(archivosSql)('%s no deja digest() fuera de alcance', name => {
      expect(funcionesConPgcryptoInalcanzable(leer(name))).toEqual([])
    })

    // Verifica que el detector detecta: sin esto, la regla podría estar rota y
    // pasar en verde para siempre.
    it('detecta el fallo real que tumbó el canal cinco días', () => {
      const sqlDefectuoso = `
        create or replace function public.record_inbound_message_usage()
        returns trigger
        language plpgsql
        security definer
        set search_path = public, pg_temp
        as $$
        begin
          v_hash := encode(digest(new.message_id_hash, 'sha256'), 'hex');
          return new;
        end;
        $$;
      `
      expect(funcionesConPgcryptoInalcanzable(sqlDefectuoso))
        .toEqual(['record_inbound_message_usage'])
    })

    it('acepta la versión corregida', () => {
      const sqlCorregido = `
        create or replace function public.record_inbound_message_usage()
        returns trigger
        language plpgsql
        security definer
        set search_path = public, extensions, pg_temp
        as $$
        begin
          v_hash := encode(digest(new.message_id_hash, 'sha256'), 'hex');
          return new;
        end;
        $$;
      `
      expect(funcionesConPgcryptoInalcanzable(sqlCorregido)).toEqual([])
    })
  })

  // ── Aislamiento multi-tenant ──────────────────────────────────────────────
  describe('toda tabla nueva nace protegida', () => {
    it.each(archivosSql)('%s habilita RLS en cada tabla que crea', name => {
      expect(tablasSinRls(leer(name))).toEqual([])
    })

    it('detecta una tabla creada sin RLS', () => {
      expect(tablasSinRls('create table if not exists public.pedidos (id uuid);'))
        .toEqual(['pedidos'])
    })
  })

  describe('sin políticas que anulen el aislamiento', () => {
    it.each(archivosSql)('%s no usa using (true)', name => {
      expect(leer(name)).not.toMatch(/using\s*\(\s*true\s*\)/i)
    })
  })

  describe('borrar un negocio se lleva sus datos', () => {
    it.each(archivosSql)('%s referencia businesses con on delete cascade', name => {
      expect(fksSinCascada(leer(name))).toEqual([])
    })
  })

  // ── Se aplican a mano en Supabase: repetirlas no puede romper nada ────────
  describe('migraciones idempotentes', () => {
    it.each(archivosSql)('%s crea tablas e índices con if not exists', name => {
      const sql = leer(name)
      expect(sql).not.toMatch(/create\s+table\s+(?!if\s+not\s+exists)(?:public\.)?[a-z_]/i)
      expect(sql).not.toMatch(
        /create\s+(?:unique\s+)?index\s+(?!if\s+not\s+exists|concurrently)[a-z_]/i,
      )
    })
  })
})
