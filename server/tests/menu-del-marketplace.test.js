import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PAGINA, VER_MAS, VOLVER, elegir, paso, verCategorias, verNegocios,
} from '../dist/services/marketplace-menu.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL MENÚ DEL MARKETPLACE
//
// Lo que ve quien escribe al número de Umbani. Se prueba entero sin base
// porque es una función pura, y eso es justo lo que permite cubrir los casos
// que en producción costarían un mensaje cada uno.
// ═══════════════════════════════════════════════════════════════════════════

const cat = (code, label, emoji = null, locales = 1) => ({ code, label, emoji, locales })
const neg = (slug, name, type = 'pizzería') => ({
  id: `id-${slug}`, slug, name, type, prep_min: 30,
})

const CATEGORIAS = [
  cat('pizzerias', 'Pizzerías', '🍕', 2),
  cat('hamburguesas', 'Hamburguesas', '🍔', 2),
  cat('mariscos', 'Mariscos y ceviches', '🐟', 1),
]

describe('la portada', () => {
  it('saluda una sola vez y ofrece las categorías', () => {
    const r = verCategorias(CATEGORIAS, 0, true)
    expect(r.reply).toContain('Umbani')
    expect(r.reply).toContain('¿Qué deseas pedir?')
    expect(r.options).toEqual(['🍕 Pizzerías', '🍔 Hamburguesas', '🐟 Mariscos y ceviches'])
    // Al volver al menú no se vuelve a saludar: sería un mensaje que se paga.
    expect(verCategorias(CATEGORIAS, 0, false).reply).not.toContain('Umbani')
  })

  it('sin locales lo dice, en vez de enseñar una lista vacía', () => {
    const r = verCategorias([], 0, true)
    expect(r.options).toEqual([])
    expect(r.reply).toMatch(/no tenemos locales/i)
  })

  it('pagina de nueve en nueve, porque la décima fila es «Ver más»', () => {
    // ⚠️ Una lista de WhatsApp admite DIEZ filas. Con diez categorías más el
    // botón, la última se perdería sin que nada avisara.
    const muchas = Array.from({ length: 14 }, (_, i) => cat(`c${i}`, `Categoría ${i}`))
    const primera = verCategorias(muchas, 0)
    expect(primera.options).toHaveLength(PAGINA + 1)
    expect(primera.options).toHaveLength(10)
    expect(primera.options.at(-1)).toBe(VER_MAS)

    const segunda = verCategorias(muchas, 1)
    expect(segunda.options).toHaveLength(5)
    expect(segunda.options).not.toContain(VER_MAS)
  })
})

describe('elegir una opción', () => {
  const opciones = ['🍕 Pizzerías', '🍔 Hamburguesas', VER_MAS]

  it('acepta el texto exacto que devuelve WhatsApp', () => {
    expect(elegir('🍕 Pizzerías', opciones)).toBe('🍕 Pizzerías')
  })

  it('acepta el número de la fila, que es como responde mucha gente', () => {
    expect(elegir('2', opciones)).toBe('🍔 Hamburguesas')
    expect(elegir('9', opciones)).toBeNull()
    expect(elegir('0', opciones)).toBeNull()
  })

  it('acepta el nombre sin emoji, sin tildes y sin mayúsculas', () => {
    expect(elegir('pizzerias', opciones)).toBe('🍕 Pizzerías')
    expect(elegir('PIZZERÍAS', opciones)).toBe('🍕 Pizzerías')
    expect(elegir('  hamburguesas ', opciones)).toBe('🍔 Hamburguesas')
  })

  it('no adivina cuando no hay nada parecido', () => {
    expect(elegir('quiero una moto', opciones)).toBeNull()
    expect(elegir('', opciones)).toBeNull()
  })
})

describe('navegar', () => {
  const enPortada = { vista: 'categorias', pagina: 0 }

  it('elegir una categoría pide sus locales, sin inventárselos', () => {
    const r = paso({
      mensaje: 'pizzerias', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    // No responde todavía: dice al llamador qué consultar.
    expect(r.vista).toEqual({ vista: 'negocios', categoria: 'pizzerias', pagina: 0 })
    expect(r.negocioElegido).toBeUndefined()
  })

  it('elegir un local devuelve el local, y ahí termina el menú', () => {
    const negocios = [neg('pizza-uno', 'Pizza Uno'), neg('pizza-dos', 'Pizza Dos')]
    const r = paso({
      mensaje: 'Pizza Dos',
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 },
      categorias: CATEGORIAS, negocios,
    })
    expect(r.negocioElegido?.slug).toBe('pizza-dos')
  })

  it('«Volver» regresa a la portada, no a la página en la que estaba', () => {
    const r = paso({
      mensaje: VOLVER,
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 3 },
      categorias: CATEGORIAS, negocios: [neg('x', 'X')],
    })
    expect(r.vista).toEqual({ vista: 'categorias', pagina: 0 })
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('un mensaje que no casa repite la lista en vez de dejar al cliente colgado', () => {
    const r = paso({
      mensaje: 'aaaa', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toMatch(/No te entendí/)
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('si la categoría se queda sin locales mientras miraba, no deja una calle sin salida', () => {
    // El último local pudo cerrar entre el menú y esta respuesta.
    const r = verNegocios(CATEGORIAS[0], [], 0)
    expect(r.options).toEqual([VOLVER])
    expect(r.reply).toMatch(/no hay locales abiertos/i)
  })

  it('si la categoría desapareció del todo, vuelve a la portada', () => {
    const r = paso({
      mensaje: 'lo que sea',
      vista: { vista: 'negocios', categoria: 'ya-no-existe', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(r.vista.vista).toBe('categorias')
  })
})

describe('el reparto de tipos en categorías', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../migration-2026-08-21-categorias-del-marketplace.sql', import.meta.url)),
    'utf8',
  )
  const panel = readFileSync(
    fileURLToPath(new URL('../../apps/admin/src/features/clients/business-types.ts', import.meta.url)),
    'utf8',
  )

  const tiposDelPanel = () => [...panel.matchAll(/\{\s*value:\s*'([^']+)'/g)].map(([, v]) => v)
  const tiposRepartidos = () => [...sql.matchAll(/\('([^']+)','[a-z_]+'\)/g)].map(([, t]) => t)

  it('encuentra ambas listas (si no, todo lo demás pasaría en falso)', () => {
    expect(tiposDelPanel().length).toBeGreaterThanOrEqual(31)
    expect(tiposRepartidos().length).toBeGreaterThanOrEqual(31)
  })

  it('cada tipo del desplegable cae en una categoría', () => {
    // Un tipo sin categoría deja a sus locales invisibles en el menú, y nada
    // falla: simplemente nadie los encuentra nunca.
    const repartidos = new Set(tiposRepartidos())
    const huerfanos = tiposDelPanel().filter(tipo => !repartidos.has(tipo))
    expect(
      huerfanos,
      huerfanos.length
        ? 'Estos tipos no están en ninguna categoría del marketplace, así que sus\n'
          + `locales no saldrán nunca en el menú:\n${huerfanos.map(t => `  · ${t}`).join('\n')}`
        : '',
    ).toEqual([])
  })

  it('ningún tipo cae en dos categorías', () => {
    // Si pudiera, el mismo local saldría dos veces y el cliente no sabría si
    // son dos sitios distintos. Lo impide la clave primaria; esto lo vigila
    // también en el texto, que es donde se escribe el error.
    const repartidos = tiposRepartidos()
    const repetidos = repartidos.filter((t, i) => repartidos.indexOf(t) !== i)
    expect(repetidos).toEqual([])
    expect(sql).toContain('business_type text primary key')
  })

  it('el menú nunca ofrece una categoría vacía', () => {
    expect(sql).toMatch(/having count\(b\.id\) > 0/)
    // Y «disponible» significa que puede recibir un pedido AHORA.
    for (const condicion of ['b.active', 'b.suspended is not true', 'b.takes_orders', 'b.storefront_enabled']) {
      expect(sql, condicion).toContain(condicion)
    }
  })
})
