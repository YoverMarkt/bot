import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const tenantTables = [
  'client_users',
  'products',
  'bot_policies',
  'conversation_history',
  'conversation_sessions',
  'conversation_tags',
  'business_schedule',
  'billing',
  'sales',
  'sale_items',
  'product_consultations',
  'ai_gaps',
  'orders',
  'order_items',
]

describe('integridad multi-tenant en la base de datos', () => {
  it('valida filas antiguas antes de hacer obligatorio business_id', () => {
    const migration = fs.readFileSync(
      new URL('../migration-integridad-tenants.sql', import.meta.url),
      'utf8',
    )

    expect(migration).toContain('begin;')
    expect(migration).toContain('where business_id is null')
    expect(migration).toContain("errcode = '23502'")
    expect(migration).toContain('commit;')

    for (const table of tenantTables) {
      expect(migration).toContain(`'${table}'`)
      expect(migration).toContain(
        `alter table public.${table} alter column business_id set not null;`,
      )
    }
  })

  it('mantiene el esquema consolidado alineado para instalaciones nuevas', () => {
    const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

    for (const table of tenantTables) {
      const start = schema.indexOf(`create table if not exists ${table} (`)
      expect(start, `No se encontró la tabla ${table}`).toBeGreaterThanOrEqual(0)

      const end = schema.indexOf('\n);', start)
      const definition = schema.slice(start, end)
      expect(definition, `${table}.business_id debe ser NOT NULL`).toMatch(
        /business_id\s+uuid not null references businesses\(id\) on delete cascade/,
      )
    }
  })
})
