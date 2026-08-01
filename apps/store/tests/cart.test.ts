import { describe, expect, it } from 'vitest'
import {
  addLine, cartCount, cartTotal, groupExtras, lineKey, lineTotal, setQuantity, unitPrice,
} from '../src/lib/cart'
import type { CartLine, Extra, Product, Variant } from '../src/lib/types'

// El carrito es lo único de la app con lógica de verdad, y es lo que el cliente
// mira antes de decidir. Un error aquí no rompe nada: hace que la pantalla diga
// un número y el negocio cobre otro, que es peor.

const producto = (extra: Partial<Product> = {}): Product => ({
  id: 'p1',
  name: 'Pizza Margarita',
  description: null,
  imageUrl: null,
  videoUrl: null,
  categoryId: 'c1',
  tags: [],
  available: true,
  priceFrom: 12,
  hasVariants: false,
  variants: [],
  extras: [],
  ...extra,
})

const variante = (extra: Partial<Variant> = {}): Variant => ({
  id: 'v1', name: 'Familiar', price: 16, priceSale: null, ...extra,
})

const adicional = (extra: Partial<Extra> = {}): Extra => ({
  id: 'e1', group: 'Adicionales', name: 'Extra queso',
  description: null, price: 1.5, maxSelectable: 2, ...extra,
})

const linea = (extra: Partial<CartLine> = {}): CartLine => ({
  key: 'k1',
  product: producto(),
  variant: null,
  extras: [],
  quantity: 1,
  note: '',
  unitPrice: 12,
  ...extra,
})

describe('el carrito de la tienda', () => {
  describe('precio unitario', () => {
    it('sin variante usa el precio del producto', () => {
      expect(unitPrice(producto(), null, [])).toBe(12)
    })

    it('con variante manda la variante, no el producto', () => {
      expect(unitPrice(producto(), variante(), [])).toBe(16)
    })

    it('el precio de oferta gana sobre el normal', () => {
      expect(unitPrice(producto(), variante({ price: 16, priceSale: 13.5 }), [])).toBe(13.5)
    })

    it('suma los extras elegidos', () => {
      const extras = [adicional(), adicional({ id: 'e2', name: 'Champiñones', price: 1 })]
      expect(unitPrice(producto(), variante(), extras)).toBe(18.5)
    })

    // Los céntimos sueltos de coma flotante acaban en pantalla si nadie redondea.
    it('redondea a dos decimales', () => {
      const extras = [adicional({ price: 0.1 }), adicional({ id: 'e2', price: 0.2 })]
      expect(unitPrice(producto({ priceFrom: 0.1 }), null, extras)).toBe(0.4)
    })

    it('un producto sin precio cargado no rompe la cuenta', () => {
      expect(unitPrice(producto({ priceFrom: null }), null, [])).toBe(0)
    })
  })

  describe('identidad de la línea', () => {
    it('mismo producto con extras distintos son líneas distintas', () => {
      const conQueso = lineKey(producto(), null, [adicional()], '')
      const sinQueso = lineKey(producto(), null, [], '')
      expect(conQueso).not.toBe(sinQueso)
    })

    // Elegir queso→champiñones o champiñones→queso es el mismo plato.
    it('el orden en que se eligen los extras no crea otra línea', () => {
      const uno = adicional()
      const dos = adicional({ id: 'e2', name: 'Champiñones' })
      expect(lineKey(producto(), null, [uno, dos], ''))
        .toBe(lineKey(producto(), null, [dos, uno], ''))
    })

    it('una nota distinta separa las líneas', () => {
      expect(lineKey(producto(), null, [], 'sin cebolla'))
        .not.toBe(lineKey(producto(), null, [], ''))
    })

    it('la misma nota con otra caja o espacios es la misma línea', () => {
      expect(lineKey(producto(), null, [], ' Sin Cebolla '))
        .toBe(lineKey(producto(), null, [], 'sin cebolla'))
    })

    it('la variante distingue líneas', () => {
      expect(lineKey(producto(), variante(), [], ''))
        .not.toBe(lineKey(producto(), variante({ id: 'v2' }), [], ''))
    })
  })

  describe('agregar al carrito', () => {
    it('una línea nueva se añade', () => {
      expect(addLine([], linea())).toHaveLength(1)
    })

    it('la misma línea suma cantidad en vez de duplicarse', () => {
      const carrito = addLine([linea({ quantity: 2 })], linea({ quantity: 3 }))
      expect(carrito).toHaveLength(1)
      expect(carrito[0].quantity).toBe(5)
    })

    it('nunca pasa de 99 unidades de lo mismo', () => {
      const carrito = addLine([linea({ quantity: 98 })], linea({ quantity: 50 }))
      expect(carrito[0].quantity).toBe(99)
    })

    it('no muta el carrito anterior', () => {
      const original = [linea({ quantity: 1 })]
      addLine(original, linea({ quantity: 1 }))
      expect(original[0].quantity).toBe(1)
    })
  })

  describe('cambiar cantidades', () => {
    it('bajar a cero saca la línea del carrito', () => {
      expect(setQuantity([linea()], 'k1', 0)).toEqual([])
    })

    it('una cantidad negativa también la saca', () => {
      expect(setQuantity([linea()], 'k1', -3)).toEqual([])
    })

    it('no toca las demás líneas', () => {
      const carrito = [linea(), linea({ key: 'k2', quantity: 4 })]
      const resultado = setQuantity(carrito, 'k1', 7)
      expect(resultado[0].quantity).toBe(7)
      expect(resultado[1].quantity).toBe(4)
    })
  })

  describe('totales', () => {
    it('multiplica precio por cantidad', () => {
      expect(lineTotal(linea({ unitPrice: 17.5, quantity: 2 }))).toBe(35)
    })

    it('suma todas las líneas', () => {
      expect(cartTotal([
        linea({ unitPrice: 17.5, quantity: 2 }),
        linea({ key: 'k2', unitPrice: 8, quantity: 1 }),
      ])).toBe(43)
    })

    it('cuenta unidades, no líneas', () => {
      expect(cartCount([linea({ quantity: 3 }), linea({ key: 'k2', quantity: 2 })])).toBe(5)
    })

    it('un carrito vacío vale cero', () => {
      expect(cartTotal([])).toBe(0)
      expect(cartCount([])).toBe(0)
    })
  })

  describe('agrupar extras', () => {
    it('junta los del mismo grupo', () => {
      const grupos = groupExtras([
        adicional(),
        adicional({ id: 'e2', name: 'Champiñones' }),
        adicional({ id: 'e3', group: 'Salsas', name: 'Barbacoa' }),
      ])
      expect(grupos).toHaveLength(2)
      expect(grupos[0].items).toHaveLength(2)
      expect(grupos[1].group).toBe('Salsas')
    })

    it('los que no traen grupo caen en Extras', () => {
      const grupos = groupExtras([adicional({ group: '' })])
      expect(grupos[0].group).toBe('Extras')
    })
  })
})
