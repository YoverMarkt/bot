import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applyPricingStrategy, calculateProductPrice } = require('../dist/services/pricing')

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE PRECIOS
// ═══════════════════════════════════════════════════════════════════════════
//
// Los MISMOS casos que ejercita `verificar-esquema.sql` contra PostgreSQL, a
// propósito: la app pinta con este motor y la base cobra con el suyo, así que
// si divergen el cliente ve un número y paga otro.
//
// El caso central es la pizza mitad y mitad: con `sum`, media Suprema ($10) y
// media Hawaiana ($9) costarían $19 —el doble de una pizza entera—.

/** Las tres opciones del caso compartido: 1.00, 2.00 y 4.00. */
const TRES = [
  { price: 1, quantity: 1 },
  { price: 2, quantity: 1 },
  { price: 4, quantity: 1 },
]

const conEstrategia = (strategy, freeSelections = 0, selections = TRES) =>
  applyPricingStrategy({ strategy, freeSelections, selections })

describe('las ocho estrategias', () => {
  // Estos siete números son los mismos que comprueba el SQL. Si alguien cambia
  // uno de los dos lados, uno de los dos guardianes se pone en rojo.
  it.each([
    ['sum', 7],
    ['fixed', 0],
    ['included', 0],
    ['highest_selected', 4],
    ['lowest_selected', 1],
    ['average', 2.33],
    ['included_up_to_limit', 3],
    ['extra_after_limit', 3],
  ])('%s cobra %s sobre 1.00, 2.00 y 4.00', (estrategia, esperado) => {
    const libres = ['included_up_to_limit', 'extra_after_limit'].includes(estrategia) ? 1 : 0
    expect(conEstrategia(estrategia, libres)).toBe(esperado)
  })

  it('un grupo sin nada elegido no suma nada, sea cual sea la estrategia', () => {
    for (const estrategia of ['sum', 'highest_selected', 'average', 'included_up_to_limit']) {
      expect(conEstrategia(estrategia, 1, []), estrategia).toBe(0)
    }
  })

  it('una estrategia desconocida se comporta como sum, no revienta', () => {
    expect(conEstrategia('lo_que_sea')).toBe(7)
  })
})

describe('la pizza mitad y mitad', () => {
  // La razón entera de que exista este motor.
  const suprema = { price: 10, quantity: 1 }
  const hawaiana = { price: 9, quantity: 1 }

  it('sumando costaría el doble de una pizza', () => {
    expect(conEstrategia('sum', 0, [suprema, hawaiana])).toBe(19)
  })

  it('cobrando la más cara cuesta lo que la Suprema', () => {
    expect(conEstrategia('highest_selected', 0, [suprema, hawaiana])).toBe(10)
  })

  it('el orden en que se eligen las mitades no cambia el precio', () => {
    expect(conEstrategia('highest_selected', 0, [hawaiana, suprema]))
      .toBe(conEstrategia('highest_selected', 0, [suprema, hawaiana]))
  })

  // Multiplicar por la cantidad devolvería a cobrar el doble por otra puerta.
  it('mira el precio unitario, no el total', () => {
    expect(conEstrategia('highest_selected', 0, [
      { price: 10, quantity: 3 },
      { price: 9, quantity: 1 },
    ])).toBe(10)
  })
})

describe('las estrategias con límite', () => {
  // Si dependiera del orden de clic, dos clientes con lo mismo en el carrito
  // pagarían distinto.
  it('descuenta las MÁS CARAS, no las primeras que se tocaron', () => {
    const alDerecho = conEstrategia('included_up_to_limit', 1, TRES)
    const alRevés = conEstrategia('included_up_to_limit', 1, [...TRES].reverse())
    expect(alDerecho).toBe(3)   // se incluye la de 4.00; se cobran 1 + 2
    expect(alRevés).toBe(alDerecho)
  })

  it('con el límite en cero cobra todo', () => {
    expect(conEstrategia('included_up_to_limit', 0)).toBe(7)
  })

  it('si el límite cubre todo, no cobra nada', () => {
    expect(conEstrategia('included_up_to_limit', 5)).toBe(0)
  })

  // La única diferencia entre las dos, y solo se ve en los contadores.
  it('included_up_to_limit cuenta OPCIONES y extra_after_limit PORCIONES', () => {
    const tresBolasDelMismoSabor = [{ price: 4, quantity: 3 }]

    // Por opciones: la única opción entra en el cupo, así que va entera gratis.
    expect(conEstrategia('included_up_to_limit', 2, tresBolasDelMismoSabor)).toBe(0)
    // Por porciones: dos bolas incluidas, la tercera se cobra.
    expect(conEstrategia('extra_after_limit', 2, tresBolasDelMismoSabor)).toBe(4)
  })

  it('el cupo por porciones se reparte de la más cara a la más barata', () => {
    // Cupo 2: se lleva las dos de 5.00. Quedan la tercera de 5.00 y la de 1.00.
    expect(conEstrategia('extra_after_limit', 2, [
      { price: 5, quantity: 3 },
      { price: 1, quantity: 1 },
    ])).toBe(6)
  })
})

describe('recargos negativos', () => {
  // «Sin sopa −0.50» es un caso real, no un error.
  it('un recargo negativo resta', () => {
    expect(conEstrategia('sum', 0, [{ price: -0.5, quantity: 1 }])).toBe(-0.5)
  })

  it('con la más cara gana la menos negativa', () => {
    expect(conEstrategia('highest_selected', 0, [
      { price: -0.5, quantity: 1 },
      { price: -2, quantity: 1 },
    ])).toBe(-0.5)
  })
})

describe('precio del producto configurado', () => {
  it('suma la base y lo que aporte cada grupo con SU estrategia', () => {
    expect(calculateProductPrice({
      basePrice: 12,
      groups: [
        { strategy: 'highest_selected', selections: [{ price: 10, quantity: 1 }, { price: 9, quantity: 1 }] },
        { strategy: 'sum', selections: [{ price: 1.5, quantity: 2 }] },
        { strategy: 'included', selections: [{ price: 99, quantity: 1 }] },
      ],
    })).toBe(25)
  })

  it('sin grupos es el precio base', () => {
    expect(calculateProductPrice({ basePrice: 8.5, groups: [] })).toBe(8.5)
  })

  // Acumular descuentos no puede regalar el plato; la base lo rechaza también.
  it('nunca baja de cero', () => {
    expect(calculateProductPrice({
      basePrice: 1,
      groups: [{ strategy: 'sum', selections: [{ price: -5, quantity: 1 }] }],
    })).toBe(0)
  })

  it('redondea a centavos y no arrastra decimales', () => {
    expect(calculateProductPrice({
      basePrice: 0.1,
      groups: [{ strategy: 'sum', selections: [{ price: 0.2, quantity: 1 }] }],
    })).toBe(0.3)
  })
})
