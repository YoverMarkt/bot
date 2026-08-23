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
      lodgingQuote: null,
      lodgingRequest: null,
      hasSale: false,
      hasHandoffTag: false,
      isUncertain: false,
      hasActionConflict: false,
    }),
    ...overrides.tags,
  }
  const actions = {
    handleConversationOutcome: vi.fn().mockResolvedValue({ handled: false }),
    processOrderPayload: vi.fn().mockResolvedValue(false),
    processLodgingQuote: vi.fn().mockResolvedValue('quoted'),
    processLodgingRequest: vi.fn().mockResolvedValue('requested'),
    ...overrides.actions,
  }
  const media = {
    sendRequestedProductMedia: vi.fn().mockResolvedValue(false),
    ...overrides.media,
  }
  const menuFlow = {
    advanceMenuFlow: vi.fn().mockReturnValue({ reply: 'Menú', options: [] }),
    ...overrides.menuFlow,
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
    database, reports, schedule, ai, prompt, tags, actions, media, menuFlow,
    storefrontLink, logger, sleep, now,
    ...(overrides.priceGuard ? { priceGuard: overrides.priceGuard } : {}),
  })
  const send = vi.fn().mockResolvedValue(undefined)
  const sendImage = vi.fn().mockResolvedValue(undefined)
  const sendTyping = vi.fn().mockResolvedValue(undefined)
  const sendVideo = vi.fn().mockResolvedValue(undefined)
  return {
    conversation, database, reports, schedule, ai, prompt, tags, actions,
    media, menuFlow, storefrontLink, logger, sleep, now,
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

  it('en modo menú conduce el código: sin IA y el dinero por el núcleo de siempre', async () => {
    const current = setup({
      database: {
        getPolicies: vi.fn().mockResolvedValue({
          welcome_message: '¡Hola! 👋 Soy Pía, de {{negocio}}.',
        }),
      },
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '🧾 Resumen de tu pedido',
          options: ['✅ Confirmar pedido', '🏠 Menú principal'],
          action: { type: 'order', summary: 'resumen', totalCents: 1950, payload: 'Pizza Hawaiana x2' },
        }),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: '1',
    }))

    // El saludo que escribió el dueño llega TAL CUAL al flujo: ya no se mina
    // un prompt con expresiones regulares para sacarlo.
    expect(current.menuFlow.advanceMenuFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        welcomeMessage: '¡Hola! 👋 Soy Pía, de {{negocio}}.',
      }),
    )
    expect(current.sendTyping).toHaveBeenCalledTimes(1)
    expect(current.sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      current.menuFlow.advanceMenuFlow.mock.invocationCallOrder[0],
    )
    // El total lo sigue calculando money.ts vía processOrderPayload: el menú
    // solo aporta QUÉ pidió el cliente, nunca un monto
    expect(current.actions.processOrderPayload).toHaveBeenCalledWith(
      expect.objectContaining({ payload: 'Pizza Hawaiana x2' }),
    )
    // Las opciones salen numeradas para que el cliente pueda responder "1"
    expect(current.send).toHaveBeenCalledWith(
      expect.stringContaining('1. ✅ Confirmar pedido'),
    )
  })

  it('continúa el modo menú si marcar el mensaje como leído falla', async () => {
    const current = setup()
    current.sendTyping.mockRejectedValueOnce(new Error('YCloud no disponible'))

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: 'hola',
    }))

    expect(current.sendTyping).toHaveBeenCalledTimes(1)
    expect(current.menuFlow.advanceMenuFlow).toHaveBeenCalledTimes(1)
    expect(current.send).toHaveBeenCalledWith('Menú')
  })

  it('el modo menú manda botones nativos y cae a texto numerado si el canal no puede', async () => {
    const flujo = {
      advanceMenuFlow: vi.fn().mockReturnValue({
        reply: 'Estas son nuestras habitaciones 👇',
        options: [{ title: 'Matrimonial', description: '$35.00/noche' }, '⬅️ Volver'],
      }),
    }

    // Canal con soporte nativo: no se envía el texto numerado
    const nativo = setup({ menuFlow: flujo })
    const sendOptions = vi.fn().mockResolvedValue(true)
    await nativo.conversation.processMessage(input(nativo, {
      business: { ...business, chat_mode: 'menu' },
      text: 'hola',
      sendOptions,
    }))
    expect(sendOptions).toHaveBeenCalledWith(
      'Estas son nuestras habitaciones 👇',
      [
        { id: '1', title: 'Matrimonial', description: '$35.00/noche' },
        { id: '2', title: '⬅️ Volver', description: undefined },
      ],
    )
    expect(nativo.send).not.toHaveBeenCalled()

    // Canal sin soporte (o falla el envío): las opciones van numeradas
    const texto = setup({ menuFlow: flujo })
    await texto.conversation.processMessage(input(texto, {
      business: { ...business, chat_mode: 'menu' },
      text: 'hola',
      sendOptions: vi.fn().mockResolvedValue(false),
    }))
    expect(texto.send).toHaveBeenCalledWith(
      expect.stringContaining('1. Matrimonial — $35.00/noche'),
    )
  })

  it('envía todas las fotos, luego el video y al final el CTA en modo directo', async () => {
    const media = [
      ...Array.from({ length: 5 }, (_, index) => ({
        url: `https://cdn.example.com/foto-${index + 1}.jpg`,
        isVideo: false,
      })),
      { url: 'https://cdn.example.com/recorrido.mp4', isVideo: true },
    ]
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '📷 Aquí tienes las fotos y el video. ¿Cotizamos tus fechas?',
          options: ['📅 Cotizar estadía'],
          media,
        }),
      },
    })
    const events = []
    const sendImage = vi.fn(async url => { events.push(`image:${url}`) })
    const sendVideo = vi.fn(async url => { events.push(`video:${url}`) })
    const sendOptions = vi.fn(async () => {
      events.push('cta')
      return true
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: '📷 Fotos y videos',
      sendImage,
      sendVideo,
      sendOptions,
    }))

    expect(events).toEqual([
      ...media.slice(0, 5).map(item => `image:${item.url}`),
      `video:${media[5].url}`,
      'cta',
    ])
    for (const [url] of media.slice(0, 5).map(item => [item.url])) {
      expect(sendImage).toHaveBeenCalledWith(url, undefined, 'direct')
    }
    expect(sendVideo).toHaveBeenCalledWith(
      'https://cdn.example.com/recorrido.mp4',
      undefined,
      'direct',
    )
    expect(sendOptions).toHaveBeenCalledWith(
      '📷 Aquí tienes las fotos y el video. ¿Cotizamos tus fechas?',
      [{ id: '1', title: '📅 Cotizar estadía', description: undefined }],
      'direct',
    )
    expect(current.send).not.toHaveBeenCalled()
  })

  it('no adelanta el CTA mientras el último video todavía se está enviando', async () => {
    let releaseVideo
    const pendingVideo = new Promise(resolve => { releaseVideo = resolve })
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '¿Cotizamos tus fechas?',
          options: ['📅 Cotizar estadía'],
          media: [
            { url: 'https://cdn.example.com/foto.jpg', isVideo: false },
            { url: 'https://cdn.example.com/recorrido.mp4', isVideo: true },
          ],
        }),
      },
    })
    const sendOptions = vi.fn().mockResolvedValue(true)
    const sendVideo = vi.fn().mockReturnValue(pendingVideo)

    const processing = current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: '📷 Fotos y videos',
      sendVideo,
      sendOptions,
    }))

    await vi.waitFor(() => expect(sendVideo).toHaveBeenCalledOnce())
    expect(sendOptions).not.toHaveBeenCalled()

    releaseVideo()
    await processing

    expect(sendOptions).toHaveBeenCalledOnce()
    expect(sendVideo.mock.invocationCallOrder[0]).toBeLessThan(
      sendOptions.mock.invocationCallOrder[0],
    )
  })

  it('el modo menú deriva a una persona con la misma ruta que el resto del bot', async () => {
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '', options: [], action: { type: 'handoff' },
        }),
      },
      actions: { handleConversationOutcome: vi.fn().mockResolvedValue({ handled: true }) },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: 'asesor',
    }))

    expect(current.actions.handleConversationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ hasHandoffTag: true }),
    )
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  it('reemplaza la confirmación optimista del menú cuando el pedido no se creó', async () => {
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '¡Pedido recibido! 🙌',
          options: ['🛒 Hacer un pedido', '💬 Escribir al local'],
          action: {
            type: 'order',
            summary: 'resumen',
            totalCents: 1000,
            payload: 'Producto A x1',
            items: [{ name: 'Producto A', qty: 1 }],
          },
        }),
      },
      actions: { processOrderPayload: vi.fn().mockResolvedValue(false) },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: '✅ Confirmar pedido',
    }))

    expect(current.send).toHaveBeenCalledWith(
      expect.stringContaining('No pude confirmar de forma segura'),
    )
    expect(current.send).toHaveBeenCalledWith(
      expect.stringContaining('evitar duplicarlo'),
    )
    expect(current.send).not.toHaveBeenCalledWith(
      expect.stringContaining('Pedido recibido'),
    )
  })

  it('conserva el resumen oficial del pedido sin duplicar una segunda confirmación', async () => {
    const processOrderPayload = vi.fn().mockImplementation(async ({ send }) => {
      await send('🧾 Resumen oficial — Total: $10.00')
      return true
    })
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '¡Pedido recibido! 🙌',
          options: ['🛒 Hacer un pedido'],
          action: {
            type: 'order',
            summary: 'resumen',
            totalCents: 1000,
            payload: 'Producto A x1',
            items: [{ name: 'Producto A', qty: 1 }],
          },
        }),
      },
      actions: { processOrderPayload },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: '✅ Confirmar pedido',
    }))

    expect(current.send).toHaveBeenCalledWith('🧾 Resumen oficial — Total: $10.00')
    expect(current.send).not.toHaveBeenCalledWith(
      expect.stringContaining('Pedido recibido'),
    )
    expect(current.send).toHaveBeenCalledWith(
      expect.stringContaining('¿Necesitas algo más?'),
    )
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


  // Vigilante de precios (regla inviolable #8). Arranca en modo observación a
  // propósito: un falso positivo cortaría la conversación de un cliente real.

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

  // Antes el hospedaje era una excepción que atendía siempre, y eso convertía
  // el horario del dueño en decoración: no podía apagar el bot ni queriendo.
  // Ahora manda su configuración; para cotizar de madrugada pone 00:00-23:59.
  it('el hospedaje también calla fuera de horario: manda el horario del dueño', async () => {
    const lodgingQuote = {
      checkInRaw: '2026-08-10', checkOutRaw: '2026-08-13',
      roomsRaw: '1', roomsCount: 1,
      adultsRaw: '2', childrenRaw: '0',
      checkIn: '2026-08-10', checkOut: '2026-08-13', adults: 2, children: 0,
    }
    const current = setup({
      schedule: { isOutsideHours: vi.fn().mockReturnValue(true) },
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Consultando',
              orderPayload: null,
          lodgingQuote,
          lodgingRequest: null,
          hasSale: false,
          hasHandoffTag: false,
          isUncertain: false,
          hasActionConflict: false,
        }),
      },
    })
    const lodgingBusiness = { ...business, lodging_enabled: true, takes_orders: false }

    await current.conversation.processMessage(input(current, {
      business: lodgingBusiness,
      text: 'Somos dos del 10 al 13 de agosto',
    }))

    // Informa el horario y se detiene ahí: ni IA ni cotización.
    expect(current.send).toHaveBeenCalledWith('Horario del negocio')
    expect(current.ai.callAI).not.toHaveBeenCalled()
    expect(current.actions.processLodgingQuote).not.toHaveBeenCalled()

    // La conversación se guarda igual, para que el dueño la vea al abrir.
    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'user', 'Somos dos del 10 al 13 de agosto',
    )
    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'assistant', 'Horario del negocio',
    )
  })




  // ⚠️ Aquí vivían las pruebas del MODO IA: el resumen oficial imitado, el
  // vigilante de precios, el RAG, las etiquetas de pedido del modelo y las
  // confirmaciones antes de validar. Se fueron con la IA el 2026-08-21.
  // Lo que protegían —que ningún monto salga sin pasar por el servidor—
  // ahora es estructural: no queda nada capaz de escribir un precio.


  it('prioriza handoff y no ejecuta acciones transaccionales', async () => {
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Texto que no debe salir',
          booking: {
            contactName: 'Ana', bookingDateRaw: '2026-07-20', bookingTimeRaw: '09:30',
            service: 'Corte', bookingDate: '2026-07-20', bookingTime: '09:30',
          },
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
    expect(service).not.toContain('@ts-nocheck')
    // ⚠️ El RAG (`searchProductsByVector`) se fue con la IA el 2026-08-21.
    // Se comprueba que NO vuelva: era la vía por la que el catálogo entraba
    // en un prompt.
    expect(service).not.toContain('database.searchProductsByVector(')
    expect(service).not.toMatch(/callAI|buildPrompt/)
    expect(entry).toContain("require('./bot-conversation')")
  })

describe('el enlace de la mini app', () => {
  const conTienda = {
    ...business,
    slug: 'negocio-a',
    storefront_enabled: true,
  }

  // ⚠️ REGRESIÓN REPORTADA: un hostal en modo menú recibía el menú de botones
  // Y el enlace a la vez — dos formas de hacer lo mismo compitiendo en el
  // mismo chat. El enlace pertenece SOLO al modo mini app.
  it('NO acompaña la bienvenida del modo menú', async () => {
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '¡Hola! 👋',
          options: ['🛒 Hacer un pedido'],
          isWelcome: true,
        }),
      },
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'menu' },
      text: 'hola',
    }))

    const enviado = current.send.mock.calls.map(call => call[0]).join('\n')
    expect(enviado).toContain('¡Hola! 👋')
    expect(enviado).not.toContain('http')
    expect(current.storefrontLink.issueLink).not.toHaveBeenCalled()
  })

  it('no lo repite en cada paso del menú', async () => {
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: 'Elige un producto',
          options: ['Pizza'],
        }),
      },
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'menu' },
      text: '1',
    }))

    expect(current.storefrontLink.issueLink).not.toHaveBeenCalled()
    expect(current.send.mock.calls.map(call => call[0]).join('')).not.toContain('http')
  })

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
  it('sin enlace disponible el mensaje sale intacto', async () => {
    const current = setup({
      menuFlow: {
        advanceMenuFlow: vi.fn().mockReturnValue({
          reply: '¡Hola! 👋',
          options: ['🛒 Hacer un pedido'],
          isWelcome: true,
        }),
      },
      storefrontLink: { issueLink: vi.fn().mockResolvedValue(null) },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'menu' },
      text: 'hola',
    }))

    const enviado = current.send.mock.calls.map(call => call[0]).join('')
    expect(enviado).toContain('¡Hola! 👋')
    expect(enviado).not.toContain('http')
    // Sin líneas en blanco de más donde iba a ir el enlace.
    expect(enviado).not.toMatch(/\n{3,}/)
  })

  it('un fallo del enlace no tumba la conversación', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockRejectedValue(new Error('base caída')),
      },
    })

    await expect(current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'miniapp' },
      text: 'hola',
    }))).resolves.not.toThrow()

    // ⚠️ Antes aquí se comprobaba que la IA respondía igualmente. Con la IA
    // retirada lo que importa es que el fallo no tumbe el proceso: el cliente
    // se queda sin enlace, pero el error queda registrado y nada revienta.
  })
})

describe('el horario del dueño manda sobre todos los modos', () => {
  // Este test nace de un fallo real: el modo menú salía por su propia rama
  // ANTES de mirar el reloj, así que un negocio con el menú activado atendía
  // domingos y de madrugada aunque su horario dijera lo contrario. No se veía
  // porque el modo IA sí lo respetaba y nadie probó el otro camino.
  it('en modo menú, fuera de horario NO conduce el menú y manda los horarios', async () => {
    const current = setup({
      schedule: {
        isOutsideHours: vi.fn().mockReturnValue(true),
        buildScheduleMessage: vi.fn().mockReturnValue('Atendemos de 09:00 a 18:00'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: 'hola',
    }))

    expect(current.menuFlow.advanceMenuFlow).not.toHaveBeenCalled()
    expect(current.send).toHaveBeenCalledWith('Atendemos de 09:00 a 18:00')
    expect(current.send).toHaveBeenCalledTimes(1)
  })

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
      business: { ...business, chat_mode: 'menu', slug: 'negocio-a', storefront_enabled: true },
      text: 'hola',
    }))

    expect(current.storefrontLink.issueLink).not.toHaveBeenCalled()
  })

  it('dentro de horario el modo menú funciona con normalidad', async () => {
    const current = setup()

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'menu' },
      text: 'hola',
    }))

    expect(current.menuFlow.advanceMenuFlow).toHaveBeenCalledTimes(1)
    expect(current.send).toHaveBeenCalledWith('Menú')
  })
})
})
