import { describe, expect, it } from 'vitest'
import {
  etiquetaDePrecio,
  grupoDeAcompanantes,
  grupoDeParte,
  leerPrecio,
  opcionDelPlato,
  platoDelProducto,
  reglaDelPlato,
  siguienteOrden,
} from '../src/features/catalog/plato-por-partes'
import type { OptionGroup, ProductOption } from '../src/features/catalog/api'

// ═══════════════════════════════════════════════════════════════════════════
// EL EDITOR DEL PLATO POR PARTES
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que el dueño arma aquí lo cobra la base y lo pinta la mini app. Si el
// editor mandara un grupo que la base rechaza, el dueño leería un error; si
// leyera mal un precio escrito con coma, vendería a otro precio.

const grupo = (extra: Partial<OptionGroup> & Pick<OptionGroup, 'id' | 'name'>): OptionGroup => ({
  ...grupoDeParte('alm', extra.name, 0),
  ...extra,
})

const opcion = (id: string, groupId: string, name: string, sort = 0): ProductOption => ({
  id, ...opcionDelPlato(groupId, name, 0, sort),
})

describe('el plato de un producto', () => {
  const GRUPOS: OptionGroup[] = [
    grupo({ id: 'segundo', name: 'Segundo', sort: 1 }),
    grupo({ id: 'sopa', name: 'Sopa', sort: 0 }),
    grupo({ id: 'acompanar', name: 'Para acompañar', sort: 2, is_meal_part: false }),
    // De OTRO producto y de una categoría: no son de este plato.
    grupo({ id: 'ajeno', name: 'Sopa', product_id: 'otro' }),
    grupo({ id: 'categoria', name: 'Bebida', product_id: null, category_id: 'cat', is_meal_part: false }),
  ]
  const OPCIONES = [
    opcion('pollo', 'segundo', 'Pollo', 1),
    opcion('ceviche', 'segundo', 'Ceviche', 0),
    opcion('caldo', 'sopa', 'Caldo de res'),
    opcion('jugo', 'acompanar', 'Jugo'),
  ]

  it('separa las partes de lo que acompaña, en el orden del dueño', () => {
    const plato = platoDelProducto(GRUPOS, OPCIONES, 'alm')
    expect(plato.partes.map(p => p.grupo.id)).toEqual(['sopa', 'segundo'])
    expect(plato.partes[1].opciones.map(o => o.name)).toEqual(['Ceviche', 'Pollo'])
    expect(plato.acompanantes?.grupo.id).toBe('acompanar')
  })

  it('no mezcla grupos de otro producto ni de una categoría', () => {
    const plato = platoDelProducto(GRUPOS, OPCIONES, 'alm')
    const ids = [...plato.partes.map(p => p.grupo.id), plato.acompanantes?.grupo.id]
    expect(ids).not.toContain('ajeno')
    expect(ids).not.toContain('categoria')
  })

  it('un producto sin partes no tiene plato', () => {
    const plato = platoDelProducto(GRUPOS, OPCIONES, 'cola')
    expect(plato).toEqual({ partes: [], acompanantes: null })
  })
})

describe('lo que se manda a la API', () => {
  // Las mismas reglas que exige la base: contador, del producto, sin tope.
  it('una parte es un contador colgado del producto, sin precio por separado', () => {
    expect(grupoDeParte('alm', '  Sopa ', 0)).toMatchObject({
      product_id: 'alm', category_id: null, name: 'Sopa',
      selection_type: 'quantity', required: false, min_selectable: 0, max_selectable: 100,
      is_meal_part: true, loose_price: null,
    })
  })

  it('lo que acompaña también es un contador, pero no es parte', () => {
    expect(grupoDeAcompanantes('alm', 2)).toMatchObject({
      name: 'Para acompañar', selection_type: 'quantity', is_meal_part: false, sort: 2,
    })
  })

  it('lo nuevo va detrás de lo que ya hay', () => {
    expect(siguienteOrden([])).toBe(0)
    expect(siguienteOrden([{ sort: 0 }, { sort: 3 }])).toBe(4)
  })
})

describe('los precios que escribe el dueño', () => {
  it('lee la coma igual que el punto: en Ecuador se escribe con coma', () => {
    expect(leerPrecio('1,50')).toBe(1.5)
    expect(leerPrecio('1.50')).toBe(1.5)
    expect(leerPrecio('$ 2')).toBe(2)
  })

  it('vacío es «sin precio», y lo que no es un precio se dice', () => {
    expect(leerPrecio('   ')).toBeNull()
    expect(leerPrecio('abc')).toBeUndefined()
    expect(leerPrecio('-1')).toBeUndefined()
  })

  it('lo que acompaña sin precio dice «Gratis», como lo lee el cliente', () => {
    expect(etiquetaDePrecio(0)).toBe('Gratis')
    expect(etiquetaDePrecio('0.50')).toBe('$0.50')
  })

  it('la regla del plato se lee igual que en la mini app', () => {
    const plato = { partes: [{ grupo: grupo({ id: 's', name: 'Sopa' }), opciones: [] }, { grupo: grupo({ id: 'g', name: 'Segundo' }), opciones: [] }], acompanantes: null }
    expect(reglaDelPlato(plato, 3)).toBe('Sopa + Segundo = un plato completo a $3.00')
  })
})
