import { describe, expect, it } from 'vitest'
import {
  IMPRESCINDIBLES, MINIMO_TABLAS, revisarRespaldo, tablasDelInventario,
} from '../../.github/scripts/respaldo-sano.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LA COMPROBACIÓN DEL RESPALDO TIENE QUE DETECTAR ALGO
// ═══════════════════════════════════════════════════════════════════════════
//
// Una verificación que nunca falla es peor que ninguna: da confianza sin
// darla. Estas pruebas comprueban que el guardián del respaldo caza los tres
// casos que de verdad pasan — el dump vacío, el volcado a medias y el que
// apuntó a la base equivocada.
//
// ⚠️ Nació el 2026-09-23, tras 39 horas con la base caída y el respaldo más
// reciente de hacía UN MES.

/** Una línea de `pg_restore -l`, tal como la escribe PostgreSQL. */
const linea = (tabla, i) => `${2000 + i}; 0 ${16000 + i} TABLE DATA public ${tabla} postgres`

/** Un inventario con las tablas que se le pasen. */
const inventario = (tablas) => [
  ';',
  '; Archive created at 2026-09-23 05:00:00',
  ';     dbname: postgres',
  ';',
  ...tablas.map(linea),
].join('\n')

/** Un respaldo bueno: las imprescindibles y relleno hasta pasar el mínimo. */
const respaldoBueno = () => inventario([
  ...IMPRESCINDIBLES,
  ...Array.from({ length: MINIMO_TABLAS }, (_, i) => `tabla_de_relleno_${i}`),
])

describe('leer el inventario de un dump', () => {
  it('saca los nombres de las tablas con datos', () => {
    const t = tablasDelInventario(inventario(['businesses', 'products']))
    expect(t).toEqual(['businesses', 'products'])
  })

  it('ignora las líneas de cabecera y los comentarios', () => {
    const t = tablasDelInventario(inventario([]))
    expect(t).toEqual([])
  })

  it('no se traga entradas que NO son datos de tabla', () => {
    const listado = [
      '215; 1259 16543 TABLE public businesses postgres',
      '4321; 0 16543 TABLE DATA public orders postgres',
      '3012; 2606 16789 CONSTRAINT public orders orders_pkey postgres',
    ].join('\n')
    // Solo `TABLE DATA` cuenta: la definición de una tabla vacía no es un dato.
    expect(tablasDelInventario(listado)).toEqual(['orders'])
  })
})

describe('un respaldo sano pasa', () => {
  it('con todas las imprescindibles y tablas de sobra', () => {
    const r = revisarRespaldo(respaldoBueno())
    expect(r.sano).toBe(true)
    expect(r.problemas).toEqual([])
  })
})

describe('y los tres desastres que de verdad pasan se cazan', () => {
  it('EL DUMP VACÍO: pg_dump terminó en 0 y no trajo nada', () => {
    const r = revisarRespaldo(inventario([]))
    expect(r.sano).toBe(false)
    expect(r.problemas[0]).toMatch(/NINGUNA tabla/)
  })

  it('EL VOLCADO A MEDIAS: muchas tablas pero falta el negocio', () => {
    const r = revisarRespaldo(inventario(
      Array.from({ length: MINIMO_TABLAS + 5 }, (_, i) => `tabla_${i}`),
    ))
    expect(r.sano).toBe(false)
    expect(r.problemas.join(' ')).toMatch(/businesses/)
  })

  it('LA BASE EQUIVOCADA: están las clave pero casi nada más', () => {
    const r = revisarRespaldo(inventario(IMPRESCINDIBLES))
    expect(r.sano).toBe(false)
    expect(r.problemas.join(' ')).toMatch(/al menos/)
  })

  it('nombra TODAS las que faltan, no solo la primera', () => {
    const r = revisarRespaldo(inventario(
      IMPRESCINDIBLES.filter(t => !['orders', 'sales'].includes(t)),
    ))
    expect(r.problemas.join(' ')).toMatch(/orders/)
    expect(r.problemas.join(' ')).toMatch(/sales/)
  })
})

describe('casos de borde que no deben reventar', () => {
  it('una entrada nula se trata como respaldo vacío', () => {
    expect(revisarRespaldo(null).sano).toBe(false)
    expect(revisarRespaldo(undefined).sano).toBe(false)
    expect(revisarRespaldo('').sano).toBe(false)
  })

  it('el mínimo se puede ajustar sin tocar el módulo', () => {
    const pocas = inventario(IMPRESCINDIBLES)
    expect(revisarRespaldo(pocas, { minimo: 6 }).sano).toBe(true)
  })
})
