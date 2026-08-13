import { describe, expect, it } from 'vitest'
import { grupoEnTexto, resumenDesdeCarrito, resumenDesdePedido } from '../src/lib/resumen'
import type { CartLine, TrackedItem } from '../src/lib/types'

// El resumen del pedido decía «1× Pizza $16.83» justo después de que el
// cliente eligiera masa, borde y sabor. Lo que se protege aquí es que los DOS
// caminos —el carrito recién enviado y el pedido que devuelve el servidor—
// acaben en la misma forma: cuando cada uno arma la suya es cuando las tres
// superficies del pedido empiezan a contar cosas distintas del mismo plato.

const producto = (name: string) => ({ name }) as CartLine['product']

const lineaDeCarrito = (extra: Partial<CartLine> = {}): CartLine => ({
  key: 'k', product: producto('Pizza'), variant: null, extras: [], options: [],
  quantity: 1, note: '', unitPrice: 16.83, ...extra,
} as CartLine)

const opcion = (groupName: string, name: string, quantity = 1) => ({
  groupId: groupName, groupName, optionId: name, name, price: 0, quantity,
})

describe('el resumen desde el carrito', () => {
  it('agrupa lo elegido por su grupo, en el orden en que se eligió', () => {
    const [linea] = resumenDesdeCarrito([lineaDeCarrito({
      options: [
        opcion('Masa', 'Tradicional'),
        opcion('Borde', 'Borde de queso'),
        opcion('Sabor', 'Alemana'),
      ],
    })])

    // El orden es el que puso el dueño en la ficha, que es el mismo en el que
    // el cliente la armó: sabor antes que borde si así está la ficha.
    expect(linea.grupos.map(g => g.group)).toEqual(['Masa', 'Borde', 'Sabor'])
    expect(linea.grupos[2].items).toEqual([{ name: 'Alemana', quantity: 1 }])
  })

  it('junta en un solo grupo las varias opciones del mismo', () => {
    const [linea] = resumenDesdeCarrito([lineaDeCarrito({
      options: [opcion('Sabor', 'Alemana'), opcion('Sabor', 'Hawaiana')],
    })])
    expect(linea.grupos).toHaveLength(1)
    expect(linea.grupos[0].items.map(i => i.name)).toEqual(['Alemana', 'Hawaiana'])
  })

  // ⚠️ «Sin ají» bajo un rótulo «Extras» se lee como si le AÑADIERAN ají. Los
  // modificadores traen su propio grupo y hay que respetarlo.
  it('respeta el grupo de los extras viejos en vez de inventar un rótulo', () => {
    const [linea] = resumenDesdeCarrito([lineaDeCarrito({
      extras: [
        { id: '1', group: 'Retira ingredientes', name: 'Sin ají', description: null, price: 0, maxSelectable: null },
        { id: '2', group: 'Extras', name: 'Extra queso', description: null, price: 1, maxSelectable: null },
      ],
    })])
    expect(linea.grupos.map(g => g.group)).toEqual(['Retira ingredientes', 'Extras'])
  })

  it('lleva la nota del cliente y el nombre con su variante', () => {
    const [linea] = resumenDesdeCarrito([lineaDeCarrito({
      variant: { id: 'v', name: 'Familiar' } as CartLine['variant'],
      note: '  bien cocida  ',
      quantity: 2,
    })])
    expect(linea.nombre).toBe('Pizza · Familiar')
    expect(linea.nota).toBe('bien cocida')
    expect(linea.cantidad).toBe(2)
  })
})

describe('el resumen desde el pedido guardado', () => {
  const item = (extra: Partial<TrackedItem> = {}): TrackedItem => ({
    product_name: 'Pizza', quantity: 1, line_total: 16.83, ...extra,
  } as TrackedItem)

  it('respeta el agrupado que ya hizo el servidor, sin reordenarlo', () => {
    const [linea] = resumenDesdePedido([item({
      options: [
        { group: 'Sabor', items: [{ name: 'Alemana', quantity: 1 }] },
        { group: 'Masa', items: [{ name: 'Tradicional', quantity: 1 }] },
      ],
    })])
    // El orden lo puso el dueño y viaja desde la base: aquí no se toca.
    expect(linea.grupos.map(g => g.group)).toEqual(['Sabor', 'Masa'])
    expect(linea.importe).toBe(16.83)
  })

  // Los pedidos anteriores al motor de opciones solo guardaron una lista plana.
  it('cae a extras_names cuando el pedido es anterior al motor de opciones', () => {
    const [linea] = resumenDesdePedido([item({
      options: [],
      extras_names: ['Tradicional', 'Borde de queso', 'Alemana'],
    })])
    expect(linea.grupos).toHaveLength(1)
    expect(linea.grupos[0].group).toBe('Incluye')
    expect(linea.grupos[0].items.map(i => i.name)).toEqual(['Tradicional', 'Borde de queso', 'Alemana'])
  })

  it('un pedido sin nada elegido no inventa grupos vacíos', () => {
    const [linea] = resumenDesdePedido([item({ options: [], extras_names: [] })])
    expect(linea.grupos).toEqual([])
    expect(linea.nota).toBe('')
  })

  // Un grupo sin opciones dentro no se pinta: dejaría un título suelto.
  it('descarta un grupo que llega vacío', () => {
    const [linea] = resumenDesdePedido([item({
      options: [{ group: 'Sabor', items: [] }, { group: 'Masa', items: [{ name: 'Fina', quantity: 1 }] }],
    })])
    expect(linea.grupos.map(g => g.group)).toEqual(['Masa'])
  })
})

describe('cómo se lee un grupo', () => {
  it('nombra el grupo y separa lo elegido con comas', () => {
    expect(grupoEnTexto({ group: 'Sabor', items: [{ name: 'Alemana', quantity: 1 }] }))
      .toBe('Sabor: Alemana')
  })

  it('dice la cantidad solo cuando es más de una', () => {
    expect(grupoEnTexto({
      group: 'Bebidas',
      items: [{ name: 'Cola', quantity: 2 }, { name: 'Agua', quantity: 1 }],
    })).toBe('Bebidas: Cola ×2, Agua')
  })
})
