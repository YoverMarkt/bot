import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-agrupado-webhooks.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')

function functionBlock(source, name) {
  const start = source.indexOf(`create or replace function public.${name}`)
  expect(start, `${name} debe existir`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('$$;', start)
  expect(end, `${name} debe cerrar su cuerpo SQL`).toBeGreaterThan(start)
  return source.slice(start, end + 3)
}

describe('migración del agrupado durable de mensajes rápidos', () => {
  it('es posterior al inbox y conserva los contratos RPC del rolling deploy', () => {
    expect(migration).toContain(
      'Ejecutar DESPUES de migration-inbox-webhooks.sql',
    )
    expect(migration).toContain('begin;')
    expect(migration).toContain('commit;')
    expect(migration).toMatch(
      /enqueue_webhook_event\(\s*p_business_id uuid,\s*p_provider text,\s*p_message_id_hash text,\s*p_stream_key_hash text,\s*p_payload jsonb\s*\)\s*returns boolean/s,
    )
    expect(migration).toMatch(
      /lease_webhook_events\(\s*p_worker_id text,\s*p_limit integer,\s*p_lease_seconds integer\s*\)\s*returns table \(\s*id uuid,\s*business_id uuid,\s*provider text,\s*payload jsonb,\s*lease_token uuid,\s*attempts integer/s,
    )
    expect(migration).toMatch(
      /complete_webhook_event\(\s*p_event_id uuid,\s*p_lease_token uuid\s*\)\s*returns boolean/s,
    )
    expect(migration).not.toContain('lease_webhook_event_batches')
    expect(migration).not.toContain('complete_webhook_event_batch')
  })

  it('abre tres segundos de silencio solo después de insertar texto nuevo', () => {
    const enqueue = functionBlock(migration, 'enqueue_webhook_event')
    const lock = enqueue.indexOf('pg_advisory_xact_lock')
    const receivedAt = enqueue.indexOf('v_received_at := clock_timestamp()')
    const quietWindow = enqueue.indexOf(
      "v_quiet_until := v_received_at + interval '3 seconds'",
    )
    const conflict = enqueue.indexOf(
      'on conflict (business_id, provider, message_id_hash) do nothing',
    )
    const duplicateReturn = enqueue.indexOf('if not found then')
    const suffixUpdate = enqueue.indexOf(
      'set available_at = greatest(queued.available_at, v_quiet_until)',
    )

    expect(lock).toBeGreaterThanOrEqual(0)
    expect(receivedAt).toBeGreaterThan(lock)
    expect(quietWindow).toBeGreaterThan(receivedAt)
    expect(enqueue).toContain('received_at,\n    updated_at')
    expect(conflict).toBeGreaterThan(quietWindow)
    expect(duplicateReturn).toBeGreaterThan(conflict)
    expect(suffixUpdate).toBeGreaterThan(duplicateReturn)
    expect(enqueue).toContain("queued.status = 'pending'")
    expect(enqueue).toContain(
      "boundary.payload #>> '{content,kind}' is distinct from 'text'",
    )
    expect(enqueue).toContain("or boundary.payload ? '_inboxBatch'")
    expect(enqueue).toContain("or p_payload ? '_inboxBatch'")
  })

  it('congela un prefijo textual FIFO de hasta 20 eventos y 16.384 caracteres', () => {
    const lease = functionBlock(migration, 'lease_webhook_events')
    expect(lease).toContain('for update of event skip locked')
    expect(lease).toContain("earlier.status in ('pending', 'processing')")
    expect(lease).toContain(
      '(earlier.received_at, earlier.id)\n            < (event.received_at, event.id)',
    )
    expect(lease).toContain('batch_position <= 20')
    expect(lease).toContain('combined_length <= 16384')
    expect(lease).toContain(
      "char_length(member.payload #>> '{content,text}')",
    )
    expect(lease).toContain("string_agg(")
    expect(lease).toContain("E'\\n'")
    expect(lease).toContain("bounded.payload ->> 'inboundId'")
    expect(lease).toContain("'eventIds', to_jsonb(v_batch_ids)")
    expect(lease).toContain("'version', 1")
    expect(lease).toContain(
      "v_batch_ids := array[v_head.id]",
    )
  })

  it('reutiliza el snapshot en retries y deja fuera llegadas posteriores', () => {
    const lease = functionBlock(migration, 'lease_webhook_events')
    const frozenCheck = lease.indexOf(
      "v_head.payload #>> '{_inboxBatch,version}'",
    )
    const aggregation = lease.indexOf('with eligible as (')
    expect(frozenCheck).toBeGreaterThanOrEqual(0)
    expect(aggregation).toBeGreaterThan(frozenCheck)
    expect(lease).toContain('if not v_frozen')
    expect(lease).toContain('v_payload := v_head.payload;')
    expect(lease).toContain(
      '(member.received_at, member.id)\n            >= (v_head.received_at, v_head.id)',
    )
    expect(lease).toContain('member.available_at <= now()')
    expect(lease).toContain("or boundary.payload ? '_inboxBatch'")
  })

  it('terminaliza todo el snapshot al vencer el último lease', () => {
    const lease = functionBlock(migration, 'lease_webhook_events')
    const terminal = lease.slice(
      lease.indexOf('for v_terminal_head in'),
      lease.indexOf(
        "update public.webhook_inbound_events as event\n  set status = 'pending'",
      ),
    )
    expect(terminal).toContain("event.status = 'processing'")
    expect(terminal).toContain('event.leased_until <= now()')
    expect(terminal).toContain('event.attempts >= event.max_attempts')
    expect(terminal).toContain('for update of event skip locked')
    expect(terminal).toContain('limit 100')
    expect(terminal).toContain(
      "v_terminal_head.payload #> '{_inboxBatch,eventIds}'",
    )
    expect(terminal).toContain('where event.id = any(v_terminal_ids)')
    expect(terminal).toContain("set status = 'dead'")
    expect(terminal).toContain(
      'v_terminal_updated <> cardinality(v_terminal_ids)',
    )
    expect(terminal).toContain(
      "v_terminal_member.status is distinct from 'pending'",
    )
  })

  it('completa el snapshot atómicamente con fencing y validación cerrada', () => {
    const complete = functionBlock(migration, 'complete_webhook_event')
    expect(complete).toContain('event.lease_token = p_lease_token')
    expect(complete).toContain('for update;')
    expect(complete).toContain(
      "jsonb_typeof(v_batch -> 'eventIds') is distinct from 'array'",
    )
    expect(complete).toContain(
      "jsonb_array_length(v_batch -> 'eventIds') not between 1 and 20",
    )
    expect(complete).toContain(
      'from jsonb_array_elements(v_batch -> \'eventIds\')',
    )
    expect(complete).toContain(
      'if v_batch_ids[1] is distinct from p_event_id',
    )
    expect(complete).toContain(
      'if v_distinct_count <> cardinality(v_batch_ids)',
    )
    expect(complete).toContain('where event.id = any(v_batch_ids)')
    expect(complete).toContain(
      'v_member.stream_key_hash is distinct from v_head.stream_key_hash',
    )
    expect(complete).toContain(
      'if v_locked_ids is distinct from v_batch_ids',
    )
    expect(complete).toContain("set status = 'completed'")
    expect(complete).toContain('payload = null')
    expect(complete).toContain(
      'if v_completed <> cardinality(v_batch_ids)',
    )
  })

  it('mantiene el ACK unitario para un lease antiguo sin metadata', () => {
    const complete = functionBlock(migration, 'complete_webhook_event')
    const compatibility = complete.slice(
      complete.indexOf('if v_batch is null then'),
      complete.indexOf('end if;', complete.indexOf('if v_batch is null then')) + 7,
    )
    expect(compatibility).toContain('where event.id = p_event_id')
    expect(compatibility).toContain('event.lease_token = p_lease_token')
    expect(compatibility).toContain('return v_completed = 1')
    expect(compatibility).not.toContain('any(v_batch_ids)')
  })

  it('conserva miembros en retries normales y mata el lote al agotarlos', () => {
    const fail = functionBlock(migration, 'fail_webhook_event')
    const deadBranch = fail.slice(
      fail.indexOf('if v_head.attempts >= v_head.max_attempts then'),
      fail.indexOf("return 'dead';"),
    )
    const retryBranch = fail.slice(
      fail.indexOf("return 'dead';"),
      fail.indexOf("return 'pending';"),
    )

    expect(deadBranch).toContain(
      "v_head.payload #> '{_inboxBatch,eventIds}'",
    )
    expect(deadBranch).toContain('where event.id = any(v_batch_ids)')
    expect(deadBranch).toContain("set status = 'dead'")
    expect(deadBranch).toContain('event.lease_token = p_lease_token')
    expect(deadBranch).toContain(
      'v_updated <> cardinality(v_batch_ids)',
    )
    expect(retryBranch).toContain('where event.id = p_event_id')
    expect(retryBranch).toContain("set status = 'pending'")
    expect(retryBranch).not.toContain('any(v_batch_ids)')
  })

  it('mantiene schema y documentación en el mismo orden de despliegue', () => {
    for (const fragment of [
      "v_quiet_until := v_received_at + interval '3 seconds'",
      "'_inboxBatch'",
      'batch_position <= 20',
      'combined_length <= 16384',
      'where event.id = any(v_batch_ids)',
      'for v_terminal_head in',
      'if v_head.attempts >= v_head.max_attempts then',
    ]) {
      expect(schema).toContain(fragment)
    }

    for (const relativePath of [
      'README.md',
      'PASOS-INSTALACION.md',
      'DEPLOY.md',
      'CLAUDE.md',
    ]) {
      const source = readFileSync(`${projectDir}/${relativePath}`, 'utf8')
      const inbox = source.indexOf('migration-inbox-webhooks.sql')
      const batching = source.indexOf('migration-agrupado-webhooks.sql')
      expect(inbox, `${relativePath} menciona inbox`).toBeGreaterThanOrEqual(0)
      expect(batching, `${relativePath} menciona agrupado`).toBeGreaterThan(inbox)
    }
  })
})
