import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const migration = fs.readFileSync(
  new URL('../migration-consumo-planes.sql', import.meta.url),
  'utf8',
)
const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

describe('migración de consumo por planes', () => {
  it('es aditiva, multi-tenant y conserva un libro mayor mensual', () => {
    expect(migration).toContain('add column if not exists monthly_contact_limit')
    expect(migration).toContain('add column if not exists monthly_outbound_message_limit')
    expect(migration).toContain('create table if not exists public.message_usage_events')
    expect(migration).toContain('business_id       uuid not null')
    expect(migration).toContain('references public.businesses(id) on delete cascade')
    expect(migration).toContain('unique (business_id, source_key)')
    expect(migration).not.toMatch(/\bdrop table\b/i)
    expect(migration).not.toMatch(/\btruncate\b/i)
  })

  it('deduplica entrantes físicos y no cuenta el simulador en la reconstrucción', () => {
    expect(migration).toContain('webhook_inbound_message_usage')
    expect(migration).toContain("new.payload ->> 'inboundId'")
    expect(migration).toContain('on conflict (business_id, source_key) do nothing')
    expect(migration).toContain("history.contact_phone <> 'sim_admin'")
  })

  it('calcula el mes calendario de Ecuador sin borrar contadores', () => {
    expect(migration).toContain("'America/Guayaquil'")
    expect(migration).toContain('get_admin_monthly_usage')
    expect(migration).toContain('usage.occurred_at >= period_window.starts_at')
    expect(migration).toContain('usage.occurred_at < period_window.ends_at')
    expect(migration).not.toMatch(/\bdelete\s+from\s+public\.message_usage_events/i)
  })

  it('marca las inicializaciones para que una reejecución no duplique consumo', () => {
    expect(migration).toContain('message_usage_migration_state')
    expect(migration).toContain("where key = 'limits_v1'")
    expect(migration).toContain("where key = 'conversation_history_v1'")
    expect(migration).toContain("where source_kind = 'history'")
  })

  it('mantiene el esquema consolidado compatible con bases nuevas', () => {
    expect(schema).toContain('monthly_contact_limit')
    expect(schema).toContain('monthly_outbound_message_limit')
    expect(schema).toContain('public.message_usage_events')
    expect(schema).toContain('public.get_admin_monthly_usage')
    expect(schema.indexOf('create table if not exists public.message_usage_events'))
      .toBeLessThan(schema.indexOf('create trigger webhook_inbound_message_usage'))
    expect(schema.indexOf('create table if not exists webhook_inbound_events'))
      .toBeLessThan(schema.indexOf('create trigger webhook_inbound_message_usage'))
  })
})
