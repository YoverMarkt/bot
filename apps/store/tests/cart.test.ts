import { describe, expect, it } from 'vitest'
import {
  addLine, cartCount, cartTotal, chosenCount, groupExtras, groupPrice, lineKey,
  lineTotal, missingRequirement, setQuantity, unitPrice,
} from '../src/lib/cart'
import type {
  CartLine, ChosenOption, Extra, OptionGroup, Product, Variant,
} from '../src/lib/types'

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
  optionGroups: [],
  ...extra,
})

const variante = (extra: Partial<Variant> = {}): Variant => ({
  id: 'v1', name: 'Familiar', price: 16, priceSale: null, ...extra,
})

const adicional = (extra: Partial<Extra> = {}): Extra => ({
  id: 'e1', group: 'Adicionales', name: 'Extra queso',
  description: null, price: 1.5, maxSelectable: 2, ...extra,
})

const grupo = (extra: Partial<OptionGroup> = {}): OptionGroup => ({
  id: 'g1',
  name: 'Término',
  description: null,
  selectionType: 'single',
  pricingStrategy: 'sum',
  freeSelections: 0,
  required: false,
  minSelectable: 0,
  maxSelectable: 1,
  options: [],
  ...extra,
})

const elegida = (extra: Partial<ChosenOption> = {}): ChosenOption => ({
  groupId: 'g1',
  groupName: 'Término',
  optionId: 'o1',
  name: 'Bien cocida',
  price: 0,
  quantity: 1,
  ...extra,
})

const linea = (extra: Partial<CartLine> = {}): CartLine => ({
  key: 'k1',
  product: producto(),
  variant: null,
  extras: [],
  options: [],
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

// ═══════════════════════════════════════════════════════════════════════════
// GRUPOS DE OPCIONES
//
// Lo que decide si un plato se puede pedir. La base lo vuelve a comprobar y es
// la que manda, pero si aquí falla el cliente arma un pedido entero y se lo
// rechazan al confirmarlo, que es el peor momento para enterarse.
// ═══════════════════════════════════════════════════════════════════════════

describe('opciones del producto', () => {
  describe('lo que falta para poder agregar', () => {
    it('un grupo opcional no bloquea nada', () => {
      expect(missingRequirement([grupo()], [])).toBeNull()
    })

    it('un grupo obligatorio sin elegir bloquea y dice cuál', () => {
      const falta = missingRequirement([grupo({ required: true, minSelectable: 1 })], [])
      expect(falta?.message).toBe('Elige término')
    })

    it('elegir lo obligatorio desbloquea', () => {
      expect(missingRequirement(
        [grupo({ required: true, minSelectable: 1 })],
        [elegida()],
      )).toBeNull()
    })

    it('con mínimo mayor que uno lo dice con su número', () => {
      const falta = missingRequirement(
        [grupo({ id: 'g2', name: 'Frutas', minSelectable: 3, maxSelectable: 3, selectionType: 'multiple' })],
        [elegida({ groupId: 'g2' })],
      )
      expect(falta?.message).toBe('Elige 3 en Frutas')
    })

    it('en un contador cuentan las porciones, no cuántas casillas se tocaron', () => {
      // Una parrillada de 3 se cumple con UN corte pedido 3 veces.
      const parrillada = grupo({
        id: 'g3', name: 'Cortes', selectionType: 'quantity',
        required: true, minSelectable: 3, maxSelectable: 3,
      })
      expect(missingRequirement([parrillada], [
        elegida({ groupId: 'g3', optionId: 'lomo', quantity: 3 }),
      ])).toBeNull()
      expect(missingRequirement([parrillada], [
        elegida({ groupId: 'g3', optionId: 'lomo', quantity: 2 }),
      ])?.group.id).toBe('g3')
    })

    it('devuelve el PRIMER grupo que falta, para no marear al cliente', () => {
      const falta = missingRequirement([
        grupo({ id: 'ga', name: 'Sopa', required: true, minSelectable: 1 }),
        grupo({ id: 'gb', name: 'Segundo', required: true, minSelectable: 1 }),
      ], [])
      expect(falta?.group.id).toBe('ga')
    })

    it('lo elegido en OTRO grupo no cuenta para este', () => {
      const falta = missingRequirement(
        [grupo({ id: 'gx', name: 'Sopa', required: true, minSelectable: 1 })],
        [elegida({ groupId: 'otro' })],
      )
      expect(falta?.group.id).toBe('gx')
    })
  })

  describe('precio con opciones', () => {
    it('suma el recargo de cada opción', () => {
      expect(unitPrice(producto(), null, [], [elegida({ price: 1.5 })])).toBe(13.5)
    })

    it('un recargo NEGATIVO resta («sin sopa −0.50»)', () => {
      expect(unitPrice(producto(), null, [], [elegida({ price: -0.5 })])).toBe(11.5)
    })

    it('en un contador el recargo se multiplica por las porciones', () => {
      expect(unitPrice(producto(), null, [], [elegida({ price: 1, quantity: 3 })])).toBe(15)
    })

    it('nunca baja de cero por acumular descuentos', () => {
      expect(unitPrice(producto({ priceFrom: 1 }), null, [], [
        elegida({ optionId: 'a', price: -5 }),
      ])).toBe(0)
    })
  })

  describe('identidad de la línea', () => {
    it('mismas opciones repartidas distinto son líneas distintas', () => {
      // «2 lomo + 1 pollo» y «1 lomo + 2 pollo» son dos platos, y sumarlos en
      // una sola línea perdería lo que se pidió.
      const a = lineKey(producto(), null, [], '', [
        elegida({ optionId: 'lomo', quantity: 2 }),
        elegida({ optionId: 'pollo', quantity: 1 }),
      ])
      const b = lineKey(producto(), null, [], '', [
        elegida({ optionId: 'lomo', quantity: 1 }),
        elegida({ optionId: 'pollo', quantity: 2 }),
      ])
      expect(a).not.toBe(b)
    })

    it('el orden en que se eligen no crea otra línea', () => {
      const a = lineKey(producto(), null, [], '', [
        elegida({ optionId: 'x' }), elegida({ optionId: 'y' }),
      ])
      const b = lineKey(producto(), null, [], '', [
        elegida({ optionId: 'y' }), elegida({ optionId: 'x' }),
      ])
      expect(a).toBe(b)
    })
  })

  describe('cuánto se lleva elegido', () => {
    it('cuenta opciones marcadas fuera de los contadores', () => {
      expect(chosenCount(grupo({ selectionType: 'multiple', maxSelectable: 3 }), [
        elegida({ optionId: 'a' }), elegida({ optionId: 'b' }),
      ])).toBe(2)
    })

    it('cuenta porciones en los contadores', () => {
      expect(chosenCount(grupo({ selectionType: 'quantity', maxSelectable: 5 }), [
        elegida({ optionId: 'a', quantity: 2 }), elegida({ optionId: 'b', quantity: 3 }),
      ])).toBe(5)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ESTRATEGIAS DE PRECIO
//
// Los MISMOS ocho casos que ejercitan `server/tests/pricing.test.js` y
// `verificar-esquema.sql` contra PostgreSQL. Son tres motores calculando lo
// mismo —el teléfono, el servidor y la base— y solo la base cobra; si divergen,
// el cliente ve un número y paga otro.
// ═══════════════════════════════════════════════════════════════════════════

describe('cuánto suma un grupo según cómo se cobre', () => {
  // Las tres opciones del caso compartido: 1.00, 2.00 y 4.00.
  const tres = [
    elegida({ optionId: 'a', price: 1 }),
    elegida({ optionId: 'b', price: 2 }),
    elegida({ optionId: 'c', price: 4 }),
  ]

  it.each([
    ['sum', 0, 7],
    ['fixed', 0, 0],
    ['included', 0, 0],
    ['highest_selected', 0, 4],
    ['lowest_selected', 0, 1],
    ['average', 0, 2.33],
    ['included_up_to_limit', 1, 3],
    ['extra_after_limit', 1, 3],
  ] as const)('%s cobra %s', (estrategia, libres, esperado) => {
    expect(groupPrice(estrategia, libres, tres)).toBe(esperado)
  })

  it('un grupo sin nada elegido no suma', () => {
    expect(groupPrice('highest_selected', 0, [])).toBe(0)
  })

  it('descuenta las MÁS caras, no las primeras que se tocaron', () => {
    expect(groupPrice('included_up_to_limit', 1, [...tres].reverse()))
      .toBe(groupPrice('included_up_to_limit', 1, tres))
  })

  it('por opciones y por porciones se diferencian en los contadores', () => {
    const tresBolas = [elegida({ optionId: 'x', price: 4, quantity: 3 })]
    expect(groupPrice('included_up_to_limit', 2, tresBolas)).toBe(0)
    expect(groupPrice('extra_after_limit', 2, tresBolas)).toBe(4)
  })
})

describe('la pizza mitad y mitad en la pantalla', () => {
  // Sin esto el cliente vería $19 al elegir y $10 al confirmar.
  const mitades = grupo({
    id: 'mitades', name: 'Mitades', selectionType: 'multiple',
    maxSelectable: 2, pricingStrategy: 'highest_selected',
    options: [],
  })
  const pizza = producto({ priceFrom: 0, optionGroups: [mitades] })
  const elegidas = [
    elegida({ groupId: 'mitades', optionId: 'suprema', price: 10 }),
    elegida({ groupId: 'mitades', optionId: 'hawaiana', price: 9 }),
  ]

  it('se pinta la más cara, no la suma', () => {
    expect(unitPrice(pizza, null, [], elegidas)).toBe(10)
  })

  it('cada grupo aplica LO SUYO, no una regla común', () => {
    // Mitades por la más cara ($10) + extras que sí suman ($1.50).
    const extras = grupo({ id: 'extras', selectionType: 'multiple', maxSelectable: 3, options: [] })
    const conExtras = producto({ priceFrom: 0, optionGroups: [mitades, extras] })
    expect(unitPrice(conExtras, null, [], [
      ...elegidas,
      elegida({ groupId: 'extras', optionId: 'queso', price: 1.5 }),
    ])).toBe(11.5)
  })

  it('un grupo que ya no está en el catálogo se cobra sumando, como antes', () => {
    expect(unitPrice(producto({ priceFrom: 5, optionGroups: [] }), null, [], [
      elegida({ groupId: 'fantasma', optionId: 'a', price: 1 }),
    ])).toBe(6)
  })
})
