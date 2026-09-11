import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { precioDeVitrina, reglaDeMargen } = require('../dist/services/storefront')
const { handleMarketplaceMessage } = require('../dist/services/marketplace-entry')
const { advanceMenuFlowConEstado } = require('../dist/services/bot-menu-flow')

// ═══════════════════════════════════════════════════════════════════════════
// EL PRECIO QUE EL CHAT ENSEÑA ES EL QUE SE VA A COBRAR
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Fallo REAL encontrado el 2026-09-07 probando un pedido entero contra la
// base: el chat enseñaba «Total: $16.00» y el pedido se cobraba a **$17.60**.
//
// La causa: desde el 2026-08-25 el margen de la plataforma es `on_top` —se
// SUMA al precio del dueño en vez de quitárselo—, y aquella decisión se
// desbloqueó «cuando el catálogo, el carrito y el resumen pinten el precio con
// margen». La mini app lo pintaba (`precioDeVitrina`). **El menú del chat se
// quedó fuera**, y como es el único sitio donde piden los locales de almuerzos,
// justo ahí el cliente leía una cifra y pagaba otra.
//
// Es la regla inviolable #8 vista desde el otro lado: la base sigue siendo la
// autoridad del cobro, pero lo que el cliente lee tiene que coincidir con
// ella. Estas pruebas fijan las dos mitades.

describe('el margen de la plataforma se pinta, no solo se cobra', () => {
  const reglaOnTop = reglaDeMargen({
    strategy: 'percentage', percentage: 10, mode: 'on_top', version: 1,
  })

  it('el precio de vitrina lleva el margen del mismo modo que en la tienda', () => {
    // $3.50 del local + 10% = $3.85, que es lo que sella la base.
    expect(precioDeVitrina(3.5, reglaOnTop)).toBe(3.85)
    expect(precioDeVitrina(1, reglaOnTop)).toBe(1.1)
  })

  it('con `absorbed` el precio NO se toca: el margen sale de lo del dueño', () => {
    const absorbida = reglaDeMargen({
      strategy: 'percentage', percentage: 10, mode: 'absorbed', version: 1,
    })
    expect(precioDeVitrina(3.5, absorbida)).toBe(3.5)
    // Y sin regla ninguna, tampoco.
    expect(precioDeVitrina(3.5, null)).toBe(3.5)
  })

  it('el chat PIDE la regla de margen al armar el menú del local', async () => {
    // El guardián de que el arreglo siga CONECTADO. La lógica puede estar
    // perfecta y no servir de nada si nadie la llama: es el fallo que este
    // proyecto ha repetido ocho veces (ver la skill `camino-real`).
    let pedidaParaElNegocio = null
    const enviados = []
    const negocio = {
      id: 'b1', name: 'La Abuelita', type: 'almuerzos',
      takes_orders: true, storefront_enabled: true, active: true, slug: 'la-abuelita',
    }
    // La conversación recuerda dónde iba, como en producción: sin eso el
    // menú se reinicia en cada mensaje y nunca se llega a la lista de precios.
    let guardado = null
    const database = {
      resolveMarketplaceCustomer: async () => ({ id: 'c1', name: null }),
      getConversation: async () => ({
        current_state: 'pidiendo', selected_business_id: 'b1',
        shopping_locked: true, flow_state: guardado, version: 1,
      }),
      advanceConversation: async (_id, patch) => {
        if (patch.flowState) guardado = patch.flowState
        return { conflicto: false }
      },
      getBusinessById: async () => negocio,
      getProducts: async () => ([
        { id: 'p1', name: 'Almuerzo del día', price: 3.5, stock: 'disponible', active: true },
      ]),
      getPolicies: async () => null,
      getMarketplaceCategories: async () => ([{ code: 'almuerzos', label: 'Almuerzos', emoji: '🍱' }]),
      getBusinessPricingRule: async (businessId) => {
        pedidaParaElNegocio = businessId
        return { strategy: 'percentage', percentage: 10, mode: 'on_top', version: 1 }
      },
    }

    const escribir = texto => handleMarketplaceMessage(
      { from: '593900000000', text: texto, inboundId: null },
      {
        database,
        send: (reply, options) => { enviados.push({ reply, options }) },
        sendLink: async () => true,
        issueLink: async () => null,
        tipoPideEnChat: async () => true,
        // El motor de verdad: lo que se comprueba es que le lleguen los
        // precios YA con margen, no que se le sustituya por un doble.
        avanzarMenu: advanceMenuFlowConEstado,
      },
    )
    await escribir('hola')
    await escribir('🛒 Hacer un pedido')

    if (!pedidaParaElNegocio) {
      throw new Error(`no llegó al menú del local. Enviado: ${JSON.stringify(enviados)}`)
    }
    // Se pidió, y para ESTE negocio — no para otro ni sin filtrar.
    expect(pedidaParaElNegocio).toBe('b1')
    // Y llegó hasta el texto: $3.50 + 10% = $3.85 es lo que lee el cliente.
    const conPrecio = enviados.map(e => `${e.reply} || ${JSON.stringify(e.options)}`).join('\n')
    expect(conPrecio).toContain('3.85')
    expect(conPrecio).not.toContain('3.50')
  })

  // ═════════════════════════════════════════════════════════════════════════
  // `price_sale: null` — la forma REAL de la fila, no la del fixture
  // ═════════════════════════════════════════════════════════════════════════
  //
  // ⚠️ Fallo encontrado el 2026-09-11 auditando la app como cliente, con el
  // simulador contra producción. Desde el #330 —la PR que arregló el $16 vs
  // $17.60— el chat decía «Precio: lo confirma nuestro equipo» en **todos** los
  // productos y escondía el botón de añadir. Cuatro días sin poder pedir por el
  // menú, con el CI en verde.
  //
  // La causa es una línea: `numeroONulo` usaba `Number(valor)`, y **`Number(null)`
  // es `0`, no `NaN`**. Un producto sin «precio oferta» salía con `price_sale: 0`,
  // y `priceCentsOf` hace `price_sale ?? price` — `??` solo cae al segundo con
  // `null`/`undefined`, así que el 0 le ganaba al precio de verdad.
  //
  // ⚠️ **Por qué la prueba de arriba no lo cazó, que es la lección**: su
  // producto se declara SIN la clave `price_sale`, así que vale `undefined` y
  // `Number(undefined)` sí es `NaN`. La base no manda la clave ausente: la
  // manda explícitamente en `null`. La prueba acertaba en la lógica y fallaba
  // en la FORMA DEL DATO — el fixture no se parecía a la fila real.
  //
  // Por eso esta prueba fija las dos cosas a la vez: el precio pintado y el
  // botón que deja pedirlo.
  // Las DOS formas de «no hay oferta» que puede tener la fila: `null` —lo que
  // guarda el panel— y `0`, que puede llegar de un alta por API o de una
  // importación. Las dos tienen que dejar ganar al precio real.
  it.each([
    ['null', null],
    ['cero', 0],
  ])('un producto con precio oferta %s enseña su precio y SE PUEDE pedir', async (_nombre, oferta) => {
    const enviados = []
    const negocio = {
      id: 'b1', name: 'La Abuelita', type: 'almuerzos',
      takes_orders: true, storefront_enabled: true, active: true, slug: 'la-abuelita',
    }
    let guardado = null
    const database = {
      resolveMarketplaceCustomer: async () => ({ id: 'c1', name: null }),
      getConversation: async () => ({
        current_state: 'pidiendo', selected_business_id: 'b1',
        shopping_locked: true, flow_state: guardado, version: 1,
      }),
      advanceConversation: async (_id, patch) => {
        if (patch.flowState) guardado = patch.flowState
        return { conflicto: false }
      },
      getBusinessById: async () => negocio,
      // ⚠️ `price_sale: null` EXPLÍCITO. Así llega de Supabase, y es la única
      // diferencia entre esta prueba y la de arriba.
      getProducts: async () => ([
        { id: 'p1', name: 'Cola personal', price: 1, price_sale: oferta, stock: 'disponible', active: true },
      ]),
      getPolicies: async () => null,
      getMarketplaceCategories: async () => ([{ code: 'almuerzos', label: 'Almuerzos', emoji: '🍱' }]),
      getBusinessPricingRule: async () => (
        { strategy: 'percentage', percentage: 10, mode: 'on_top', version: 1 }
      ),
    }
    const escribir = texto => handleMarketplaceMessage(
      { from: '593900000001', text: texto, inboundId: null },
      {
        database,
        send: (reply, options) => { enviados.push({ reply, options }) },
        sendLink: async () => true,
        issueLink: async () => null,
        tipoPideEnChat: async () => true,
        avanzarMenu: advanceMenuFlowConEstado,
      },
    )
    await escribir('hola')
    await escribir('🛒 Hacer un pedido')
    await escribir('Cola personal')

    const todo = enviados.map(e => `${e.reply} || ${JSON.stringify(e.options)}`).join('\n')
    // 1. El precio se PINTA, con su margen: $1.00 + 10 % = $1.10.
    expect(todo, todo).toContain('1.10')
    // 2. Y no se rinde diciendo que no lo sabe.
    expect(todo).not.toContain('lo confirma nuestro equipo')
    // 3. Lo que de verdad importaba: se PUEDE pedir. Con el precio resuelto,
    //    elegir el producto lleva directo a la cantidad; con el fallo se
    //    quedaba en la ficha, con «Volver» y «Menú» como únicas salidas
    //    (`bot-menu-flow.ts` desvía a la ficha cuando `priceCentsOf` es null).
    //    Llegar a esta pregunta es la prueba de que el camino está abierto.
    expect(todo, todo).toContain('¿Cuántas unidades')
  })
})
