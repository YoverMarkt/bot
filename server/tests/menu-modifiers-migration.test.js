import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-modificadores-menu.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')

describe('migración de modificadores de menú', () => {
  it('es transaccional, multi-tenant e idempotente', () => {
    expect(migration).toContain('begin;')
    expect(migration.trim().endsWith('commit;')).toBe(true)
    expect(migration).toContain('create table if not exists public.menu_modifiers')
    expect(migration).toContain(
      'business_id   uuid not null references public.businesses(id) on delete cascade',
    )
    expect(migration).toContain('create index if not exists idx_menu_modifiers_business_tag')
    expect(migration).toContain(
      'create unique index if not exists uq_menu_modifiers_business_tag_name',
    )
  })

  it('cierra RLS y concede CRUD únicamente al service role', () => {
    expect(migration).toContain(
      'alter table public.menu_modifiers enable row level security',
    )
    expect(migration).toContain(
      'revoke all on table public.menu_modifiers\n'
      + '  from public, anon, authenticated, service_role;',
    )
    expect(migration).toContain(
      'grant select, insert, update, delete on table public.menu_modifiers\n'
      + '  to service_role;',
    )
    expect(migration).not.toMatch(/grant\s+.+\s+to\s+(anon|authenticated)\b/i)
  })

  it('mantiene schema.sql en paridad de RLS y permisos', () => {
    expect(schema).toContain('alter table menu_modifiers        enable row level security')
    expect(schema).toContain(
      'revoke all on table menu_modifiers\n'
      + '  from public, anon, authenticated, service_role;',
    )
    expect(schema).toContain(
      'grant select, insert, update, delete on table menu_modifiers\n'
      + '  to service_role;',
    )
  })

  it('documenta el orden canónico y las advertencias de upgrade', () => {
    for (const relativePath of [
      'README.md',
      'PASOS-INSTALACION.md',
      'DEPLOY.md',
    ]) {
      const source = readFileSync(`${projectDir}/${relativePath}`, 'utf8')
      const mode = source.indexOf('migration-modo-menu.sql')
      const modifiers = source.indexOf('migration-modificadores-menu.sql')
      const cleanup = source.indexOf('migration-eliminar-kapso-retell.sql')
      const identifiers = source.indexOf('migration-identificadores-canales.sql')
      const signatures = source.indexOf('migration-firmas-webhooks.sql')
      const inbox = source.indexOf('migration-inbox-webhooks.sql')

      expect(mode, `${relativePath}: modo menú`).toBeGreaterThanOrEqual(0)
      expect(modifiers, `${relativePath}: modificadores`).toBeGreaterThan(mode)
      expect(cleanup, `${relativePath}: limpieza`).toBeGreaterThan(modifiers)
      expect(identifiers, `${relativePath}: identificadores`).toBeGreaterThan(cleanup)
      expect(signatures, `${relativePath}: firmas`).toBeGreaterThan(identifiers)
      expect(inbox, `${relativePath}: inbox`).toBeGreaterThan(signatures)

      expect(source.toLowerCase()).toContain('schema.sql')
      expect(source.toLowerCase()).toContain('upgrade')
      expect(source.toLowerCase()).toMatch(/no (?:la )?reejecut/)
    }
  })
})
