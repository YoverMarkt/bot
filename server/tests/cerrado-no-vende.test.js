import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { handleMarketplaceMessage } = require('../dist/services/marketplace-entry')
const { advanceMenuFlowConEstado } = require('../dist/services/bot-menu-flow')

// ═══════════════════════════════════════════════════════════════════════════
// UN LOCAL CERRADO SE VE, PERO NO VENDE
// ═══════════════════════════════════════════════════════════════════════════
//
// Encontrado auditando la app como cliente (2026-09-13): con La Abuelita
// CERRADA, el chat decía «está cerrado ahora mismo» y acto seguido ofrecía
// «🛒 Hacer un pedido» — y dejaba armar el carrito, elegir el pago y recibir
// los datos bancarios. A las 00:30, para una cocina cerrada.
//
// ⚠️ La mini app YA lo impedía (`canOrder: false` con la tienda cerrada), así
// que las dos superficies decían cosas distintas del mismo local. Eso es un
// bug, no una decisión: el propio apartado de DECISIONES que deja ver la carta
// con el local cerrado se apoya en que «la mini app impide pedir por su
// cuenta».
//
// ⚠️ Lo que NO cambia: el local cerrado SIGUE saliendo en la lista, marcado y
// con su hora de apertura, y sigue dejando ver la carta. Esconderlo dejaría el
// marketplace vacío de noche —con dos locales, literalmente vacío— y el cliente
// concluiría que no hay nada. Ver «abre a las 8:00 AM» es lo que le hace volver.

const LUNES_13H = new Date('2026-07-13T18:00:00Z')   // lunes 13:00 en Ecuador

const HORARIO_ABIERTO = [
  { day_of_week: 1, open_time: '09:00:00', close_time: '17:00:00', is_active: true },
]
const HORARIO_CERRADO = [
  { day_of_week: 1, open_time: '09:00:00', close_time: '12:00:00', is_active: true },
  { day_of_week: 2, open_time: '09:00:00', close_time: '17:00:00', is_active: true },
]

const NEGOCIO = {
  id: 'b1', name: 'La Abuelita', type: 'almuerzos', slug: 'la-abuelita',
  takes_orders: true, storefront_enabled: true, active: true,
}

function armar({ horario, conversacion, crearPedidoCompleto }) {
  const enviados = []
  let guardado = null
  const database = {
    resolveMarketplaceCustomer: async () => ({ id: 'c1', name: 'Ana' }),
    getConversation: async () => conversacion ?? {
      current_state: 'pidiendo', selected_business_id: 'b1',
      shopping_locked: true, flow_state: guardado, version: 1,
    },
    advanceConversation: async (_id, patch) => {
      if (patch.flowState) guardado = patch.flowState
      return { conflicto: false }
    },
    getBusinessById: async () => NEGOCIO,
    getProducts: async () => ([
      { id: 'p1', name: 'Almuerzo del día', price: 3.5, price_sale: null, stock: 'disponible', active: true },
    ]),
    getPolicies: async () => null,
    getMarketplaceCategories: async () => ([{ code: 'almuerzos', label: 'Almuerzos', emoji: '🍱' }]),
    getBusinessPricingRule: async () => null,
    getMarketplaceBusinesses: async () => ([
      { id: 'b1', slug: 'la-abuelita', name: 'La Abuelita', type: 'almuerzos' },
    ]),
    claimMarketplaceReply: async () => ({ permitido: true, respuestas: 1 }),
    isPlatformBlocked: async () => false,
    isContactBlocked: async () => false,
    getStorefrontPaymentMethods: async () => ([
      { code: 'transferencia', label: 'Transferencia bancaria', help_text: null, is_prepaid: true, requires_proof: true },
    ]),
    getBusinessBankAccount: async () => ({
      bank_name: 'Pichincha', account_type: 'ahorros', account_number: '123', holder_name: 'Ana',
    }),
  }
  if (horario !== undefined) {
    database.getSchedulesFor = vi.fn().mockResolvedValue(new Map([['b1', horario]]))
  }
  const deps = {
    database,
    send: (reply, options) => { enviados.push({ reply, options }) },
    sendLink: async () => true,
    issueLink: async () => null,
    tipoPideEnChat: async () => true,
    avanzarMenu: advanceMenuFlowConEstado,
    crearPedidoCompleto: crearPedidoCompleto
      || vi.fn().mockResolvedValue({ orderNumber: 1, total: 3.85 }),
  }
  const escribir = texto => handleMarketplaceMessage(
    { from: '593900000913', text: texto, inboundId: null }, deps,
  )
  return { escribir, enviados, deps, database }
}

afterEach(() => { vi.useRealTimers() })

describe('el menú de un local cerrado', () => {
  it('NO ofrece pedir, y dice cuándo abre', async () => {
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const { escribir, enviados } = armar({ horario: HORARIO_CERRADO })
    await escribir('hola')

    const todo = enviados.map(e => `${e.reply} || ${JSON.stringify(e.options)}`).join('\n')
    expect(todo, todo).not.toContain('Hacer un pedido')
    expect(todo, todo).toContain('cerrado ahora mismo')
    // La hora de apertura es lo que le hace volver: sin ella solo sabe que no.
    expect(todo, todo).toContain('mañana a las 9:00 AM')
    // Y la carta SÍ se ofrece: saber qué se vende ahí es la razón de volver.
    expect(todo, todo).toContain('Ver la carta')
  })

  it('lo dice UNA vez, no dos, al ELEGIR el local', async () => {
    // ⚠️ Antes del 2026-09-13 se mandaba un mensaje de cierre ANTES de abrir el
    // menú, y su motivo era bueno: sin él el cliente armaba el carrito entero y
    // se topaba con el cierre al confirmar. Desde que el menú NO ofrece pedir y
    // lo dice en su encabezado, aquel mensaje repetía lo que venía detrás —
    // palabra por palabra. Dos mensajes seguidos diciendo lo mismo se leen como
    // un fallo, y en WhatsApp cada saliente se PAGA.
    //
    // ⚠️ Esto SOLO se reproduce eligiendo el local desde la lista: es
    // `entregarLocal` quien mandaba el mensaje de más, no el menú. Una prueba
    // que entrara con el local ya elegido pasa con el fallo puesto — lo
    // comprobé, y por eso esta prueba empieza en la lista de locales.
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const { escribir, enviados } = armar({
      horario: HORARIO_CERRADO,
      conversacion: {
        current_state: 'navegando',
        selected_business_id: null,
        shopping_locked: false,
        flow_state: { vista: { vista: 'negocios', categoria: 'almuerzos', pagina: 0 } },
        version: 1,
      },
    })

    await escribir('La Abuelita')

    const veces = enviados.filter(e => /cerrado ahora mismo/.test(e.reply)).length
    expect(veces, enviados.map(e => e.reply).join('\n---\n')).toBe(1)
  })

  it('con el local ABIERTO todo sigue igual', async () => {
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const { escribir, enviados } = armar({ horario: HORARIO_ABIERTO })
    await escribir('hola')

    const todo = enviados.map(e => `${e.reply} || ${JSON.stringify(e.options)}`).join('\n')
    expect(todo, todo).toContain('Hacer un pedido')
    expect(todo, todo).not.toContain('cerrado ahora mismo')
  })

  it('FALLA ABIERTO: sin horario configurado se puede pedir', async () => {
    // Llamar «cerrado» a un local que está abierto cuesta ventas de verdad.
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const { escribir, enviados } = armar({ horario: [] })
    await escribir('hola')
    expect(enviados.map(e => JSON.stringify(e.options)).join('\n')).toContain('Hacer un pedido')
  })
})

describe('el checkout de un local que cerró a media compra', () => {
  // El cliente pudo empezar a las 17:55 y llegar al pago a las 18:01. Es la
  // ÚLTIMA puerta antes del dinero: sin ella el pedido nace igual, y encima
  // recibe los datos bancarios para pagar algo que nadie va a preparar.
  const enElPago = {
    current_state: 'esperando_metodo_pago',
    selected_business_id: 'b1',
    shopping_locked: true,
    version: 1,
    flow_state: {
      checkout: {
        items: [{ productId: 'p1', quantity: 1 }],
        fulfillment: 'pickup',
        addressId: null,
      },
    },
  }

  it('NO crea el pedido, conserva el carrito y dice cuándo abre', async () => {
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const crear = vi.fn().mockResolvedValue({ orderNumber: 1, total: 3.85 })
    const { escribir, enviados } = armar({
      horario: HORARIO_CERRADO, conversacion: enElPago, crearPedidoCompleto: crear,
    })

    await escribir('Transferencia bancaria')

    const todo = enviados.map(e => e.reply).join('\n')
    expect(crear, 'creó el pedido con el local cerrado').not.toHaveBeenCalled()
    expect(todo, todo).toContain('cerrado ahora mismo')
    expect(todo, todo).toContain('mañana a las 9:00 AM')
    // El carrito se queda: vaciárselo sería castigarle por la hora.
    expect(todo, todo).toContain('se queda guardado')
    // Y nunca le llegan los datos bancarios de algo que nadie va a preparar.
    expect(todo, todo).not.toContain('Transfiere a')
  })

  it('con el local abierto el pedido se crea como siempre', async () => {
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const crear = vi.fn().mockResolvedValue({ orderNumber: 7, total: 3.85 })
    const { escribir } = armar({
      horario: HORARIO_ABIERTO, conversacion: enElPago, crearPedidoCompleto: crear,
    })

    await escribir('Transferencia bancaria')
    expect(crear).toHaveBeenCalled()
  })
})
