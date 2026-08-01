import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(`${serverDir}/migration-inbox-webhooks.sql`, 'utf8')
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')

function functionBlock(source, name) {
  const start = source.indexOf(`create or replace function public.${name}`)
  expect(start, `${name} debe existir`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('$$;', start)
  expect(end, `${name} debe cerrar su cuerpo SQL`).toBeGreaterThan(start)
  return source.slice(start, end + 3)
}

describe('migración del inbox durable de webhooks', () => {
  it('es aditiva, transaccional y clasifica filas históricas como completadas', () => {
    expect(migration).toContain('Ejecutar DESPUES de migration-firmas-webhooks.sql')
    expect(migration).toContain('begin;')
    expect(migration).toContain('commit;')
    expect(migration).toContain('add column if not exists payload jsonb')
    expect(migration).toContain("add column if not exists status text not null default 'completed'")
    expect(migration).toMatch(
      /where status = 'completed'\s+and payload is null\s+and completed_at is null/,
    )
    expect(migration).toContain("status in ('pending', 'processing', 'completed', 'dead')")
    expect(migration).toContain('pg_column_size(payload) <= 262144')
    expect(migration).toContain("stream_key_hash ~ '^[0-9a-f]{64}$'")
  })

  it('expone exactamente los seis contratos RPC del worker', () => {
    expect(migration).toMatch(
      /enqueue_webhook_event\(\s*p_business_id uuid,\s*p_provider text,\s*p_message_id_hash text,\s*p_stream_key_hash text,\s*p_payload jsonb\s*\)\s*returns boolean/s,
    )
    expect(migration).toMatch(
      /lease_webhook_events\(\s*p_worker_id text,\s*p_limit integer,\s*p_lease_seconds integer\s*\)\s*returns table \(\s*id uuid,\s*business_id uuid,\s*provider text,\s*payload jsonb,\s*lease_token uuid,\s*attempts integer/s,
    )
    expect(migration).toMatch(
      /renew_webhook_event_lease\(\s*p_event_id uuid,\s*p_lease_token uuid,\s*p_lease_seconds integer\s*\)\s*returns boolean/s,
    )
    expect(migration).toMatch(
      /complete_webhook_event\(\s*p_event_id uuid,\s*p_lease_token uuid\s*\)\s*returns boolean/s,
    )
    expect(migration).toMatch(
      /fail_webhook_event\(\s*p_event_id uuid,\s*p_lease_token uuid,\s*p_error text,\s*p_base_delay_seconds integer\s*\)\s*returns text/s,
    )
    expect(migration).toMatch(
      /cleanup_webhook_events\(\)\s*returns integer/,
    )
  })

  it('reclama con SKIP LOCKED, lease acotado y FIFO por conversación', () => {
    const lease = functionBlock(migration, 'lease_webhook_events')
    expect(lease).toContain('for update of event skip locked')
    expect(lease).toContain("earlier.status in ('pending', 'processing')")
    expect(lease).toContain('earlier.stream_key_hash = event.stream_key_hash')
    expect(lease).toContain(
      '(earlier.received_at, earlier.id) < (event.received_at, event.id)',
    )
    expect(lease).toContain('attempts = event.attempts + 1')
    expect(lease).toContain('lease_token = gen_random_uuid()')
    expect(lease).toContain('least(coalesce(p_lease_seconds, 180), 900)')
    expect(migration).toContain('uq_webhook_inbox_processing_stream')
    expect(migration).toContain("where status = 'processing'")
  })

  it('usa fencing token en heartbeat, finalización y fallo', () => {
    for (const name of [
      'renew_webhook_event_lease',
      'complete_webhook_event',
      'fail_webhook_event',
    ]) {
      expect(functionBlock(migration, name)).toContain(
        'event.lease_token = p_lease_token',
      )
    }

    const complete = functionBlock(migration, 'complete_webhook_event')
    expect(complete).toContain("status = 'completed'")
    expect(complete).toContain('payload = null')

    const fail = functionBlock(migration, 'fail_webhook_event')
    expect(fail).toContain("return 'stale'")
    expect(fail).toContain("return 'dead'")
    expect(fail).toContain("return 'pending'")
    expect(fail).toContain('v_delay_seconds := least(')
    expect(fail).toContain('900,')
    expect(fail).toContain('power(2::numeric')
    expect(fail).toContain('left(')
  })

  it('limpia solo estados terminales y conserva pendientes o leases activos', () => {
    const cleanup = functionBlock(migration, 'cleanup_webhook_events')
    expect(cleanup).toContain("event.status = 'completed'")
    expect(cleanup).toContain("event.status = 'dead'")
    expect(cleanup).toContain("interval '24 hours'")
    expect(cleanup).toContain("interval '7 days'")
    expect(cleanup).not.toContain("event.status = 'pending'")
    expect(cleanup).not.toContain("event.status = 'processing'")
  })

  it('mantiene claim_webhook_event compatible sin crear jobs pendientes', () => {
    const legacy = functionBlock(migration, 'claim_webhook_event')
    expect(legacy).toContain("and status = 'completed'")
    expect(legacy).toContain("p_message_id_hash,\n    'completed',")
    expect(legacy).not.toContain("'pending'")
    expect(migration).toContain(
      'on conflict (business_id, provider, message_id_hash) do nothing',
    )
  })

  it('protege tabla y RPC para uso exclusivo de service_role', () => {
    expect(migration).toContain('alter table public.webhook_inbound_events enable row level security')
    expect(migration).toContain(
      'revoke all on table public.webhook_inbound_events\n  from public, anon, authenticated',
    )
    for (const signature of [
      'enqueue_webhook_event(uuid, text, text, text, jsonb)',
      'lease_webhook_events(text, integer, integer)',
      'renew_webhook_event_lease(uuid, uuid, integer)',
      'complete_webhook_event(uuid, uuid)',
      'fail_webhook_event(uuid, uuid, text, integer)',
      'cleanup_webhook_events()',
    ]) {
      expect(migration).toContain(`grant execute on function public.${signature}`)
    }
    expect(migration).not.toContain('security definer')
  })

  it('mantiene schema.sql en paridad con la migración incremental', () => {
    for (const fragment of [
      'payload_version smallint not null default 1',
      "status            text not null default 'completed'",
      'uq_webhook_inbox_processing_stream',
      'create or replace function public.enqueue_webhook_event',
      'create or replace function public.lease_webhook_events',
      'create or replace function public.renew_webhook_event_lease',
      'create or replace function public.complete_webhook_event',
      'create or replace function public.fail_webhook_event',
      'create or replace function public.cleanup_webhook_events',
    ]) {
      expect(schema).toContain(fragment)
    }
  })

  it('documenta firmas antes del inbox en instalación y despliegue', () => {
    for (const relativePath of [
      'README.md',
      'PASOS-INSTALACION.md',
      'DEPLOY.md',
      'CLAUDE.md',
    ]) {
      const source = readFileSync(`${projectDir}/${relativePath}`, 'utf8')
      const signatures = source.indexOf('migration-firmas-webhooks.sql')
      const inbox = source.indexOf('migration-inbox-webhooks.sql')
      expect(signatures, `${relativePath} menciona firmas`).toBeGreaterThanOrEqual(0)
      expect(inbox, `${relativePath} menciona inbox`).toBeGreaterThan(signatures)
    }
  })
})
