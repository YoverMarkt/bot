import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-atomicidad-reservas.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const repository = readFileSync(
  `${serverDir}/src/db/repositories/bookings.ts`,
  'utf8',
)

describe('atomicidad de reservas', () => {
  it('protege cualquier escritura con intervalos activos no solapados', () => {
    expect(migration).toContain('create extension if not exists btree_gist')
    expect(migration).toContain('add constraint bookings_no_active_overlap')
    expect(migration).toContain('exclude using gist')
    expect(migration).toContain('business_id with =')
    expect(migration).toContain("'[)'")
    expect(migration).toContain("status in ('pending', 'confirmed')")
    expect(migration).toContain('alter column business_id set not null')
    expect(migration).toContain('alter column duration_minutes set not null')
  })

  it('serializa por negocio y fecha antes de decidir e insertar', () => {
    expect(migration).toContain(
      'create or replace function public.create_booking_if_available',
    )
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain("p_business_id::text || ':' || p_booking_date::text")
    expect(migration).toMatch(/booking\.business_id\s*=\s*p_business_id/g)
    expect(migration).toContain("'result', 'duplicate'")
    expect(migration).toContain("'result', 'conflict'")
    expect(migration).toContain("'result', 'created'")
    expect(migration).toContain('insert into public.bookings')
    expect(migration).toContain('when exclusion_violation then')
  })

  it('valida negocio, futuro y horario activo dentro de la transacción', () => {
    expect(migration).toContain("time zone 'America/Guayaquil'")
    expect(migration).toContain('La reserva debe estar en el futuro')
    expect(migration).toContain('schedule.is_active is true')
    expect(migration).toContain('for share;')
    expect(migration).toContain('v_schedule.open_time')
    expect(migration).toContain('v_schedule.close_time')
    expect(migration).toContain('La hora no corresponde a un intervalo disponible')
  })

  it('permite ejecutar la RPC únicamente al backend service_role', () => {
    expect(migration).toContain('from public;')
    expect(migration).toContain('from anon;')
    expect(migration).toContain('from authenticated;')
    expect(migration).toContain('to service_role;')
  })

  it('sincroniza el esquema y elimina el SELECT→INSERT del repositorio', () => {
    expect(schema).toContain('add constraint bookings_no_active_overlap')
    expect(schema).toContain(
      'create or replace function public.create_booking_if_available',
    )
    expect(repository).toContain("'create_booking_if_available'")
    expect(repository).not.toContain('p_service_product_id')
    expect(repository).not.toContain("from('bookings').insert")
    expect(repository).toContain(".in('status', ['pending', 'confirmed'])")
    expect(repository).toContain('if (error) throw new Error(error.message)')
    expect(repository).toContain('minute < end && start < minute + duration')
  })
})
