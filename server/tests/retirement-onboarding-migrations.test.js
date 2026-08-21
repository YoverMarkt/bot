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
  const miniapp = ultimaFuncionOnboarding(
    leer('migration-2026-08-19-miniapp-exige-tienda.sql'),
  )
  // ⚠️ La versión que MANDA es la de la última migración que redefine la
  // función, no la de `schema.sql`. Al añadir una nueva hay que traerla aquí,
  // o este guardián seguiría comparando el esquema con una versión anterior y
  // daría por bueno un desfase.
  const sinCanal = ultimaFuncionOnboarding(
    leer('migration-2026-08-20-negocio-sin-canal-propio.sql'),
  )
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

  // ⚠️ NO hay fase 3. El modo menú se CONSERVA por decisión del dueño
  // (2026-08-19): junto con el modo IA, son las dos formas de atender que
  // Umbani mantiene además de la mini app. La retirada llegó hasta las citas.
  it('la última migración exige tienda al modo miniapp sin tocar los modos', () => {
    expect(miniapp).toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
    expect(miniapp).toContain('El modo miniapp requiere pedidos y tienda habilitados')
    expect(miniapp).not.toMatch(/\btakes_bookings\b|\blodging_enabled\b/)
    esperarTiendaPreservada(miniapp)
  })

  it('la fase 1 del marketplace libera el número sin tocar modos ni tienda', () => {
    expect(sinCanal).toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
    expect(sinCanal).toContain('El modo miniapp requiere pedidos y tienda habilitados')
    expect(sinCanal).not.toMatch(/\btakes_bookings\b|\blodging_enabled\b/)
    // El número deja de ser obligatorio SOLO para el marketplace.
    expect(sinCanal).toContain('Un negocio con canal propio necesita su número')
    expect(sinCanal).toMatch(/nullif\(v_whatsapp_number, ''\)/)
    esperarTiendaPreservada(sinCanal)
  })

  it('el contrato final de schema.sql coincide con la última migración', () => {
    const contratoFinal = ultimaFuncionOnboarding(leer('schema.sql'))

    expect(contratoFinal).toBe(sinCanal)
    expect(contratoFinal).toContain("v_chat_mode not in ('menu', 'ai', 'miniapp')")
    expect(contratoFinal).not.toMatch(/\btakes_bookings\b|\blodging_enabled\b/)
    expect(contratoFinal).toMatch(/\bprep_time_minutes,\s*delivery_extra_minutes/)
    esperarTiendaPreservada(contratoFinal)
  })

  it('los tres modos siguen siendo válidos en el esquema', () => {
    const schema = leer('schema.sql')
    expect(schema).toContain("check (chat_mode in ('menu','ai','miniapp'))")
  })
})
