import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createBotConversation, MINIAPP_RECORDATORIO } = require('../dist/services/bot-conversation')

// ═══════════════════════════════════════════════════════════════════════════
// MODO MINI APP: WHATSAPP NO ATIENDE, SOLO ABRE LA PUERTA
// ═══════════════════════════════════════════════════════════════════════════
//
// Un negocio en `chat_mode = 'miniapp'` dijo que atiende por la app. Antes el
// enlace se añadía al FINAL del flujo, después de que la IA ya hubiera leído
// políticas, historial y catálogo y hubiera respondido: es decir, se pagaban
// tokens de OpenAI en cada mensaje de un negocio que no quería conversación.
//
// Lo que se fija aquí es justo eso: `ai.callAI` y `ai.embedText` NO se llaman.
// Es la comprobación que da valor al cambio; el texto de la respuesta es lo de
// menos.

const negocioMiniapp = {
  id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
  chat_mode: 'miniapp', storefront_enabled: true, takes_orders: true,
  bot_active: true, suspended: false,
}

function montar(overrides = {}) {
  const ai = {
    callAI: vi.fn(async () => 'respuesta del modelo'),
    embedText: vi.fn(async () => []),
  }
  const enviados = []
  const guardados = []
  const sendTyping = vi.fn(async () => ({}))
  const database = {
    getSession: async () => ({ manual_mode: false, contact_name: 'Ana' }),
    saveMessage: async (businessId, phone, role, content) => {
      guardados.push({ role, content })
    },
    upsertSession: async () => ({}),
    getSchedule: async () => [],
    getPolicies: async () => ({}),
    getContactHistory: async () => [],
    getAvailableSlots: async () => null,
    countProducts: async () => 5,
    searchProductsByVector: async () => [],
    getProducts: async () => [],
    recordConsultations: async () => ({}),
    resolveCustomer: async () => ({ id: 'cust-1' }),
    claimStorefrontLinkSend: vi.fn(async () => true),
    ...overrides.database,
  }
  const storefrontLink = {
    issueLink: vi.fn(async () => 'https://ejemplo.com/s/tok'),
    storefrontInvite: (_b, url) => `🛍️ Mira la carta y pide aquí:\n${url}`,
    ...overrides.storefrontLink,
  }
  const conversation = createBotConversation({
    database, ai, storefrontLink,
    reports: { handleOwnerMessage: async () => ({ handled: false, reply: '' }) },
    schedule: { isOutsideHours: () => false, buildScheduleMessage: () => '' },
    prompt: { buildPrompt: () => 'prompt' },
    tags: {
      detectMediaRequest: () => ({ wantsImage: false, wantsVideo: false }),
      isInsultMessage: () => false,
      impersonatesOfficialSummary: () => false,
      parseBotOutput: () => ({ finalText: 'x', orderPayload: null }),
    },
    actions: {
      createBookingFromTag: async () => ({}),
      handleConversationOutcome: async () => ({ handled: false }),
      processOrderPayload: async () => false,
      processLodgingQuote: async () => ({}),
      processLodgingRequest: async () => ({}),
    },
    media: { sendRequestedProductMedia: async () => false },
    menuFlow: { advanceMenuFlow: () => ({}) },
    logger: { log: () => {}, error: () => {} },
    sleep: async () => {},
    ...overrides.deps,
  })
  return { conversation, ai, database, storefrontLink, enviados, guardados, sendTyping }
}

const procesar = async (m, texto, business = negocioMiniapp) => {
  const enviados = []
  await m.conversation.processMessage({
    business, phone: '593999111222', text: texto,
    send: async t => { enviados.push(t); return {} },
    sendTyping: m.sendTyping,
  })
  return enviados
}

describe('modo mini app: ni un token de OpenAI', () => {
  it('CASO 1 — cliente nuevo recibe el enlace y NO se llama a la IA', async () => {
    const m = montar()
    const enviados = await procesar(m, 'hola, ¿tienen pizza hawaiana?')

    expect(m.ai.callAI).not.toHaveBeenCalled()
    expect(m.ai.embedText).not.toHaveBeenCalled()
    expect(enviados).toHaveLength(1)
    expect(enviados[0]).toContain('https://ejemplo.com/s/tok')
    // La base es quien decide, y se le preguntó por ESTE negocio y cliente.
    expect(m.database.claimStorefrontLinkSend).toHaveBeenCalledWith('biz-1', 'cust-1')
  })

  it('CASO 2 — dentro de 24 h solo recuerda, sin enlace nuevo ni IA', async () => {
    const m = montar({ database: { claimStorefrontLinkSend: vi.fn(async () => false) } })
    const enviados = await procesar(m, '¿cuánto cuesta la familiar?')

    expect(m.ai.callAI).not.toHaveBeenCalled()
    expect(m.storefrontLink.issueLink).not.toHaveBeenCalled()
    expect(enviados).toEqual([MINIAPP_RECORDATORIO])
  })

  it('CASO 3 — pasadas 24 h vuelve a mandarlo, tampoco con IA', async () => {
    const m = montar({ database: { claimStorefrontLinkSend: vi.fn(async () => true) } })
    const enviados = await procesar(m, 'buenas')

    expect(m.ai.callAI).not.toHaveBeenCalled()
    expect(m.storefrontLink.issueLink).toHaveBeenCalledTimes(1)
    // `force` en true: la ventana ya la decidió la base, el cooldown en
    // memoria de issueLink no puede volver a filtrar y dejarlo sin enlace.
    expect(m.storefrontLink.issueLink.mock.calls[0][0].force).toBe(true)
    expect(enviados[0]).toContain('https://ejemplo.com/s/tok')
  })

  it('no contesta preguntas de catálogo, precios ni promociones', async () => {
    for (const pregunta of [
      '¿tienen descuentos hoy?',
      '¿a qué hora cierran?',
      'quiero 2 pizzas grandes con extra queso',
      '¿me recomiendas algo?',
    ]) {
      const m = montar({ database: { claimStorefrontLinkSend: vi.fn(async () => false) } })
      const enviados = await procesar(m, pregunta)
      expect(m.ai.callAI, `"${pregunta}" no debe llegar al modelo`).not.toHaveBeenCalled()
      expect(enviados).toEqual([MINIAPP_RECORDATORIO])
    }
  })

  it('marca el mensaje como LEÍDO (el doble check azul)', async () => {
    // `sendTyping` no solo pinta «escribiendo…»: en WhatsApp marca como leído.
    // Se quedó fuera al escribir este modo y el cliente veía sus mensajes en
    // dos checks grises para siempre, como si nadie los mirara.
    const m = montar()
    await procesar(m, 'hola')
    expect(m.sendTyping).toHaveBeenCalledTimes(1)
    // Y no cuesta modelo: es la API del canal.
    expect(m.ai.callAI).not.toHaveBeenCalled()
  })

  it('si el canal no puede marcar leído, se responde igual', async () => {
    const m = montar()
    m.sendTyping.mockRejectedValue(new Error('YCloud 401'))
    const enviados = await procesar(m, 'hola')
    expect(enviados).toHaveLength(1)
  })

  it('guarda el mensaje del cliente aunque no le conteste', async () => {
    // El dueño tiene que poder leer en su panel qué le escribieron.
    const m = montar()
    await procesar(m, 'hola')
    expect(m.guardados.some(g => g.role === 'user' && g.content === 'hola')).toBe(true)
    expect(m.guardados.some(g => g.role === 'assistant')).toBe(true)
  })

  it('si la base falla, manda el enlace en vez de quedarse callado', async () => {
    const m = montar({
      database: {
        claimStorefrontLinkSend: vi.fn(async () => { throw new Error('base caída') }),
      },
    })
    const enviados = await procesar(m, 'hola')
    expect(enviados[0]).toContain('https://ejemplo.com/s/tok')
    expect(m.ai.callAI).not.toHaveBeenCalled()
  })

  it('sin tienda utilizable recuerda igual, no deja el mensaje sin respuesta', async () => {
    const m = montar({ storefrontLink: { issueLink: vi.fn(async () => null) } })
    const enviados = await procesar(m, 'hola')
    expect(enviados).toEqual([MINIAPP_RECORDATORIO])
    expect(m.ai.callAI).not.toHaveBeenCalled()
  })
})

describe('CASO 5 — los demás negocios siguen igual', () => {
  it('un negocio en modo ai SÍ llega al modelo', async () => {
    const m = montar()
    await procesar(m, 'hola', { ...negocioMiniapp, chat_mode: 'ai' })

    expect(m.ai.callAI).toHaveBeenCalled()
    // Y no se le pregunta a la base por el enlace: no es asunto suyo.
    expect(m.database.claimStorefrontLinkSend).not.toHaveBeenCalled()
  })

  it('un negocio sin chat_mode (por defecto) también llega al modelo', async () => {
    const m = montar()
    await procesar(m, 'hola', { ...negocioMiniapp, chat_mode: null })
    expect(m.ai.callAI).toHaveBeenCalled()
  })
})
