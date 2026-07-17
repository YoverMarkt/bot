import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-deduplicacion-webhooks.sql`,
  'utf8',
)
const webhookRepository = readFileSync(
  `${serverDir}/src/db/repositories/webhook-events.ts`,
  'utf8',
)

describe('deduplicación persistente de webhooks', () => {
  it('aísla los reclamos por negocio y proveedor con unicidad atómica', () => {
    expect(migration).toMatch(
      /business_id\s+uuid not null references businesses\(id\) on delete cascade/,
    )
    expect(migration).toContain(
      'on public.webhook_inbound_events(business_id, provider, message_id_hash)',
    )
    expect(migration).toContain(
      'on conflict (business_id, provider, message_id_hash) do nothing',
    )
    expect(migration).toContain('alter table public.webhook_inbound_events enable row level security')
  })

  it('guarda únicamente SHA-256 y elimina reclamos vencidos', () => {
    expect(webhookRepository).toContain("createHash('sha256')")
    expect(webhookRepository).toContain("db.rpc('claim_webhook_event'")
    expect(migration).toContain("message_id_hash ~ '^[0-9a-f]{64}$'")
    expect(migration).toMatch(
      /delete from public\.webhook_inbound_events\s+where business_id = p_business_id/,
    )
    expect(migration).toContain("received_at < now() - interval '24 hours'")
    expect(migration).not.toMatch(/\b(payload|phone|message_text|content)\s+text\b/)
  })

  it('permite reclamar eventos solamente al backend service_role', () => {
    expect(migration).toContain('from anon;')
    expect(migration).toContain('from authenticated;')
    expect(migration).toContain('to service_role;')
    expect(migration).not.toContain('security definer')
  })
})
