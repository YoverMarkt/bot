import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-whatsapp-flows-capacidades.sql`,
  'utf8',
)

function functionBlock(name) {
  const start = migration.indexOf(`create or replace function public.${name}`)
  expect(start, `${name} debe existir`).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end, `${name} debe cerrar su cuerpo`).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('migración de capacidades WhatsApp Flow', () => {
  it('declara readiness verificable antes de cualquier publicación', () => {
    const readiness = functionBlock(
      'whatsapp_flow_capabilities_schema_ready',
    )
    expect(readiness).toContain(
      "to_regclass('public.business_leads') is not null",
    )
    expect(readiness).toContain(
      "to_regclass('public.whatsapp_flow_provisioning_leases') is not null",
    )
    expect(readiness).toContain("attribute.attname = 'flow_submission_id'")
    expect(readiness).toContain('attribute.attnotnull is false')
    expect(readiness).toContain("constraint_record.confdeltype = 'n'")
    expect(readiness).toContain(
      'constraint_record.confdelsetcols =',
    )
    expect(readiness).toContain(
      "'whatsapp_flow_submissions_one_resource_check'",
    )
    expect(readiness).toContain(
      "table_name = 'whatsapp_flow_submissions'",
    )
    expect(readiness).toContain(
      "'public.create_booking_from_flow_submission(uuid,uuid,text)'",
    )
    expect(readiness).toContain(
      "'public.create_lodging_request_from_flow_submission(uuid,uuid,text)'",
    )
    expect(readiness).toContain(
      "'public.create_lead_from_flow_submission(uuid,uuid,text)'",
    )
    expect(readiness).toContain(
      "'public.acquire_whatsapp_flow_provisioning_lease(uuid,text,uuid,integer)'",
    )
    expect(readiness).toContain(
      "'public.renew_whatsapp_flow_provisioning_lease(uuid,text,uuid,integer)'",
    )
    expect(readiness).toContain(
      "'public.release_whatsapp_flow_provisioning_lease(uuid,text,uuid)'",
    )
  })

  it('implementa lease durable con expiración y liberación por owner token', () => {
    expect(migration).toContain(
      'create table if not exists public.whatsapp_flow_provisioning_leases',
    )
    expect(migration).toContain(
      'primary key (business_id, template_key)',
    )
    expect(migration).toContain('lease_expires_at  timestamptz not null')

    const acquire = functionBlock(
      'acquire_whatsapp_flow_provisioning_lease',
    )
    expect(acquire).toContain(
      'on conflict (business_id, template_key) do update',
    )
    expect(acquire).toContain('lease.lease_expires_at <= now()')
    expect(acquire).toContain(
      'lease.owner_token = excluded.owner_token',
    )
    expect(acquire).toContain(
      'now() + make_interval(secs => p_lease_seconds)',
    )

    const renew = functionBlock(
      'renew_whatsapp_flow_provisioning_lease',
    )
    expect(renew).toContain('owner_token = p_owner_token')
    expect(renew).toContain('lease_expires_at > now()')
    expect(renew).toContain(
      'lease_expires_at = now() + make_interval(secs => p_lease_seconds)',
    )

    const release = functionBlock(
      'release_whatsapp_flow_provisioning_lease',
    )
    expect(release).toContain('owner_token = p_owner_token')
    expect(release).toContain('return v_deleted = 1')
  })

  it('es aditiva, transaccional y enlaza un solo recurso por submission', () => {
    expect(migration).toContain('begin;')
    expect(migration).toContain('commit;')
    expect(migration).toContain('add column if not exists booking_id uuid')
    expect(migration).toContain(
      'add column if not exists lodging_request_id uuid',
    )
    expect(migration).toContain('add column if not exists lead_id uuid')
    expect(migration).toContain('idx_flow_submissions_booking_fk')
    expect(migration).toContain('idx_flow_submissions_lodging_fk')
    expect(migration).toContain('idx_flow_submissions_lead_fk')
    expect(migration).toContain(
      'num_nonnulls(order_id, booking_id, lodging_request_id, lead_id) <= 1',
    )
    expect(migration).toContain(
      'drop constraint whatsapp_flow_submissions_one_resource_check',
    )
    expect(migration).toContain(
      'pg_get_constraintdef(oid) not like',
    )
  })

  it('calcula horarios en Ecuador con duración y solapes reales', () => {
    const availability = functionBlock(
      'get_whatsapp_flow_booking_availability',
    )
    expect(availability).toContain("'America/Guayaquil'")
    expect(availability).toContain('product.duration_minutes')
    expect(availability).toContain("booking.status in ('pending', 'confirmed')")
    expect(availability).toContain('make_interval(mins => candidate.service_duration)')
  })

  it('crea citas idempotentes sin confiar servicio o duración del teléfono', () => {
    const createBooking = functionBlock(
      'create_booking_from_flow_submission',
    )
    expect(createBooking).toContain("v_session.context -> 'appointment_draft'")
    expect(createBooking).toContain(
      "v_service_id_text := nullif(v_session.context ->> 'service_id', '')",
    )
    expect(createBooking).toContain(
      "v_booking_date := (v_session.context ->> 'booking_date')::date",
    )
    expect(createBooking).toContain(
      "v_booking_time := (v_session.context ->> 'booking_time')::time",
    )
    expect(createBooking).not.toContain(
      "v_booking_date := (v_draft ->> 'booking_date')::date",
    )
    expect(createBooking).toContain('from public.products as product')
    expect(createBooking).toContain('product.business_id = p_business_id')
    expect(createBooking).toContain('v_duration <> v_expected_duration')
    expect(createBooking).toContain('public.create_booking_if_available(')
    expect(createBooking).toContain(
      'v_booking.duration_minutes is distinct from v_duration',
    )
    expect(createBooking).toContain(
      "when sqlstate '22023' or sqlstate '42501' then",
    )
    expect(createBooking).toContain("'result', 'slot_unavailable'")
    expect(createBooking).toContain('flow_submission_id')
    expect(createBooking).toContain('for update')
  })

  it('fija hospedaje a quote+sesión y valida el hash del contacto', () => {
    const createLodging = functionBlock(
      'create_lodging_request_from_flow_submission',
    )
    expect(createLodging).toContain("v_session.context -> 'lodging_draft'")
    expect(createLodging).toContain("'flow-session:' || v_session.id::text")
    expect(createLodging).toContain('v_session.contact_key_hash <> encode(digest')
    expect(createLodging).toContain(
      'public.create_lodging_request_if_available(',
    )
    expect(createLodging).toContain(
      "hashtextextended(p_business_id::text || ':lodging', 0)",
    )
    expect(createLodging).toContain("'result', 'lodging_unavailable'")
    expect(createLodging).toContain("'flow:' || v_submission.id::text")
  })

  it('persiste leads tenant-safe e idempotentes', () => {
    expect(migration).toContain(
      'create table if not exists public.business_leads',
    )
    expect(migration).toContain('unique (business_id, flow_submission_id)')
    expect(migration).toContain(
      'alter column flow_submission_id drop not null',
    )
    expect(migration).toContain(
      'drop constraint if exists business_leads_submission_fk',
    )
    expect(migration).toContain(
      'drop constraint if exists whatsapp_flow_submissions_lead_fk',
    )
    expect(migration).toContain('on delete set null (flow_submission_id)')
    expect(migration).toContain('on delete set null (lead_id)')
    const createLead = functionBlock('create_lead_from_flow_submission')
    expect(createLead).toContain("v_session.context -> 'lead_draft'")
    expect(createLead).toContain(
      "v_session.resolved_capability_key = 'lead'",
    )
    expect(createLead).toContain('insert into public.business_leads')
    expect(createLead).toContain("processing_status = 'processed'")
  })

  it('revoca acceso público y concede solo al backend', () => {
    for (const name of [
      'whatsapp_flow_capabilities_schema_ready',
      'acquire_whatsapp_flow_provisioning_lease',
      'renew_whatsapp_flow_provisioning_lease',
      'release_whatsapp_flow_provisioning_lease',
      'get_whatsapp_flow_booking_availability',
      'create_booking_from_flow_submission',
      'create_lodging_request_from_flow_submission',
      'create_lead_from_flow_submission',
    ]) {
      expect(migration).toContain(
        `revoke all on function public.${name}`,
      )
      expect(migration).toContain(
        `grant execute on function public.${name}`,
      )
    }
    expect(migration).toContain(
      'alter table public.business_leads enable row level security',
    )
    expect(migration).toContain(
      'alter table public.whatsapp_flow_provisioning_leases enable row level security',
    )
    expect(migration).toContain(
      'on table public.whatsapp_flow_provisioning_leases to service_role',
    )
  })
})
