import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createBotConversation, mentionedProductIds } = require('../dist/services/bot-conversation')

const business = {
  id: 'business-a',
  name: 'Negocio A',
  bot_active: true,
  suspended: false,
  ai_provider: 'openai',
  takes_orders: true,
}
const product = {
  id: 'product-a',
  name: 'Perfume Floral Intenso',
  brand: 'Aura',
  tags: ['floral'],
  price: '10.00',
  image_url: 'https://cdn.example/floral.jpg',
}

function setup(overrides = {}) {
  const database = {
    getSession: vi.fn().mockResolvedValue(null),
    saveMessage: vi.fn().mockResolvedValue({ error: null }),
    upsertSession: vi.fn().mockResolvedValue({ error: null }),
    getSchedule: vi.fn().mockResolvedValue([]),
    getPolicies: vi.fn().mockResolvedValue({}),
    getContactHistory: vi.fn().mockResolvedValue([]),
    getAvailableSlots: vi.fn().mockResolvedValue(null),
    countProducts: vi.fn().mockResolvedValue(1),
    searchProductsByVector: vi.fn().mockResolvedValue([]),
    getProducts: vi.fn().mockResolvedValue([product]),
    recordConsultations: vi.fn().mockResolvedValue(undefined),
    ...overrides.database,
  }
  const reports = {
    handleOwnerMessage: vi.fn().mockResolvedValue({ handled: false, reply: '' }),
    ...overrides.reports,
  }
  const schedule = {
    isOutsideHours: vi.fn().mockReturnValue(false),
    buildScheduleMessage: vi.fn().mockReturnValue('Horario del negocio'),
    ...overrides.schedule,
  }
  const ai = {
    callAI: vi.fn().mockResolvedValue('Respuesta final'),
    embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
    ...overrides.ai,
  }
  const prompt = {
    buildPrompt: vi.fn().mockReturnValue('PROMPT'),
    ...overrides.prompt,
  }
  const tags = {
    detectMediaRequest: vi.fn().mockReturnValue({ wantsImage: false, wantsVideo: false }),
    isInsultMessage: vi.fn().mockReturnValue(false),
    impersonatesOfficialSummary: vi.fn().mockReturnValue(false),
    parseBotOutput: vi.fn().mockReturnValue({
      finalText: 'Respuesta final',
      orderPayload: null,
      hasSale: false,
      hasHandoffTag: false,
      isUncertain: false,
    }),
    ...overrides.tags,
  }
  const actions = {
    handleConversationOutcome: vi.fn().mockResolvedValue({ handled: false }),
    processOrderPayload: vi.fn().mockResolvedValue(false),
    ...overrides.actions,
  }
  const media = {
    sendRequestedProductMedia: vi.fn().mockResolvedValue(false),
    ...overrides.media,
  }
  const storefrontLink = {
    issueLink: vi.fn().mockResolvedValue(null),
    storefrontInvite: vi.fn((_business, url) => `🛍️ Nuestra tienda:\n${url}`),
    ...overrides.storefrontLink,
  }
  const logger = { log: vi.fn(), error: vi.fn() }
  const sleep = vi.fn().mockResolvedValue(undefined)
  const now = vi.fn().mockReturnValue(30_000_000)
  const conversation = createBotConversation({
    database, reports, schedule, ai, prompt, tags, actions, media,
    storefrontLink, logger, sleep, now,
    ...(overrides.priceGuard ? { priceGuard: overrides.priceGuard } : {}),
  })
  const send = vi.fn().mockResolvedValue(undefined)
  const sendImage = vi.fn().mockResolvedValue(undefined)
  const sendTyping = vi.fn().mockResolvedValue(undefined)
  const sendVideo = vi.fn().mockResolvedValue(undefined)
  return {
    conversation, database, reports, schedule, ai, prompt, tags, actions,
    media, storefrontLink, logger, sleep, now,
    send, sendImage, sendTyping, sendVideo,
  }
}

function input(setupResult, overrides = {}) {
  return {
    business,
    phone: '0990000001',
    text: '¿Tienen Perfume Floral Intenso?',
    send: setupResult.send,
    sendImage: setupResult.sendImage,
    sendTyping: setupResult.sendTyping,
    sendVideo: setupResult.sendVideo,
    ...overrides,
  }
}

describe('orquestación de conversaciones del bot', () => {
  it('corta inmediatamente negocios suspendidos o con bot inactivo', async () => {
    const suspended = setup()
    await suspended.conversation.processMessage(input(suspended, {
      business: { ...business, suspended: true },
    }))
    expect(suspended.send).toHaveBeenCalledWith(expect.stringContaining('pago pendiente'))
    expect(suspended.reports.handleOwnerMessage).not.toHaveBeenCalled()
    expect(suspended.database.getSession).not.toHaveBeenCalled()

    const inactive = setup()
    await inactive.conversation.processMessage(input(inactive, {
      business: { ...business, bot_active: false },
    }))
    expect(inactive.send).not.toHaveBeenCalled()
    expect(inactive.reports.handleOwnerMessage).not.toHaveBeenCalled()
  })

  it('atiende el reporte del dueño antes de leer una sesión de cliente', async () => {
    const current = setup({
      reports: {
        handleOwnerMessage: vi.fn().mockResolvedValue({
          handled: true, reply: 'Reporte de hoy',
        }),
      },
    })

    await current.conversation.processMessage(input(current))

    expect(current.reports.handleOwnerMessage).toHaveBeenCalledWith(
      business, '0990000001', '¿Tienen Perfume Floral Intenso?',
    )
    expect(current.send).toHaveBeenCalledWith('Reporte de hoy')
    expect(current.database.getSession).not.toHaveBeenCalled()
  })

  it('guarda modo manual exclusivamente dentro del negocio resuelto', async () => {
    const current = setup({
      database: { getSession: vi.fn().mockResolvedValue({ manual_mode: true }) },
    })

    await current.conversation.processMessage(input(current))

    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'user', '¿Tienen Perfume Floral Intenso?',
    )
    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({
        manual_mode: true, unread_owner: true,
      }),
    )
    expect(current.database.upsertSession).not.toHaveBeenCalledWith(
      'business-b', expect.anything(), expect.anything(),
    )
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  it('descarta y deriva cuando la IA imita un resumen oficial con cifras propias', async () => {
    const current = setup({
      tags: {
        impersonatesOfficialSummary: vi.fn().mockReturnValue(true),
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Combo inventado 💰 *Total oficial: $120.00*',
          orderPayload: null,
          hasSale: false, hasHandoffTag: false, isUncertain: false,
        }),
      },
    })

    await current.conversation.processMessage(input(current))

    // El texto inventado JAMÁS llega al cliente; se falla cerrado derivando
    expect(current.send).not.toHaveBeenCalledWith(expect.stringContaining('Total oficial'))
    expect(current.actions.handleConversationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ isUncertain: true, hasSale: false }),
    )
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
  })

  // Vigilante de precios (regla inviolable #8). Arranca en modo observación a
  // propósito: un falso positivo cortaría la conversación de un cliente real.
  describe('cuando la IA cita un precio que no existe en el catálogo', () => {
    const respuestaConPrecioInventado = {
      parseBotOutput: vi.fn().mockReturnValue({
        finalText: 'Te lo dejo en $40, oferta especial',
        orderPayload: null,
        hasSale: false, hasHandoffTag: false, isUncertain: false,
      }),
    }

    const guard = (mode, onInvented) => ({
      check: () => ({ ok: false, invented: [40], quoted: [40] }),
      mode: () => mode,
      onInvented,
    })

    it('en modo observación lo registra pero NO corta la conversación', async () => {
      const onInvented = vi.fn()
      const current = setup({
        tags: respuestaConPrecioInventado,
        priceGuard: guard('observar', onInvented),
      })

      await current.conversation.processMessage(input(current))

      expect(onInvented).toHaveBeenCalledWith(
        expect.objectContaining({ invented: [40] }),
      )
      expect(current.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('precios que no existen'),
      )
      // El cliente sigue recibiendo respuesta: todavía no se bloquea nada.
      expect(current.send).toHaveBeenCalled()
    })

    it('en modo bloquear descarta el mensaje y deriva', async () => {
      const current = setup({
        tags: respuestaConPrecioInventado,
        priceGuard: guard('bloquear', vi.fn()),
      })

      await current.conversation.processMessage(input(current))

      expect(current.send).not.toHaveBeenCalledWith(expect.stringContaining('$40'))
      expect(current.actions.handleConversationOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ isUncertain: true, hasSale: false }),
      )
    })

    it('no molesta cuando todos los precios son reales', async () => {
      const onInvented = vi.fn()
      const current = setup({
        priceGuard: {
          check: () => ({ ok: true, invented: [], quoted: [95] }),
          mode: () => 'bloquear',
          onInvented,
        },
      })

      await current.conversation.processMessage(input(current))

      expect(onInvented).not.toHaveBeenCalled()
      expect(current.send).toHaveBeenCalled()
    })
  })

  it('deriva insultos sin invocar IA ni consultar el catálogo', async () => {
    const current = setup({
      tags: { isInsultMessage: vi.fn().mockReturnValue(true) },
    })

    await current.conversation.processMessage(input(current, { text: 'Eres un idiota' }))

    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({ manual_mode: true }),
    )
    expect(current.send).toHaveBeenCalledWith(expect.stringContaining('un asesor'))
    expect(current.database.getSchedule).not.toHaveBeenCalled()
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  it('avisa una sola vez mientras continúa fuera de horario', async () => {
    const current = setup({
      schedule: { isOutsideHours: vi.fn().mockReturnValue(true) },
    })
    const message = input(current)

    await current.conversation.processMessage(message)
    await current.conversation.processMessage(message)

    expect(current.database.getSchedule).toHaveBeenCalledTimes(2)
    expect(current.database.getSchedule).toHaveBeenCalledWith('business-a')
    expect(current.send).toHaveBeenCalledTimes(1)
    expect(current.send).toHaveBeenCalledWith('Horario del negocio')
    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'assistant', 'Horario del negocio',
    )
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  it('mantiene preguntas de precio y media automatizadas en modo informativo', async () => {
    const current = setup({
      tags: {
        detectMediaRequest: vi.fn().mockReturnValue({
          wantsImage: true, wantsVideo: false,
        }),
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Cuesta $10.00 y está disponible.',
          orderPayload: null,
          hasSale: false,
          hasHandoffTag: false,
          isUncertain: false,
        }),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, takes_orders: false },
      text: '¿Cuánto cuesta? Muéstrame una foto',
    }))

    expect(current.actions.handleConversationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ hasSale: false, isUncertain: false }),
    )
    expect(current.send).toHaveBeenCalledWith('Cuesta $10.00 y está disponible.')
    expect(current.media.sendRequestedProductMedia).toHaveBeenCalledWith(
      expect.objectContaining({ wantsImage: true }),
    )
  })

  it('mantiene RAG, acciones y media en el mismo tenant y orden lógico', async () => {
    const current = setup({
      database: {
        getSession: vi.fn().mockResolvedValue({ closed_sale_at: '2026-07-01' }),
        getContactHistory: vi.fn().mockResolvedValue([
          { role: 'user', content: 'Antes hablamos del perfume' },
        ]),
        countProducts: vi.fn().mockResolvedValue(50),
        searchProductsByVector: vi.fn().mockResolvedValue([product]),
      },
      tags: {
        detectMediaRequest: vi.fn().mockReturnValue({
          wantsImage: true, wantsVideo: false,
        }),
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Aquí está',
              orderPayload: null,
          hasSale: false,
          hasHandoffTag: false,
          isUncertain: false,
        }),
      },
    })

    await current.conversation.processMessage(input(current, {
      text: 'La vez pasada vi Perfume Floral Intenso, muéstrame foto',
    }))

    expect(current.database.getContactHistory).toHaveBeenCalledWith(
      'business-a', '0990000001', 24, '2026-07-01',
    )
    expect(current.database.searchProductsByVector).toHaveBeenCalledWith(
      'business-a', [0.1, 0.2], 12,
    )
    expect(current.database.getProducts).not.toHaveBeenCalled()
    expect(current.prompt.buildPrompt).toHaveBeenCalledWith(
      business,
      [product],
      {},
      'La vez pasada vi Perfume Floral Intenso, muéstrame foto',
      [],
      true,
      true,
    )
    expect(current.media.sendRequestedProductMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        business,
        products: [product],
        preFiltered: true,
        wantsImage: true,
      }),
    )
    expect(current.database.recordConsultations).toHaveBeenCalledWith(
      'business-a', ['product-a'],
    )
    expect(current.database.saveMessage).toHaveBeenLastCalledWith(
      'business-a', '0990000001', 'assistant', 'Aquí está',
    )
  })

  it('deriva una etiqueta de pedido si el negocio es informativo', async () => {
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Tu pedido está confirmado',
              orderPayload: 'Producto A x1',
          hasSale: true,
          hasHandoffTag: false,
          isUncertain: false,
        }),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, takes_orders: false },
    }))

    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
    expect(current.actions.handleConversationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ hasSale: true }),
    )
    expect(current.send).toHaveBeenCalledWith(
      expect.stringContaining('Un asesor continuará'),
    )
    expect(current.send).not.toHaveBeenCalledWith('Tu pedido está confirmado')
  })

  it.each([
    [true, null],
    [false, 'No pude registrar el pedido'],
  ])('no envía confirmaciones de IA antes de validar un pedido (%s)', async (
    orderProcessed,
    expectedServerText,
  ) => {
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Tu pedido quedó confirmado',
              orderPayload: 'Producto A x1',
          hasSale: true,
          hasHandoffTag: false,
          isUncertain: false,
        }),
      },
      actions: {
        processOrderPayload: vi.fn().mockResolvedValue(orderProcessed),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, takes_orders: true },
    }))

    expect(current.actions.processOrderPayload).toHaveBeenCalledWith(
      expect.objectContaining({ payload: 'Producto A x1' }),
    )
    expect(current.send).not.toHaveBeenCalledWith('Tu pedido quedó confirmado')
    expect(current.database.saveMessage).not.toHaveBeenCalledWith(
      'business-a', '0990000001', 'assistant', 'Tu pedido quedó confirmado',
    )
    if (expectedServerText) {
      expect(current.send).toHaveBeenCalledWith(
        expect.stringContaining(expectedServerText),
      )
    }
  })

  it('prioriza handoff y no ejecuta acciones transaccionales', async () => {
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Texto que no debe salir',
          orderPayload: 'Producto A x1',
          hasSale: true,
          hasHandoffTag: true,
          isUncertain: true,
        }),
      },
      actions: {
        handleConversationOutcome: vi.fn().mockResolvedValue({ handled: true }),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, takes_orders: true },
    }))

    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
  })

  it('humaniza hasta tres bloques sin esperar en las pruebas', async () => {
    const current = setup()
    await current.conversation.humanizedSend(
      'Uno\n\nDos\n\nTres\n\nCuatro', current.send, current.sendTyping,
    )

    expect(current.send).toHaveBeenNthCalledWith(1, 'Uno\n\nDos')
    expect(current.send).toHaveBeenNthCalledWith(2, 'Tres')
    expect(current.send).toHaveBeenNthCalledWith(3, 'Cuatro')
    expect(current.sleep).toHaveBeenCalledTimes(3)
  })

  it('limita a cinco las consultas de productos mencionados', () => {
    const products = Array.from({ length: 7 }, (_, index) => ({
      id: `product-${index}`,
      name: `ProductoEspecial${index}`,
    }))
    const text = products.map(item => item.name).join(' ')

    expect(mentionedProductIds(products, text)).toEqual([
      'product-0', 'product-1', 'product-2', 'product-3', 'product-4',
    ])
  })

  it('mantiene conversación y entrada enlazadas directamente', () => {
    const service = fs.readFileSync(new URL('../src/services/bot-conversation.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('database.getSession(business.id, phone)')
    expect(service).toContain('database.searchProductsByVector(')
    expect(service).not.toContain('@ts-nocheck')
    expect(entry).toContain("require('./bot-conversation')")
  })

describe('el enlace de la mini app', () => {
  const conTienda = {
    ...business,
    slug: 'negocio-a',
    storefront_enabled: true,
  }

  // En modo IA no hay menú donde colgarlo, así que va como mensaje propio —
  // pero DESPUÉS de que el asistente responda, no antes.
  // Este test decía lo contrario hasta el 2026-08-02: el enlace se mandaba
  // DESPUÉS de que la IA hubiera respondido. Es decir, un negocio que eligió
  // atender por la app pagaba tokens en cada mensaje. Ahora el modo corta
  // antes del modelo y el enlace ES la respuesta.
  // El detalle del modo vive en `miniapp-sin-ia.test.js`.
  it('en modo MINI APP el enlace es la respuesta, sin pasar por la IA', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'miniapp' },
      text: 'hola',
    }))

    const mensajes = current.send.mock.calls.map(call => String(call[0]))
    expect(mensajes.some(m => m.includes('https://x.com/t/'))).toBe(true)
    expect(mensajes.some(m => m.includes('Respuesta final'))).toBe(false)
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  // Modo IA puro = atender y vender por chat. Quien quiera la app se pone en
  // modo 'miniapp'; si no, el enlace aparecería sin haberlo pedido.
  it('en modo IA puro NO se manda el enlace ni al saludar', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'ai' },
      text: 'hola',
    }))

    expect(current.storefrontLink.issueLink).not.toHaveBeenCalled()
    expect(current.send.mock.calls.map(c => c[0]).join('')).not.toContain('http')
  })

  // Antes, una pregunta concreta en modo mini app se respondía por IA y no se
  // mandaba enlace. Eso era exactamente lo que había que quitar: el negocio
  // eligió atender por la app, así que la pregunta tampoco se contesta.
  it('en modo mini app una pregunta concreta tampoco pasa por la IA', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'miniapp' },
      text: '¿tienen pizza sin gluten?',
    }))

    expect(current.ai.callAI).not.toHaveBeenCalled()
    const mensajes = current.send.mock.calls.map(call => String(call[0]))
    expect(mensajes.some(m => m.includes('Respuesta final'))).toBe(false)
  })

  // Sin tienda, sin BASE_URL o con la base caída, issueLink devuelve null: el
  // bot tiene que atender igual, como antes de que la tienda existiera.
  it('un fallo del enlace no tumba la conversación', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockRejectedValue(new Error('base caída')),
      },
    })

    await expect(current.conversation.processMessage(input(current, {
      business: conTienda,
      text: 'hola',
    }))).resolves.not.toThrow()

    expect(current.send.mock.calls.map(call => call[0]).join('')).toContain('Respuesta final')
  })
})

describe('el horario del dueño manda sobre todos los modos', () => {
  // Este bloque nace de un fallo real: un modo salía por su propia rama ANTES
  // de mirar el reloj, así que atendía domingos y de madrugada aunque el
  // horario dijera lo contrario. La comprobación va delante de TODOS los modos.
  it('en modo IA, fuera de horario tampoco llama a la IA', async () => {
    const current = setup({
      schedule: {
        isOutsideHours: vi.fn().mockReturnValue(true),
        buildScheduleMessage: vi.fn().mockReturnValue('Atendemos de 09:00 a 18:00'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business,
      text: 'hola',
    }))

    expect(current.ai.callAI).not.toHaveBeenCalled()
    expect(current.send).toHaveBeenCalledWith('Atendemos de 09:00 a 18:00')
  })

  // Fuera de horario tampoco se reparten enlaces: la tienda comprueba el
  // horario igual, así que el cliente abriría una tienda que no acepta pedidos.
  it('fuera de horario no se manda el enlace de la tienda', async () => {
    const current = setup({
      schedule: {
        isOutsideHours: vi.fn().mockReturnValue(true),
        buildScheduleMessage: vi.fn().mockReturnValue('Cerrado'),
      },
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'miniapp', slug: 'negocio-a', storefront_enabled: true },
      text: 'hola',
    }))

    expect(current.storefrontLink.issueLink).not.toHaveBeenCalled()
  })

})
})
