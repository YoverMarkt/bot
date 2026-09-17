import { describe, expect, it } from 'vitest'
import {
  addLine,
  cartCount,
  claveDelPlato,
  detalleDeLinea,
  esPlatoPorPartes,
  gratisDelGrupo,
  lineasDelPlato,
  topeDeLaOpcion,
  totalDelPlato,
} from '../src/lib/cart'
import type { CartLine, ChosenOption, OptionChoice, OptionGroup, Product } from '../src/lib/types'

// ═══════════════════════════════════════════════════════════════════════════
// EL PLATO POR PARTES, en el teléfono
// ═══════════════════════════════════════════════════════════════════════════
//
// La familia marca cuántas sopas y segundos quiere y la ficha le enseña, antes
// de agregar, cuántos almuerzos son y cuánto cuestan. Cobra la base
// (`lineas_del_plato_por_partes`); esto solo pinta. Por eso son LOS MISMOS
// casos que `server/tests/plato-por-partes.test.js`: si la pantalla dijera
// otra cosa, la familia leería un número y pagaría otro.

const opcion = (id: string, name: string, price = 0): OptionChoice => ({
  id, name, price, description: null, imageUrl: null, referencesProductId: null, defaultSelected: false,
})

const grupo = (extra: Partial<OptionGroup> & Pick<OptionGroup, 'id' | 'name'>): OptionGroup => ({
  description: null,
  selectionType: 'quantity',
  pricingStrategy: 'sum',
  freeSelections: 0,
  required: false,
  minSelectable: 0,
  maxSelectable: 100,
  options: [],
  ...extra,
})

const SOPA = grupo({
  id: 'g-sopa', name: 'Sopa', isMealPart: true, loosePrice: 1.5,
  options: [opcion('o-caldo', 'Caldo de res'), opcion('o-crema', 'Crema de zapallo')],
})
const SEGUNDO = grupo({
  id: 'g-segundo', name: 'Segundo', isMealPart: true, loosePrice: 2.5,
  options: [opcion('o-pollo', 'Pollo'), opcion('o-ceviche', 'Ceviche')],
})
const ACOMPANAR = grupo({
  id: 'g-acompanar', name: 'Para acompañar', isMealPart: false, loosePrice: null,
  options: [opcion('o-jugo', 'Jugo'), opcion('o-carne', 'Porción de carne', 0.5)],
})

const almuerzo = (extra: Partial<Product> = {}): Product => ({
  id: 'alm',
  name: 'Almuerzo del día',
  description: null,
  imageUrl: null,
  videoUrl: null,
  categoryId: null,
  tags: [],
  available: true,
  productType: 'daily_menu',
  priceFrom: 3,
  hasVariants: false,
  variants: [],
  extras: [],
  optionGroups: [SOPA, SEGUNDO, ACOMPANAR],
  recommendations: [],
  ...extra,
})

const elegir = (de: OptionGroup, optionId: string, quantity: number): ChosenOption => {
  const encontrada = de.options.find(item => item.id === optionId)
  if (!encontrada) throw new Error(`no existe ${optionId}`)
  return {
    groupId: de.id, groupName: de.name, optionId, name: encontrada.name, price: encontrada.price, quantity,
  }
}

const FAMILIA = [
  elegir(SEGUNDO, 'o-ceviche', 1),
  elegir(SOPA, 'o-caldo', 2),
  elegir(SEGUNDO, 'o-pollo', 2),
  elegir(ACOMPANAR, 'o-jugo', 3),
  elegir(ACOMPANAR, 'o-carne', 1),
]

const mesa = (options: ChosenOption[], producto = almuerzo()): CartLine => {
  const plato = lineasDelPlato(producto, options)
  return {
    key: claveDelPlato(producto),
    product: producto,
    variant: null,
    extras: [],
    options,
    quantity: 1,
    note: '',
    unitPrice: plato.lines ? totalDelPlato(plato.lines) : 0,
  }
}

describe('las partes forman almuerzos, igual que en la base', () => {
  it('la familia: 2 almuerzos, un segundo suelto y la carne aparte', () => {
    const plato = lineasDelPlato(almuerzo(), FAMILIA)
    expect(plato.error).toBeUndefined()
    expect(plato.lines?.map(l => [l.name, l.quantity, l.unitPrice])).toEqual([
      ['Almuerzo del día', 2, 3],
      ['Solo segundo', 1, 2.5],
      ['Porción de carne', 1, 0.5],
    ])
    expect(plato.lines?.[0].options.map(o => [o.name, o.quantity])).toEqual([
      ['Caldo de res', 2], ['Pollo', 2], ['Jugo', 3],
    ])
    expect(plato.lines?.[1].options.map(o => [o.name, o.quantity])).toEqual([['Ceviche', 1]])
    expect(plato.platos).toBe(3)
    expect(totalDelPlato(plato.lines ?? [])).toBe(9)
  })

  it('el almuerzo vale lo que pone el dueño, aunque las partes sueltas sumen menos', () => {
    const barato = almuerzo({
      priceFrom: 5,
      optionGroups: [{ ...SOPA, loosePrice: 0.5 }, { ...SEGUNDO, loosePrice: 0.5 }],
    })
    const plato = lineasDelPlato(barato, [elegir(SOPA, 'o-caldo', 1), elegir(SEGUNDO, 'o-pollo', 1)])
    expect(plato.lines?.map(l => [l.name, l.quantity, l.unitPrice])).toEqual([['Almuerzo del día', 1, 5]])
  })

  it('solo una sopa: se cobra suelta y lo gratis la acompaña', () => {
    const plato = lineasDelPlato(almuerzo(), [elegir(SOPA, 'o-caldo', 1), elegir(ACOMPANAR, 'o-jugo', 1)])
    expect(plato.lines?.map(l => [l.name, l.quantity, l.unitPrice, l.options.length])).toEqual([
      ['Solo sopa', 1, 1.5, 2],
    ])
  })

  it('dice lo mismo que la base cuando no se puede', () => {
    const sinSuelta = almuerzo({ optionGroups: [{ ...SOPA, loosePrice: null }, SEGUNDO, ACOMPANAR] })
    expect(lineasDelPlato(sinSuelta, [elegir(SOPA, 'o-caldo', 2), elegir(SEGUNDO, 'o-pollo', 1)]).error)
      .toBe('En Almuerzo del día no se vende sopa por separado: completa el plato')
    expect(lineasDelPlato(almuerzo(), [elegir(ACOMPANAR, 'o-jugo', 2)]).error)
      .toBe('Elige qué quieres en Almuerzo del día')
  })

  it('reconoce el plato por sus partes, no por el tipo de comida', () => {
    expect(esPlatoPorPartes(almuerzo())).toBe(true)
    expect(esPlatoPorPartes(almuerzo({ optionGroups: [ACOMPANAR] }))).toBe(false)
  })
})

describe('la mesa en el carrito', () => {
  it('volver a agregarla la SUSTITUYE: la base solo acepta la mesa en una línea', () => {
    const antes = [mesa([elegir(SOPA, 'o-caldo', 1), elegir(SEGUNDO, 'o-pollo', 1)])]
    const despues = addLine(antes, mesa(FAMILIA))
    expect(despues).toHaveLength(1)
    expect(despues[0].quantity).toBe(1)
    expect(despues[0].unitPrice).toBe(9)
  })

  it('cuenta platos, no líneas: una familia no es «1»', () => {
    const cinco = mesa([elegir(SOPA, 'o-caldo', 5), elegir(SEGUNDO, 'o-pollo', 4)])
    const cola: CartLine = { ...cinco, key: 'cola', product: almuerzo({ id: 'cola', optionGroups: [] }), quantity: 2 }
    // 4 almuerzos + 1 sopa sola, más 2 colas.
    expect(cartCount([cinco, cola])).toBe(7)
  })

  it('el detalle se lee por platos, como lo va a guardar la base', () => {
    // Lo elegido del almuerzo va en renglones: en una sola frase el carrito la
    // cortaba a dos líneas y se perdía qué jugo iba.
    expect(detalleDeLinea(mesa(FAMILIA))).toEqual([
      '2 × Almuerzo del día',
      'Sopa: Caldo de res x2',
      'Segundo: Pollo x2',
      'Para acompañar: Jugo x3',
      '1 × Solo segundo: Ceviche',
      '1 × Porción de carne',
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE VA GRATIS, VA POR PLATO
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo encontró el dueño mirando su propio local (2026-09-16): «el jugo que va
// gratis es por el número de almuerzos que lleva el cliente, pero ahora pueden
// elegir muchos jugos gratis».
//
// Era cierto en las TRES capas que arman el plato —esta, `pricing.ts` y la
// función de la base—: Sopa y Segundo sí se topaban por ser partes, pero la
// bebida no es parte y caía en «acompañantes gratis» sin ningún límite. El
// único freno era `maxSelectable` del grupo, que en su local valía 100.
//
// La regla, con sus palabras: «2 almuerzos completos, 2 jugos; 2 almuerzos y un
// segundo, 3 jugos». O sea platos = completos + partes sueltas, que es la
// cuenta que este archivo ya hacía para partir las líneas.

describe('lo gratis va por plato, no a discreción', () => {
  it('un plato y cinco jugos gratis se rechaza', () => {
    const plato = lineasDelPlato(almuerzo(), [
      elegir(SOPA, 'o-caldo', 1),
      elegir(SEGUNDO, 'o-pollo', 1),
      elegir(ACOMPANAR, 'o-jugo', 5),
    ])
    expect(plato.error).toContain('va con cada plato')
    expect(plato.error).toContain('llevas 1')
  })

  it('dos almuerzos completos llevan dos jugos, y no un tercero', () => {
    const dos = [elegir(SOPA, 'o-caldo', 2), elegir(SEGUNDO, 'o-pollo', 2)]
    expect(lineasDelPlato(almuerzo(), [...dos, elegir(ACOMPANAR, 'o-jugo', 2)]).error)
      .toBeUndefined()
    expect(lineasDelPlato(almuerzo(), [...dos, elegir(ACOMPANAR, 'o-jugo', 3)]).error)
      .toContain('va con cada plato')
  })

  it('«2 almuerzos y un segundo» son TRES platos y caben tres jugos', () => {
    // El ejemplo literal del dueño. La parte suelta también lleva el suyo.
    const plato = lineasDelPlato(almuerzo(), [
      elegir(SOPA, 'o-caldo', 2),
      elegir(SEGUNDO, 'o-pollo', 3),
      elegir(ACOMPANAR, 'o-jugo', 3),
    ])
    expect(plato.error).toBeUndefined()
  })

  it('lo que se COBRA no tiene tope: cinco porciones de carne se pagan', () => {
    // ⚠️ Deliberado. El tope existe para que no se regale de más, no para
    // impedir que alguien compre. Cada porción suma a su precio.
    const plato = lineasDelPlato(almuerzo(), [
      elegir(SOPA, 'o-caldo', 1),
      elegir(SEGUNDO, 'o-pollo', 1),
      elegir(ACOMPANAR, 'o-carne', 5),
    ])
    expect(plato.error).toBeUndefined()
    expect(plato.lines?.find(l => l.name === 'Porción de carne')?.quantity).toBe(5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA FICHA NO DEJA MARCAR LO QUE EL CARRITO VA A RECHAZAR (2026-09-17)
// ═══════════════════════════════════════════════════════════════════════════
//
// Caso real de La Abuelita: un almuerzo y el contador de «Naranjilla» subió
// hasta 10. Abajo decía «llevas 1 y marcaste 11», pero la pantalla lo dejaba.
// La ficha solo topaba un grupo si TODAS sus opciones eran gratis, y el dueño
// había añadido «Sandía +$0.55» a las bebidas. El carrito y la base topan
// opción por opción (solo las gratis), así que pantalla y cobro no coincidían.
//
// Y lo que pidió el dueño además: lo gratis no se ofrece hasta que haya un
// plato. Primero la sopa o el segundo, luego el jugo.

describe('hasta cuánto deja subir la ficha cada opción', () => {
  const unAlmuerzo = [elegir(SOPA, 'o-caldo', 1), elegir(SEGUNDO, 'o-pollo', 1)]

  it('un almuerzo, un jugo gratis: el contador se planta en 1 aunque el grupo tenga algo con precio', () => {
    expect(topeDeLaOpcion(almuerzo(), ACOMPANAR, 'o-jugo', unAlmuerzo)).toBe(1)
    const conJugo = [...unAlmuerzo, elegir(ACOMPANAR, 'o-jugo', 1)]
    expect(topeDeLaOpcion(almuerzo(), ACOMPANAR, 'o-jugo', conJugo)).toBe(1)
  })

  it('los gratis se reparten entre sabores: 3 platos, 2 de mora dejan 1 de naranjilla', () => {
    const conMora = grupo({
      ...ACOMPANAR,
      options: [...ACOMPANAR.options, opcion('o-naranjilla', 'Naranjilla')],
    })
    const tres = [
      elegir(SOPA, 'o-caldo', 2), elegir(SEGUNDO, 'o-pollo', 3),
      elegir(conMora, 'o-jugo', 2),
    ]
    expect(topeDeLaOpcion(almuerzo({ optionGroups: [SOPA, SEGUNDO, conMora] }), conMora, 'o-naranjilla', tres))
      .toBe(1)
  })

  it('lo que tiene precio no se topa por platos: se paga', () => {
    const conJugo = [...unAlmuerzo, elegir(ACOMPANAR, 'o-jugo', 1)]
    // 100 del grupo menos el jugo que ya va.
    expect(topeDeLaOpcion(almuerzo(), ACOMPANAR, 'o-carne', conJugo)).toBe(99)
  })

  it('sin un plato elegido, lo que acompaña está cerrado — con precio o sin él', () => {
    expect(topeDeLaOpcion(almuerzo(), ACOMPANAR, 'o-jugo', [])).toBe(0)
    expect(topeDeLaOpcion(almuerzo(), ACOMPANAR, 'o-carne', [])).toBe(0)
    // Una parte suelta ya es un plato: abre el jugo.
    expect(topeDeLaOpcion(almuerzo(), ACOMPANAR, 'o-jugo', [elegir(SEGUNDO, 'o-pollo', 1)])).toBe(1)
  })

  it('las partes no se topan por platos: la familia lleva las que quiera', () => {
    expect(topeDeLaOpcion(almuerzo(), SOPA, 'o-caldo', [elegir(SOPA, 'o-crema', 4)])).toBe(96)
  })

  it('la cabecera cuenta SOLO los gratis contra los platos', () => {
    const mesaDeDos = [
      elegir(SOPA, 'o-caldo', 2), elegir(SEGUNDO, 'o-pollo', 2),
      elegir(ACOMPANAR, 'o-jugo', 1), elegir(ACOMPANAR, 'o-carne', 3),
    ]
    expect(gratisDelGrupo(almuerzo(), ACOMPANAR, mesaDeDos)).toEqual({ platos: 2, usadas: 1 })
    expect(gratisDelGrupo(almuerzo(), SOPA, mesaDeDos)).toBeNull()
  })
})

