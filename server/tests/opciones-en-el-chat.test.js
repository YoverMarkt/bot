import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  advanceMenuFlowConEstado,
  optionTitle,
} from '../dist/services/bot-menu-flow.js'

// ═══════════════════════════════════════════════════════════════════════════
// LAS OPCIONES DEL CHAT SALEN DEL MISMO MOTOR QUE LA MINI APP
//
// El chat usaba `menu_modifiers`: un texto suelto colgado de la CATEGORÍA
// entera. Con jugos y colas en «Bebidas» eso producía dos fallos a la vez:
//
//   1. Preguntaba el sabor ANTES de saber qué producto quería el cliente.
//   2. Se lo pegaba a todo lo de la categoría — el cliente acababa pidiendo
//      una «Cola 355 ml — Mora».
//
// Y lo elegido viajaba como texto en la nota del pedido, así que nunca
// llegaba a `order_item_options`: el reporte del dueño no podía contar qué
// sabor se vende más.
//
// `option_groups` cuelga del PRODUCTO (o de su categoría, explícitamente), se
// pregunta DESPUÉS de elegirlo, y viaja con su id real para que la base lo
// valide y lo guarde.
// ═══════════════════════════════════════════════════════════════════════════

const business = { id: 'b1', name: 'Almuerzos Doña María', takes_orders: true }

const PRODUCTOS = [
  // Dos categorías para que el menú ofrezca la pantalla de categorías, que es
  // como se ve en un local real. Con una sola, el flujo salta directo a los
  // productos y no se estaría probando el camino que usa el cliente.
  { id: 'almuerzo', name: 'Almuerzo completo', price: 3.5, active: true, tags: ['Almuerzos'], category_id: 'cat-alm' },
  { id: 'jugo', name: 'Jugo natural', price: 1.25, active: true, tags: ['Bebidas'], category_id: 'cat-beb' },
  { id: 'cola', name: 'Cola 355 ml', price: 1.0, active: true, tags: ['Bebidas'], category_id: 'cat-beb' },
]

// El sabor cuelga del JUGO, no de la categoría: una cola no tiene sabores.
const GRUPOS = [
  {
    id: 'g-sabor', product_id: 'jugo', category_id: null, name: 'Sabor',
    selection_type: 'single', required: true, sort: 0,
  },
]
const OPCIONES = [
  { id: 'o-mora', option_group_id: 'g-sabor', name: 'Mora', price_adjustment: 0, sort: 0 },
  { id: 'o-maracuya', option_group_id: 'g-sabor', name: 'Maracuyá', price_adjustment: 0, sort: 1 },
  { id: 'o-naranja', option_group_id: 'g-sabor', name: 'Naranja', price_adjustment: 0.25, sort: 2 },
]

const entrada = (mensaje, extra = {}) => ({
  business,
  contact: '593990978367',
  message: mensaje,
  products: PRODUCTOS,
  optionGroups: GRUPOS,
  options: OPCIONES,
  productCategories: { almuerzo: 'cat-alm', jugo: 'cat-beb', cola: 'cat-beb' },
  ...extra,
})

/** Conversación con el estado fuera, como en el marketplace. */
const crearChat = (extra = {}) => {
  let estado = null
  return {
    di(mensaje) {
      const r = advanceMenuFlowConEstado(entrada(mensaje, extra), estado)
      estado = r.estado
      return r.resultado
    },
    get estado() { return estado },
  }
}

describe('el sabor se pregunta DESPUÉS de elegir el producto', () => {
  let chat
  beforeEach(() => { chat = crearChat() })

  it('elegir la categoría lleva a los productos, no al sabor', () => {
    // ⚠️ El fallo que se corrige: con `menu_modifiers` aquí salía «Elige el
    // sabor», antes de saber si quería jugo o cola.
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    const r = chat.di('Bebidas')
    const titulos = r.options.map(optionTitle)
    expect(titulos).toContain('Jugo natural')
    expect(titulos).toContain('Cola 355 ml')
    expect(titulos).not.toContain('Mora')
  })

  it('el JUGO pregunta el sabor al pedirlo', () => {
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    chat.di('Bebidas')
    const r = chat.di('Jugo natural')
    expect(r.reply).toContain('Sabor')
    expect(r.options.map(optionTitle)).toEqual(['Mora', 'Maracuyá', 'Naranja'])
  })

  it('y la COLA no: no tiene sabores, va directa a la cantidad', () => {
    // ⚠️ Este es el bug de verdad. Antes el cliente acababa pidiendo una
    // «Cola 355 ml — Mora», porque el modificador colgaba de la categoría.
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    chat.di('Bebidas')
    const r = chat.di('Cola 355 ml')
    expect(r.reply).toMatch(/cuántas unidades/i)
    expect(r.options.map(optionTitle)).not.toContain('Mora')
  })

  it('el recargo se enseña solo cuando lo hay', () => {
    // Un «+$0.00» pegado a cada línea es ruido, y encima hace dudar.
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    chat.di('Bebidas')
    const r = chat.di('Jugo natural')
    const naranja = r.options.find(o => optionTitle(o) === 'Naranja')
    const mora = r.options.find(o => optionTitle(o) === 'Mora')
    expect(naranja.description).toBe('+$0.25')
    expect(mora.description).toBeUndefined()
  })

  it('un grupo OBLIGATORIO no ofrece «Volver»', () => {
    // Saltárselo dejaría un pedido que la base va a rechazar, y el cliente no
    // sabría por qué.
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    chat.di('Bebidas')
    const r = chat.di('Jugo natural')
    expect(r.options.map(optionTitle)).not.toContain('⬅️ Volver')
  })
})

describe('lo elegido viaja con su id real', () => {
  const pedirJugoConSabor = (chat) => {
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    chat.di('Bebidas')
    chat.di('Jugo natural')
    chat.di('Maracuyá')
    return chat.di('2')
  }

  it('el carrito guarda el `optionId`, no solo el nombre', () => {
    const chat = crearChat()
    pedirJugoConSabor(chat)
    const linea = chat.estado.cart[0]
    expect(linea.options).toEqual([
      { optionId: 'o-maracuya', groupName: 'Sabor', name: 'Maracuyá' },
    ])
  })

  it('el resumen enseña lo elegido antes de confirmar', () => {
    // El cliente tiene que poder comprobar que se entendió su pedido ANTES de
    // confirmarlo, no descubrirlo cuando llegue.
    const chat = crearChat()
    pedirJugoConSabor(chat)
    const resumen = chat.di('✅ Finalizar pedido')
    expect(resumen.reply).toContain('Maracuyá')
  })

  it('la acción del pedido lleva `options` y `productId`', () => {
    const chat = crearChat()
    pedirJugoConSabor(chat)
    chat.di('✅ Finalizar pedido')
    const confirmado = chat.di('✅ Confirmar pedido')
    expect(confirmado.action.items).toEqual([
      expect.objectContaining({
        name: 'Jugo natural',
        qty: 2,
        productId: 'jugo',
        options: [{ optionId: 'o-maracuya', groupName: 'Sabor', name: 'Maracuyá' }],
      }),
    ])
  })

  it('y la RPC las recibe como `option_id`, que es lo que valida', () => {
    // La base comprueba que cada opción pertenece a este negocio Y a este
    // producto (o a su categoría). Un nombre suelto no se puede validar.
    const fuente = readFileSync(
      fileURLToPath(new URL('../src/services/inbound-webhook.ts', import.meta.url)), 'utf8',
    )
    expect(fuente).toMatch(/option_id: o\.optionId/)
  })
})

describe('lo que el chat NO sabe preguntar va a la app', () => {
  it('un grupo obligatorio de casillas manda a la mini app', () => {
    // `multiple` y `quantity` piden casillas y contadores: en una lista de
    // WhatsApp se vuelven una conversación larga y confusa. Dejar pedir sin
    // preguntarlos crearía un pedido que la base rechaza.
    const chat = crearChat({
      optionGroups: [{
        id: 'g-extras', product_id: 'jugo', category_id: null, name: 'Extras',
        selection_type: 'multiple', required: true, sort: 0,
      }],
      options: [
        { id: 'o-hielo', option_group_id: 'g-extras', name: 'Sin hielo', price_adjustment: 0, sort: 0 },
      ],
    })
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    chat.di('Bebidas')
    const r = chat.di('Jugo natural')
    expect(r.reply).toMatch(/en la app/i)
    expect(chat.estado.cart).toHaveLength(0)
  })

  it('pero uno NO obligatorio no estorba: se pide igual', () => {
    const chat = crearChat({
      optionGroups: [{
        id: 'g-extras', product_id: 'jugo', category_id: null, name: 'Extras',
        selection_type: 'multiple', required: false, sort: 0,
      }],
      options: [],
    })
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    chat.di('Bebidas')
    const r = chat.di('Jugo natural')
    expect(r.reply).toMatch(/cuántas unidades/i)
  })
})

describe('el sistema viejo sigue funcionando', () => {
  it('un negocio sin `option_groups` se comporta igual que antes', () => {
    // ⚠️ El cambio es ADITIVO: `menu_modifiers` sigue vivo para los negocios
    // que aún lo usan, y su flujo no cambia en nada.
    const chat = crearChat({
      optionGroups: [],
      options: [],
      modifiers: [
        { category_tag: 'Bebidas', group_label: 'Sabor', name: 'Mora' },
      ],
    })
    chat.di('hola')
    chat.di('🛒 Hacer un pedido')
    const r = chat.di('Bebidas')
    // El flujo viejo pregunta el sabor primero: se conserva tal cual.
    expect(r.options.map(optionTitle)).toContain('Mora')
  })
})
