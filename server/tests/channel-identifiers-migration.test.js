import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-identificadores-canales.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const cleanupName = readdirSync(serverDir).find(name => (
  name.startsWith('migration-eliminar-') && name.endsWith('.sql')
))
const cleanup = cleanupName
  ? readFileSync(`${serverDir}/${cleanupName}`, 'utf8')
  : ''

describe('migración de identificadores de canal', () => {
  it('exige una limpieza transaccional previa sin convertir proveedores', () => {
    expect(cleanupName).toBeTruthy()
    expect(cleanup).toContain('begin;')
    expect(cleanup).toContain('commit;')
    expect(cleanup).toContain('lock table public.businesses')
    expect(cleanup).toContain("not in ('meta', 'ycloud', 'telegram')")
    expect(cleanup).toContain('v_invalid_count > 0')
    expect(cleanup).toContain('pg_get_functiondef')
    expect(cleanup).toContain('drop column if exists')
    expect(cleanup.indexOf('raise exception')).toBeLessThan(
      cleanup.indexOf('drop column if exists'),
    )
    expect(cleanup).not.toMatch(
      /update\s+public\.businesses[\s\S]{0,300}whatsapp_provider/i,
    )
  })

  it('es transaccional, aditiva y aborta colisiones entre tenants', () => {
    expect(migration.trim().startsWith('-- Resolución exacta')).toBe(true)
    expect(migration).toContain('begin;')
    expect(migration).toContain('commit;')
    expect(migration).toContain('create table if not exists')
    expect(migration).toContain('errcode = \'23505\'')
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain("identifier_type = 'phone'")
    expect(migration).toContain('business_id <> p_business_id')
    expect(migration).toContain("'business_id=%s provider=%s'")
    expect(migration).toContain("set local lock_timeout = '5s'")
    expect(migration).toContain("set local statement_timeout = '2min'")
    expect(migration).not.toMatch(/on conflict\s+do (nothing|update)/i)
    expect(migration).not.toMatch(/drop\s+(table|column)/i)
  })

  it('impone unicidad global exacta, FK, índice de tenant y RLS cerrada', () => {
    expect(migration).toContain('references public.businesses(id) on delete cascade')
    expect(migration).toContain('uq_business_channel_identifier')
    expect(migration).toContain('uq_business_channel_phone')
    expect(migration).toContain("where identifier_type = 'phone'")
    expect(migration).toMatch(
      /provider,\s*identifier_type,\s*canonical_identifier/,
    )
    expect(migration).toContain('idx_business_channel_identifiers_business')
    expect(migration).toContain(
      'alter table public.business_channel_identifiers enable row level security',
    )
    expect(migration).toContain('from public, anon, authenticated, service_role')
    expect(migration).toContain(
      'grant select on table public.business_channel_identifiers to service_role',
    )
    expect(
      migration.match(/from public, anon, authenticated, service_role;/g),
    ).toHaveLength(4)
  })

  it('sincroniza únicamente el proveedor activo Meta/YCloud', () => {
    expect(migration).toContain(
      "v_whatsapp_provider in ('meta', 'ycloud')",
    )
    expect(migration).toContain("where v_whatsapp_provider = 'ycloud'")
    expect(migration).toContain("where v_whatsapp_provider = 'meta'")
    expect(migration).toContain('v_whatsapp_provider := coalesce')
    expect(migration).toContain('YCloud requiere un teléfono de canal válido')
    expect(migration).toContain('Meta requiere un Phone ID válido')
    expect(migration).toContain('trg_sync_business_channel_identifiers')
    expect(migration).toContain('lock table public.businesses')
  })

  it('mantiene el esquema consolidado en paridad con la migración', () => {
    for (const invariant of [
      'business_channel_identifiers',
      'uq_business_channel_identifier',
      'uq_business_channel_phone',
      'normalize_business_channel_identifier',
      'refresh_business_channel_identifiers',
      'trg_sync_business_channel_identifiers',
      'lock table public.businesses in share row exclusive mode',
      "set local lock_timeout = '5s'",
      'Meta requiere un Phone ID válido',
    ]) {
      expect(schema).toContain(invariant)
    }
  })
})
