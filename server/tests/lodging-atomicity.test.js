import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(`${serverDir}/migration-hospedaje.sql`, 'utf8')
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const repository = readFileSync(
  `${serverDir}/src/db/repositories/lodging.ts`,
  'utf8',
)
const routes = readFileSync(`${serverDir}/src/routes/lodging.routes.ts`, 'utf8')
const service = readFileSync(`${serverDir}/src/services/lodging.ts`, 'utf8')
const tags = readFileSync(`${serverDir}/src/services/bot-tags.ts`, 'utf8')
const prompt = readFileSync(`${serverDir}/src/services/prompt.ts`, 'utf8')

const tables = [
  'lodging_settings',
  'lodging_room_types',
  'lodging_rate_overrides',
  'lodging_quotes',
  'lodging_requests',
  'lodging_blocks',
]

function tableDefinition(table) {
  const start = migration.indexOf(`create table if not exists public.${table}`)
  const end = migration.indexOf('\n);', start)
  expect(start, `tabla ${table}`).toBeGreaterThanOrEqual(0)
  expect(end, `fin tabla ${table}`).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('módulo transaccional de hospedaje', () => {
  it('mantiene un agregado propio, tipado y separado de citas y pedidos', () => {
    expect(migration).toContain(
      'add column if not exists lodging_enabled boolean not null default false',
    )
    for (const table of tables) {
      expect(tableDefinition(table)).toMatch(/business_id\s+uuid not null/)
    }
    expect(tableDefinition('lodging_room_types')).toContain('media_urls')
    expect(tableDefinition('lodging_room_types')).toContain(
      "'per_unit', 'per_person', 'base_plus_extra', 'manual'",
    )
    expect(tableDefinition('lodging_quotes')).toContain('rooms_count')
    expect(tableDefinition('lodging_quotes')).toContain('check_in_time')
    expect(tableDefinition('lodging_requests')).toContain(
      "'pending_owner', 'confirmed', 'rejected', 'cancelled', 'expired'",
    )
    expect(migration).not.toMatch(/'checked_in'|'checked_out'|'no_show'/)
    expect(migration).not.toMatch(/insert into public\.bookings|insert into public\.orders/)
  })

  it('aísla cada tabla por tenant y no entrega RLS al navegador', () => {
    for (const table of tables) {
      expect(migration).toContain(
        `alter table public.${table} enable row level security`,
      )
    }
    expect(migration).toContain('from public, anon, authenticated')
    expect(migration).toContain(
      'grant select, insert, update on table public.lodging_blocks to service_role',
    )
    expect(migration).not.toContain(
      'grant select, insert, update, delete on table public.lodging_blocks',
    )
    expect(repository.match(/\.eq\('business_id', businessId\)/g)?.length)
      .toBeGreaterThanOrEqual(12)
    expect(repository).toContain(".in('kind', ['manual', 'external', 'maintenance'])")
    expect(repository).toContain(".is('request_id', null)")
    expect(repository).not.toMatch(
      /\.from\('lodging_requests'\)\s*\.select\('\*'\)/,
    )
    expect(routes).toContain("auth.requirePermission('hospedaje')")
    expect(routes).toContain('user?.lodgingEnabled === true')
  })

  it('serializa inventario para impedir sobreventa en todas las noches', () => {
    expect(migration.match(/pg_advisory_xact_lock/g)?.length)
      .toBeGreaterThanOrEqual(8)
    expect(migration).toContain('create trigger trg_lodging_blocks_capacity')
    expect(migration).toContain('public.enforce_lodging_block_capacity()')
    expect(migration).toContain('generate_series(new.start_date, new.end_date - 1')
    expect(migration).toContain('sum(block.quantity)')
    expect(migration).toContain("request.status = 'pending_owner'")
    expect(migration).toContain('request.expires_at > now()')
    expect(migration).toContain("v_request.id, 'request'")
    expect(migration).toContain('create trigger trg_lodging_room_types_capacity')
    expect(migration).toContain('create trigger trg_lodging_settings_configuration_lock')
    expect(migration).toContain("time zone 'America/Guayaquil'")
    expect(migration).toContain(
      'No se puede deshabilitar hospedaje con solicitudes o estadías activas',
    )
    expect(migration).toContain("request.status = 'confirmed'")
  })

  it('recalcula y compara dinero oficial dentro de la misma transacción', () => {
    expect(migration.match(/extract\(isodow from v_stay_date\).*in \(6, 7\)/g)?.length)
      .toBeGreaterThanOrEqual(2)
    expect(migration.match(/v_effective_base \* p_adults/g)?.length)
      .toBeGreaterThanOrEqual(1)
    expect(migration).toContain('v_effective_base * v_quote.adults')
    for (const field of ['units_required', 'subtotal', 'tax', 'fees', 'total']) {
      expect(migration).toContain(`v_snapshot ->> '${field}'`)
    }
    expect(migration).toContain("'prices_include_tax', v_settings.prices_include_tax")
    expect(migration).toContain("'result', 'manual_quote'")
    expect(migration).toContain(
      "currency in ('USD','EUR','COP','PEN','MXN','BRL','CLP','ARS')",
    )
    expect(service).toContain('pricesIncludeTax: raw.prices_include_tax !== false')
    expect(service).toContain('rooms_count: input.roomsCount || 1')
    expect(service).toContain('checkInTime: normalizedTime(')
  })

  it('hace idempotentes cotizaciones, holds, estados y tarifas por fecha', () => {
    expect(migration).toContain('unique (business_id, idempotency_key_hash)')
    expect(migration).toContain("sha256(convert_to(p_idempotency_key, 'UTF8'))")
    expect(migration).toContain("'result', 'unchanged'")
    expect(migration).toContain("'changed', false")
    expect(migration).toContain("'changed', true")
    expect(tableDefinition('lodging_rate_overrides')).toContain(
      'unique (business_id, room_type_id, rate_date)',
    )
    expect(repository).toContain(".upsert({ ...tenantPayload(data), business_id: businessId }")
    expect(repository).toContain(
      "onConflict: 'business_id,room_type_id,rate_date'",
    )
    expect(routes).toContain("payload.result === 'updated' && payload.changed === true")
    expect(routes).toContain('notificationSent')
  })

  it('protege los holds de solicitud del CRUD genérico', () => {
    expect(migration).toContain("if p_kind not in ('manual', 'external', 'maintenance')")
    expect(migration.match(/v_block\.kind = 'request'/g)?.length)
      .toBeGreaterThanOrEqual(2)
    expect(migration).toContain(
      'Un bloqueo de solicitud solo se libera mediante el estado de la solicitud',
    )
    expect(migration).toContain(
      'La identidad de un bloqueo de solicitud es inmutable',
    )
    expect(routes).toContain(
      'Los cupos de una solicitud solo se liberan cambiando su estado',
    )
  })

  it('mantiene el contrato de cinco datos desde el prompt hasta PostgreSQL', () => {
    expect(prompt).toContain(
      '##STAY_QUOTE:YYYY-MM-DD|YYYY-MM-DD|HABITACIONES|ADULTOS|NIÑOS##',
    )
    expect(tags).toContain('roomsCount: strictPeople(roomsRaw, 1)')
    expect(routes).toContain('req.body.rooms ?? req.body.rooms_count ?? 1')
    expect(migration).toContain('p_rooms_count integer default 1')
    expect(migration).toContain('greatest(\n      p_rooms_count,')
  })

  it('integra onboarding y conserva schema.sql como fuente reproducible', () => {
    expect(migration).toContain("p_business ->> 'lodging_enabled'")
    expect(migration).toContain('insert into public.lodging_settings (business_id)')
    expect(migration).toContain('grant execute on function public.quote_lodging_options')
    expect(migration).toContain(
      'grant execute on function public.create_lodging_request_if_available',
    )
    const marker = migration.slice(0, migration.indexOf('\n') + 1)
    const schemaStart = schema.indexOf(marker)
    expect(schemaStart).toBeGreaterThanOrEqual(0)
    expect(schema.slice(schemaStart).trimEnd()).toBe(migration.trimEnd())
  })
})
