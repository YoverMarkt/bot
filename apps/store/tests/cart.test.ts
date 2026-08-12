import { describe, expect, it } from 'vitest'
import {
  ENTREGA_POR_DEFECTO, addLine, cartCount, cartTotal, chosenCount, groupExtras, groupPrice,
  chosenLines, detalleDeLinea, groupChosen, lineKey, lineTotal, missingRequirement, needsAddress,
  optionPriceLabel, orderTotal, pillLayout, setQuantity, singleChoice, unitPrice,
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
  productType: 'simple',
  priceFrom: 12,
  hasVariants: false,
  variants: [],
  extras: [],
  optionGroups: [],
  recommendations: [],
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

// ═══════════════════════════════════════════════════════════════════════════
// ADICIONALES vs COMPLEMENTOS INCLUIDOS
//
// La distinción que decide el modelo entero:
//   · la bebida de un combo va DENTRO de la línea del combo;
//   · el pan de ajo que se suma al final es OTRA línea del carrito.
//
// Si acabaran juntos, el dueño vería «Pizza (con pan de ajo)» en vez de dos
// cosas que preparar, y el reporte contaría una unidad donde hay dos.
// ═══════════════════════════════════════════════════════════════════════════

describe('un adicional es una línea propia', () => {
  const pan = producto({ id: 'pan', name: 'Pan de ajo', priceFrom: 3 })

  it('no se mezcla con el plato: son dos líneas', () => {
    const carrito = addLine(
      addLine([], linea({ key: lineKey(producto(), null, [], ''), product: producto() })),
      linea({ key: lineKey(pan, null, [], ''), product: pan, unitPrice: 3 }),
    )
    expect(carrito).toHaveLength(2)
    expect(cartCount(carrito)).toBe(2)
  })

  it('el mismo adicional dos veces suma cantidad, no crea otra línea', () => {
    const clave = lineKey(pan, null, [], '')
    const carrito = addLine(
      addLine([], linea({ key: clave, product: pan, unitPrice: 3 })),
      linea({ key: clave, product: pan, unitPrice: 3 }),
    )
    expect(carrito).toHaveLength(1)
    expect(carrito[0].quantity).toBe(2)
  })

  // ── Cómo lo recibe ──────────────────────────────────────────────────────
  //
  // Elegir entrega o retiro pasó de vivir dentro del carrito a decidirse
  // también en la portada. Estas cuatro pruebas son el inventario de lo que
  // esa decisión HACÍA DE PASO cuando estaba escondida en el componente: se
  // conservan los cuatro efectos, y cada uno tiene la suya.

  it('el envío se suma SOLO a domicilio', () => {
    const carrito = [linea({ unitPrice: 7.5 })]
    expect(orderTotal(carrito, 'delivery', 2)).toBe(9.5)
    expect(orderTotal(carrito, 'pickup', 2)).toBe(7.5)
    // Quien come en el local tampoco paga por llevárselo a ningún sitio.
    expect(orderTotal(carrito, 'onsite', 2)).toBe(7.5)
  })

  it('un envío ausente o negativo no descuenta del total', () => {
    const carrito = [linea({ unitPrice: 10 })]
    expect(orderTotal(carrito, 'delivery', 0)).toBe(10)
    // Un valor corrupto en la base no puede abaratar el pedido en pantalla.
    expect(orderTotal(carrito, 'delivery', -5)).toBe(10)
  })

  it('solo a domicilio se piden datos de dirección', () => {
    expect(needsAddress('delivery')).toBe(true)
    expect(needsAddress('pickup')).toBe(false)
    expect(needsAddress('onsite')).toBe(false)
  })

  it('arranca a domicilio, que es lo que quiere casi todo el mundo', () => {
    expect(ENTREGA_POR_DEFECTO).toBe('delivery')
    // Y el defecto tiene que ser uno de los modos que piden dirección, o el
    // checkout arrancaría sin pedirla y el pedido saldría sin a dónde ir.
    expect(needsAddress(ENTREGA_POR_DEFECTO)).toBe(true)
  })

  it('el total con envío redondea a centavos, sin arrastrar decimales', () => {
    // 0.1 + 0.2 en coma flotante da 0.30000000000000004: pintado son «$0.30»,
    // pero comparado con el importe del servidor sería otro número.
    const carrito = [linea({ unitPrice: 0.1 })]
    expect(orderTotal(carrito, 'delivery', 0.2)).toBe(0.3)
  })

  // ── Elegir UNA sola ─────────────────────────────────────────────────────
  //
  // Los 19 sabores de pizza estaban guardados como `multiple` con máximo 1:
  // la base solo dejaba elegir uno, pero la ficha los pintaba con casillas.
  // El cliente marcaba un sabor y no entendía por qué no podía marcar otro.

  it('un grupo con máximo 1 es elección única, aunque sea «multiple»', () => {
    expect(singleChoice(grupo({ selectionType: 'single', maxSelectable: 1 }))).toBe(true)
    // El caso real de los sabores.
    expect(singleChoice(grupo({ selectionType: 'multiple', maxSelectable: 1 }))).toBe(true)
  })

  it('un grupo que admite varias NO es elección única', () => {
    expect(singleChoice(grupo({ selectionType: 'multiple', maxSelectable: 7 }))).toBe(false)
    // Un contador nunca es un radio: se eligen porciones, no una opción.
    expect(singleChoice(grupo({ selectionType: 'quantity', maxSelectable: 1 }))).toBe(false)
    expect(singleChoice(grupo({ selectionType: 'quantity', maxSelectable: 4 }))).toBe(false)
  })

  // ── Lo que se escribe donde iría el precio ──────────────────────────────

  it('un complemento del combo dice «Incluida», no «$0.00»', () => {
    const combo = grupo({ pricingStrategy: 'included' })
    expect(optionPriceLabel(combo, 0)).toEqual({ incluida: true })
    // Y la mejora del MISMO grupo sigue mostrando su recargo.
    expect(optionPriceLabel(combo, 1.5)).toEqual({ incluida: false, amount: 1.5 })
  })

  it('un cero en un grupo normal NO dice «Incluida»', () => {
    // «Sin borde $0.00» no viene incluido en nada: simplemente no añade.
    expect(optionPriceLabel(grupo({ pricingStrategy: 'sum' }), 0)).toBe(null)
  })

  it('un recargo negativo se conserva con su signo', () => {
    // «Sin sopa −$0.50» es un caso real de los almuerzos.
    expect(optionPriceLabel(grupo(), -0.5)).toEqual({ incluida: false, amount: -0.5 })
  })

  // ── Lo que se descubrió revisando ───────────────────────────────────────

  it('un grupo OPCIONAL de una sola opción se puede desmarcar', () => {
    // Regresión encontrada en la revisión: al pasar de casilla a radio, un
    // «Borde mozzarella +$4.99» opcional se quedaba puesto para siempre. El
    // comportamiento vive en ProductSheet, pero la regla que lo decide es esta.
    const opcional = grupo({
      selectionType: 'multiple', maxSelectable: 1, required: false, minSelectable: 0,
    })
    expect(singleChoice(opcional)).toBe(true)
    expect(opcional.required || opcional.minSelectable > 0).toBe(false)

    // En uno obligatorio no se puede deshacer: quedaría sin cumplir.
    const obligatorio = grupo({ selectionType: 'single', required: true, minSelectable: 1 })
    expect(obligatorio.required || obligatorio.minSelectable > 0).toBe(true)
  })

  // ── Píldoras o lista ────────────────────────────────────────────────────

  const opcionesDe = (...nombres: string[]) => nombres.map((name, i) => ({
    id: `o${i}`, name, description: null, imageUrl: null,
    price: 0, referencesProductId: null, defaultSelected: false,
  }))

  it('un grupo corto de elección única se pinta en píldoras', () => {
    expect(pillLayout(grupo({
      selectionType: 'single', maxSelectable: 1,
      options: opcionesDe('Tradicional', 'Delgada', 'Pan Pizza'),
    }))).toBe(true)
  })

  it('19 sabores NUNCA caben en píldoras', () => {
    // El caso que motivó los topes: una fila con 19 no se puede leer.
    expect(pillLayout(grupo({
      selectionType: 'multiple', maxSelectable: 1,
      options: opcionesDe(...Array.from({ length: 19 }, (_, i) => `S${i}`)),
    }))).toBe(false)
  })

  it('un grupo INCLUIDO no va en píldoras: la palabra «Incluida» no cabe', () => {
    // Se descubrió probándolo: la bebida del combo entraba en píldoras y
    // perdía el «Incluida», así que parecía una opción que quizá te cobran.
    expect(pillLayout(grupo({
      selectionType: 'single', maxSelectable: 1, pricingStrategy: 'included',
      options: opcionesDe('Cola 1L', 'Cola 2L'),
    }))).toBe(false)
    expect(pillLayout(grupo({
      selectionType: 'single', maxSelectable: 1, pricingStrategy: 'included_up_to_limit',
      options: opcionesDe('Cola 1L', 'Cola 2L'),
    }))).toBe(false)
  })

  it('no usa píldoras si el nombre es largo, o si hay foto o descripción', () => {
    const base = { selectionType: 'single' as const, maxSelectable: 1 }
    expect(pillLayout(grupo({ ...base, options: opcionesDe('Pizza cuatro quesos artesanal') }))).toBe(false)
    // En un combo la foto es justo lo que ayuda a elegir: no cabe en píldora.
    expect(pillLayout(grupo({
      ...base,
      options: [{ ...opcionesDe('Pepsi')[0], imageUrl: 'https://cdn/p.jpg' }],
    }))).toBe(false)
    expect(pillLayout(grupo({
      ...base,
      options: [{ ...opcionesDe('Pepsi')[0], description: '1 litro' }],
    }))).toBe(false)
    // Y un grupo que admite varias tampoco.
    expect(pillLayout(grupo({
      selectionType: 'multiple', maxSelectable: 3, options: opcionesDe('A', 'B'),
    }))).toBe(false)
  })

  // Un complemento INCLUIDO sí va dentro: es lo que distingue los dos caminos.
  it('un complemento incluido NO crea línea: viaja dentro del plato', () => {
    const combo = producto({
      id: 'combo',
      optionGroups: [grupo({ id: 'beb', name: 'Bebida', pricingStrategy: 'included' })],
    })
    const carrito = addLine([], linea({
      key: lineKey(combo, null, [], '', [elegida({ groupId: 'beb', optionId: 'cola' })]),
      product: combo,
      options: [elegida({ groupId: 'beb', optionId: 'cola', name: 'Coca Cola' })],
    }))

    expect(carrito).toHaveLength(1)
    expect(carrito[0].options[0].name).toBe('Coca Cola')
  })
})

// ── El orden en que se lee lo elegido ──────────────────────────────────────
//
// Una pizza se piensa en un orden: sabor, masa, borde, y al final lo que se
// agrega y cuesta aparte. Ese orden lo pone el dueño en su panel y llega en el
// catálogo; el carrito tiene que respetarlo porque es el MISMO en que el
// cliente acaba de armar el plato en la ficha. Ordenarlo distinto le obliga a
// releer de arriba abajo para comprobar lo que eligió.

describe('groupChosen', () => {
  const elegida = (groupName: string, name: string, quantity = 1): ChosenOption => ({
    groupId: groupName.toLowerCase(), groupName, optionId: name, name, price: 0, quantity,
  })
  const grupo = (name: string): OptionGroup => ({
    id: name.toLowerCase(), name, description: null, selectionType: 'single',
    pricingStrategy: 'sum', freeSelections: 0, required: false,
    minSelectable: 0, maxSelectable: 1, options: [],
  })

  it('respeta el orden del catálogo, no el alfabeto', () => {
    const grupos = groupChosen(
      [elegida('Borde', 'Sin borde'), elegida('Sabor', 'Criolla'), elegida('Masa', 'Delgada')],
      [grupo('Sabor'), grupo('Masa'), grupo('Borde')],
    )
    expect(grupos.map(g => g.group)).toEqual(['Sabor', 'Masa', 'Borde'])
  })

  it('sin catálogo cae al alfabeto en vez de barajar', () => {
    const grupos = groupChosen([elegida('Sabor', 'Criolla'), elegida('Borde', 'Sin borde')])
    expect(grupos.map(g => g.group)).toEqual(['Borde', 'Sabor'])
  })

  it('un grupo que ya no está en el catálogo va al final, no desaparece', () => {
    // El dueño puede borrar un grupo con el carrito abierto. Lo que el cliente
    // eligió sigue en su carrito y tiene que seguir viéndose.
    const grupos = groupChosen(
      [elegida('Retirado', 'Algo'), elegida('Sabor', 'Criolla')],
      [grupo('Sabor')],
    )
    expect(grupos.map(g => g.group)).toEqual(['Sabor', 'Retirado'])
  })

  it('la mitad y mitad sale como dos sabores del mismo grupo', () => {
    const grupos = groupChosen(
      [elegida('Sabor', 'Monster'), elegida('Sabor', 'Carnívora')],
      [grupo('Sabor')],
    )
    expect(grupos).toEqual([{
      group: 'Sabor',
      items: [{ name: 'Carnívora', quantity: 1 }, { name: 'Monster', quantity: 1 }],
    }])
  })

  it('el x1 no se dice; la cantidad de verdad sí', () => {
    expect(chosenLines([elegida('Cortes', 'Chuleta', 3), elegida('Cortes', 'Chorizo')]))
      .toEqual(['Cortes: Chorizo, Chuleta x3'])
  })

  it('lo que no se puede nombrar se ignora en vez de pintarse a medias', () => {
    expect(groupChosen([
      { ...elegida('', 'Huérfana') },
      { ...elegida('Masa', '  ') },
      elegida('Masa', 'Delgada'),
    ])).toEqual([{ group: 'Masa', items: [{ name: 'Delgada', quantity: 1 }] }])
  })
})

// ── Qué dice cada línea del carrito ────────────────────────────────────────
//
// El carrito es la última pantalla antes de pagar. Una línea que solo dice
// «Burger Pack $10.99» no le cuenta a nadie que son dos hamburguesas dobles,
// una salchipapa y una cola de 1.35 litros: el cliente confirma a ciegas.

describe('detalleDeLinea', () => {
  const linea = (extra: Partial<CartLine> = {}): CartLine => ({
    key: 'k', product: producto(), variant: null, extras: [], options: [],
    quantity: 1, note: '', unitPrice: 10, ...extra,
  })

  it('en un combo enseña la descripción, que es lo que dice qué lleva', () => {
    expect(detalleDeLinea(linea({
      product: producto({
        description: '2 Cheese Burger dobles + 1 salchipapa + 1 cola de 1.35 Lt',
        optionGroups: [],
      }),
    }))).toEqual(['2 Cheese Burger dobles + 1 salchipapa + 1 cola de 1.35 Lt'])
  })

  // «Elige tamaño y sabor» es la descripción de la pizza en el catálogo, y
  // después de elegir no sirve de nada: lo que importa es qué eligió.
  it('si eligió algo, manda lo elegido y no la descripción', () => {
    const salida = detalleDeLinea(linea({
      product: producto({ description: 'Elige tamaño y sabor. 19 sabores.' }),
      options: [{
        groupId: 'g1', groupName: 'Sabor', optionId: 'o1',
        name: 'Criolla', price: 0, quantity: 1,
      }],
    }))
    expect(salida).toEqual(['Sabor: Criolla'])
    expect(salida.join(' ')).not.toContain('Elige tamaño')
  })

  it('sin opciones pero con extras, enseña los extras', () => {
    expect(detalleDeLinea(linea({
      product: producto({ description: 'Algo', optionGroups: [] }),
      extras: [{
        id: 'e1', group: 'Extras', name: 'Extra queso',
        description: null, price: 1.5, maxSelectable: null,
      }],
    }))).toEqual(['Extra queso'])
  })

  it('un producto sin nada que contar no inventa una línea vacía', () => {
    expect(detalleDeLinea(linea({
      product: producto({ description: null, optionGroups: [] }),
    }))).toEqual([])
    expect(detalleDeLinea(linea({
      product: producto({ description: '   ', optionGroups: [] }),
    }))).toEqual([])
  })
})
