import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverDir = fileURLToPath(new URL('..', import.meta.url))

const leer = nombre => readFileSync(`${serverDir}/${nombre}`, 'utf8')

function ultimaFuncionOnboarding(sql) {
  const inicio = sql.lastIndexOf(
    'create or replace function public.create_business_onboarding(',
  )
  expect(inicio, 'falta create_business_onboarding').toBeGreaterThanOrEqual(0)

  const fin = sql.indexOf('\n$$;', inicio)
  expect(fin, 'el cuerpo de create_business_onboarding no cierra').toBeGreaterThan(inicio)
  return sql.slice(inicio, fin + 4)
}

function esperarTiendaPreservada(funcion) {
  expect(funcion).toMatch(
    /takes_orders,\s*storefront_enabled,\s*chat_mode,/,
  )
  expect(funcion).toMatch(
    /coalesce\(\(p_business ->> 'takes_orders'\)::boolean, true\),\s*coalesce\(\(p_business ->> 'storefront_enabled'\)::boolean, false\),\s*v_chat_mode,/,
  )
}

describe('onboarding durante el retiro por fases', () => {
  const hospedaje = ultimaFuncionOnboarding(
    leer('migration-2026-08-16-retirar-hospedaje.sql'),
  )
  const citas = ultimaFuncionOnboarding(
    leer('migration-2026-08-16-retirar-citas.sql'),
  )
  const menuSql = leer('migration-2026-08-16-retirar-modo-menu.sql')
  const menu = ultimaFuncionOnboarding(menuSql)

  it('fase 1 conserva citas, tienda y los tres modos del despliegue mixto', () => {
    expect(hospedaje).toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
    expect(hospedaje).toMatch(
      /takes_bookings,\s*takes_orders,\s*storefront_enabled,\s*chat_mode,/,
    )
    expect(hospedaje).not.toMatch(/\blodging_enabled\b/)
    esperarTiendaPreservada(hospedaje)
  })

  it('fase 2 retira citas sin revertir miniapp ni apagar la tienda', () => {
    expect(citas).toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
    expect(citas).not.toMatch(/\btakes_bookings\b/)
    expect(citas).not.toMatch(/\blodging_enabled\b/)
    esperarTiendaPreservada(citas)
  })

  it('fase 3 estrecha los modos y sigue copiando storefront_enabled', () => {
    expect(menu).toContain("v_chat_mode not in ('ai', 'miniapp')")
    expect(menu).not.toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
    expect(menu).not.toMatch(/\btakes_bookings\b/)
    expect(menu).not.toMatch(/\blodging_enabled\b/)
    esperarTiendaPreservada(menu)
    expect(menu).toContain('El modo miniapp requiere pedidos y tienda habilitados')
  })

  it('fase 3 se detiene ante un menu legacy sin tienda utilizable', () => {
    expect(menuSql).toMatch(
      /where chat_mode = 'menu'\s+and \(takes_orders is not true or storefront_enabled is not true\)/,
    )
    expect(menuSql).toContain("errcode = '23514'")
  })

  it('el contrato final de schema.sql coincide con la fase 3', () => {
    const contratoFinal = ultimaFuncionOnboarding(leer('schema.sql'))

    expect(contratoFinal).toBe(menu)
    expect(contratoFinal).toContain("v_chat_mode not in ('ai', 'miniapp')")
    expect(contratoFinal).not.toMatch(/\btakes_bookings\b|\blodging_enabled\b/)
    expect(contratoFinal).toMatch(/\bprep_time_minutes,\s*delivery_extra_minutes/)
    esperarTiendaPreservada(contratoFinal)
  })
})
