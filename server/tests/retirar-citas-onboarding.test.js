import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const sql = readFileSync(
  `${serverDir}/migration-2026-08-16-retirar-citas.sql`,
  'utf8',
)

function funcionOnboarding(contenido, ultima = false) {
  const inicio = contenido[ultima ? 'lastIndexOf' : 'indexOf'](
    'create or replace function public.create_business_onboarding(',
  )
  expect(inicio, 'falta create_business_onboarding').toBeGreaterThanOrEqual(0)

  const fin = contenido.indexOf('\n$$;', inicio)
  expect(fin, 'el cuerpo de create_business_onboarding no cierra').toBeGreaterThan(inicio)
  return contenido.slice(inicio, fin + 4)
}

describe('onboarding después de retirar citas', () => {
  const funcion = funcionOnboarding(sql)

  it('mantiene los tres modos durante el despliegue mixto', () => {
    expect(funcion).toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
  })

  it('no reintroduce hospedaje ni citas y conserva pedidos y tienda', () => {
    expect(funcion).not.toMatch(/\blodging_enabled\b|\btakes_bookings\b/)
    expect(funcion).toMatch(
      /takes_orders,\s*storefront_enabled,\s*chat_mode,/,
    )
    expect(funcion).toMatch(
      /coalesce\(\(p_business ->> 'takes_orders'\)::boolean, true\),\s*coalesce\(\(p_business ->> 'storefront_enabled'\)::boolean, false\),\s*v_chat_mode,/,
    )
  })

  it('renombra el permiso citas sin duplicar horarios existentes', () => {
    expect(sql).toContain('with ordinality as elemento(permiso, posicion)')
    expect(sql).toContain('min(posicion) as primera_posicion')
    expect(sql).toContain('group by valor')
    expect(sql).toContain('jsonb_agg(valor order by primera_posicion)')
  })

  it('conserva completo el alta transaccional heredada de las fases previas', () => {
    for (const contrato of [
      'public.billing_plan_definition(v_plan)',
      'insert into public.bot_policies',
      'insert into public.business_schedule',
      'insert into public.client_users',
      'insert into public.billing',
      "p_business ->> 'prep_time_minutes'",
      "p_business ->> 'delivery_extra_minutes'",
    ]) {
      expect(funcion).toContain(contrato)
    }
    expect(funcion.match(/\(v_business\.id, [0-6],/g)).toHaveLength(7)
  })

  it('mantiene la RPC cerrada al backend y con search_path seguro', () => {
    expect(funcion).toContain('security definer')
    expect(funcion).toContain('set search_path = public, pg_temp')
    expect(sql).toContain(
      'revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)',
    )
    expect(sql).toContain('from public, anon, authenticated;')
    expect(sql).toContain('to service_role;')
  })

})
