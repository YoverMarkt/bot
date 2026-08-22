import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migrationName = 'migration-2026-08-16-onboarding-miniapp.sql'
const migration = readFileSync(`${serverDir}/${migrationName}`, 'utf8')
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')

function liveOnboardingDefinition(sql) {
  const marker = 'create or replace function public.create_business_onboarding('
  const start = sql.lastIndexOf(marker)
  const end = sql.indexOf('$$;', start)
  return sql.slice(start, end + 3)
}

describe('onboarding compatible durante el retiro de módulos', () => {
  it('se ordena antes de las migraciones destructivas', () => {
    expect(migrationName.localeCompare(
      'migration-2026-08-16-retirar-hospedaje.sql',
    )).toBeLessThan(0)
  })

  it('acepta los tres modos de la ventana mixta y guarda la tienda', () => {
    expect(migration).toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
    expect(migration).toContain('storefront_enabled,')
    expect(migration).toContain(
      "coalesce((p_business ->> 'storefront_enabled')::boolean, false)",
    )
  })

  it('conserva completo el alta transaccional vigente', () => {
    for (const contract of [
      'public.billing_plan_definition(v_plan)',
      'insert into public.bot_policies',
      'insert into public.business_schedule',
      'insert into public.lodging_settings',
      'insert into public.client_users',
      'insert into public.billing',
      "p_business ->> 'prep_time_minutes'",
      "p_business ->> 'delivery_extra_minutes'",
    ]) {
      expect(migration).toContain(contract)
    }
    expect(migration.match(/\(v_business\.id, [0-6],/g)).toHaveLength(7)
  })

  it('mantiene la RPC reservada al backend', () => {
    expect(migration).toContain('security definer')
    expect(migration).toContain('from public, anon, authenticated;')
    expect(migration).toContain('to service_role;')
  })

  it('deja el esquema consolidado con el mismo contrato final', () => {
    const live = liveOnboardingDefinition(schema)
    // ⚠️ La IA se retiró el 2026-08-21: quedan `menu` y `miniapp`. Lo que esta
    // prueba vigila sigue siendo lo mismo — que el modo mini app sobreviva a
    // cada retirada—, solo que ahora acompañado de uno y no de dos.
    expect(live).toContain("v_chat_mode not in ('menu', 'miniapp')")
    expect(live).not.toMatch(/'ai'/)
    expect(live).toContain('storefront_enabled,')
    expect(live).toContain(
      "coalesce((p_business ->> 'storefront_enabled')::boolean, false)",
    )
  })
})
