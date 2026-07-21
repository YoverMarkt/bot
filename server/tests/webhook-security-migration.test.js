import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(`${serverDir}/migration-firmas-webhooks.sql`, 'utf8')
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')

describe('migración de firmas de webhooks', () => {
  it('es transaccional y conserva el onboarding atómico', () => {
    expect(migration).toContain('begin;')
    expect(migration).toContain('commit;')
    expect(migration).toContain('lock table public.businesses')
    expect(migration).toContain('create or replace function public.create_business_onboarding')
    expect(migration).toContain('ycloud_webhook_endpoint_id')
    expect(migration).toContain('ycloud_webhook_secret')
    expect(migration).toContain('drop column if exists meta_verify_token')
  })

  it('mantiene el esquema consolidado en paridad', () => {
    expect(schema).toContain('businesses_ycloud_webhook_endpoint_id_check')
    expect(schema).toContain('ycloud_webhook_endpoint_id')
    expect(schema).toContain('ycloud_webhook_secret')
    expect(schema).not.toMatch(/^\s*meta_verify_token\s+text/m)
  })
})
