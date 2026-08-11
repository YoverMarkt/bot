import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  agruparOpciones, detalleEnTexto, grupoEnTexto, opcionEnTexto,
} = require('../dist/services/order-detail')

// Lo que se prueba aquí es que el cliente y la cocina lean lo MISMO y lo lean
// entero. La lista plana de antes no era solo fea: «Sin ají» (un retiro) y
// «Extra queso» (un añadido) salían idénticos, y «Cheese Burguer» —un sabor de
// pizza— parecía una hamburguesa pedida aparte.

/** La pizza real del pedido #34 de producción, tal como la guardó la base. */
const PIZZA_34 = [
  { option_group_name: 'Masa', option_name: 'Tradicional', quantity: 1 },
  { option_group_name: 'Borde', option_name: 'Sin borde', quantity: 1 },
  { option_group_name: 'Extras', option_name: 'Extra queso', quantity: 1 },
  { option_group_name: 'Retira ingredientes', option_name: 'Sin ají', quantity: 1 },
  { option_group_name: 'Sabor', option_name: 'Cheese Burguer', quantity: 1 },
]

describe('agruparOpciones', () => {
  it('junta cada opción bajo su grupo', () => {
    expect(agruparOpciones(PIZZA_34)).toEqual([
      { group: 'Borde', items: [{ name: 'Sin borde', quantity: 1 }] },
      { group: 'Extras', items: [{ name: 'Extra queso', quantity: 1 }] },
      { group: 'Masa', items: [{ name: 'Tradicional', quantity: 1 }] },
      { group: 'Retira ingredientes', items: [{ name: 'Sin ají', quantity: 1 }] },
      { group: 'Sabor', items: [{ name: 'Cheese Burguer', quantity: 1 }] },
    ])
  })

  it('la mitad y mitad sale como dos sabores del MISMO grupo', () => {
    // Es lo que hacía ilegible la lista plana: «Criolla · Desgranada» no decía
    // que fueran las dos mitades de una pizza.
    const grupos = agruparOpciones([
      { option_group_name: 'Sabor', option_name: 'Desgranada', quantity: 1 },
      { option_group_name: 'Sabor', option_name: 'Criolla', quantity: 1 },
      { option_group_name: 'Masa', option_name: 'Tradicional', quantity: 1 },
    ])
    expect(grupos).toHaveLength(2)
    expect(grupoEnTexto(grupos[1])).toBe('Sabor: Criolla, Desgranada')
  })

  // Sin orden propio, el mismo plato saldría barajado de un pedido a otro: las
  // filas se insertan en una sola sentencia y comparten `created_at`, así que
  // no hay ningún orden guardado del que fiarse.
  it('el orden no depende de en qué orden tocó el cliente', () => {
    const alDerecho = agruparOpciones(PIZZA_34)
    const alRevés = agruparOpciones([...PIZZA_34].reverse())
    expect(alRevés).toEqual(alDerecho)
  })

  it('cuenta las porciones de los contadores', () => {
    const grupos = agruparOpciones([
      { option_group_name: 'Cortes', option_name: 'Chuleta', quantity: 3 },
      { option_group_name: 'Cortes', option_name: 'Chorizo', quantity: 1 },
    ])
    expect(grupoEnTexto(grupos[0])).toBe('Cortes: Chorizo, Chuleta x3')
  })

  it('lo que no se puede nombrar se ignora, no se pinta a medias', () => {
    // Pintar «: algo» o «Grupo: » sería peor que callarlo.
    expect(agruparOpciones([
      { option_group_name: '', option_name: 'Huérfana', quantity: 1 },
      { option_group_name: 'Masa', option_name: '  ', quantity: 1 },
      { option_group_name: 'Masa', option_name: 'Delgada', quantity: 1 },
    ])).toEqual([{ group: 'Masa', items: [{ name: 'Delgada', quantity: 1 }] }])
  })

  it('no se cae con nulos ni con nada', () => {
    expect(agruparOpciones(null)).toEqual([])
    expect(agruparOpciones(undefined)).toEqual([])
    expect(agruparOpciones([])).toEqual([])
  })

  it('una cantidad rara se trata como una, no rompe la línea', () => {
    const grupos = agruparOpciones([
      { option_group_name: 'Salsas', option_name: 'BBQ', quantity: 0 },
      { option_group_name: 'Salsas', option_name: 'Ajo', quantity: -5 },
    ])
    expect(grupos[0].items.every(item => item.quantity === 1)).toBe(true)
  })
})

describe('opcionEnTexto', () => {
  it('el x1 no se dice: ensucia y no aporta', () => {
    expect(opcionEnTexto({ name: 'Alitas', quantity: 1 })).toBe('Alitas')
    expect(opcionEnTexto({ name: 'Alitas', quantity: 4 })).toBe('Alitas x4')
  })
})

describe('detalleEnTexto', () => {
  it('devuelve una línea por grupo', () => {
    expect(detalleEnTexto({ order_item_options: PIZZA_34 })).toEqual([
      'Borde: Sin borde',
      'Extras: Extra queso',
      'Masa: Tradicional',
      'Retira ingredientes: Sin ají',
      'Sabor: Cheese Burguer',
    ])
  })

  // Los pedidos de antes del motor de opciones no tienen grupos, solo una
  // lista. Un pedido de hace tres meses tiene que seguir diciendo lo que el
  // cliente compró, aunque lo diga peor.
  it('los pedidos viejos caen a extras_names', () => {
    expect(detalleEnTexto({
      order_item_options: [],
      extras_names: ['Tradicional', 'Sin borde'],
    })).toEqual(['Tradicional · Sin borde'])
  })

  it('con grupos NO se repite además la lista plana', () => {
    // `extras_names` lleva una copia de lo mismo: decirlo dos veces alargaría
    // el WhatsApp del cliente para no añadir nada.
    expect(detalleEnTexto({
      order_item_options: [{ option_group_name: 'Masa', option_name: 'Delgada', quantity: 1 }],
      extras_names: ['Delgada'],
    })).toEqual(['Masa: Delgada'])
  })

  it('un producto sin nada elegido no aporta líneas', () => {
    expect(detalleEnTexto({})).toEqual([])
    expect(detalleEnTexto({ order_item_options: [], extras_names: [] })).toEqual([])
  })
})
