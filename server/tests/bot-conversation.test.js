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
      booking: null,
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
    createBookingFromTag: vi.fn().mockResolvedValue('none'),
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
  const logger = { log: vi.fn(), error: vi.fn() }
  const sleep = vi.fn().mockResolvedValue(undefined)
  const now = vi.fn().mockReturnValue(30_000_000)
  const conversation = createBotConversation({
    database, reports, schedule, ai, prompt, tags, actions, media,
    logger, sleep, now,
  })
  const send = vi.fn().mockResolvedValue(undefined)
  const sendImage = vi.fn().mockResolvedValue(undefined)
  const sendTyping = vi.fn().mockResolvedValue(undefined)
  const sendVideo = vi.fn().mockResolvedValue(undefined)
  return {
    conversation, database, reports, schedule, ai, prompt, tags, actions,
    media, logger, sleep, now, send, sendImage, sendTyping, sendVideo,
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
          finalText: '🏨 *Opciones de hospedaje* inventadas 💰 *Total oficial: $120.00*',
          booking: null, orderPayload: null, lodgingQuote: null, lodgingRequest: null,
          hasSale: false, hasHandoffTag: false, isUncertain: false, hasActionConflict: false,
        }),
      },
    })

    await current.conversation.processMessage(input(current))

    // El texto inventado JAMÁS llega al cliente; se falla cerrado derivando
    expect(current.send).not.toHaveBeenCalledWith(expect.stringContaining('Total oficial'))
    expect(current.actions.handleConversationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ isUncertain: true, hasSale: false }),
    )
    expect(current.actions.processLodgingQuote).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
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

  it('permite cotizar hospedaje fuera de horario después de informar el horario', async () => {
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
          booking: null,
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

    expect(current.send).toHaveBeenCalledWith('Horario del negocio')
    expect(current.ai.callAI).toHaveBeenCalledTimes(1)
    expect(current.actions.processLodgingQuote).toHaveBeenCalledWith({
      business: lodgingBusiness,
      phone: '0990000001',
      originalText: 'Somos dos del 10 al 13 de agosto',
      quote: lodgingQuote,
      guestMessages: ['Somos dos del 10 al 13 de agosto'],
      send: current.send,
      sendImage: current.sendImage,
      sendVideo: current.sendVideo,
    })
    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'user', 'Somos dos del 10 al 13 de agosto',
    )
    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'assistant', 'Horario del negocio',
    )
    expect(current.prompt.buildPrompt).toHaveBeenCalledWith(
      lodgingBusiness,
      [product],
      {},
      'Somos dos del 10 al 13 de agosto',
      null,
      [],
      false,
      false,
    )
    expect(current.actions.createBookingFromTag).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
  })

  it('mantiene preguntas de precio y media automatizadas en modo informativo', async () => {
    const current = setup({
      tags: {
        detectMediaRequest: vi.fn().mockReturnValue({
          wantsImage: true, wantsVideo: false,
        }),
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Cuesta $10.00 y está disponible.',
          booking: null,
          orderPayload: null,
          lodgingQuote: null,
          lodgingRequest: null,
          hasSale: false,
          hasHandoffTag: false,
          isUncertain: false,
          hasActionConflict: false,
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
    expect(current.actions.processOrderPayload).toHaveBeenCalledWith(
      expect.objectContaining({ payload: null }),
    )
  })

  it('procesa una cotización STAY sin ejecutar pedidos ni citas', async () => {
    const lodgingQuote = {
      checkInRaw: '2026-08-10', checkOutRaw: '2026-08-13',
      roomsRaw: '1', roomsCount: 1,
      adultsRaw: '2', childrenRaw: '1',
      checkIn: '2026-08-10', checkOut: '2026-08-13', adults: 2, children: 1,
    }
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Texto de IA que no debe salir',
          booking: null,
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
    }))

    expect(current.actions.processLodgingQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        business: lodgingBusiness,
        quote: lodgingQuote,
      }),
    )
    expect(current.actions.createBookingFromTag).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
    expect(current.send).not.toHaveBeenCalledWith('Texto de IA que no debe salir')
  })

  it('procesa la opción STAY elegida y deja el handoff a la acción segura', async () => {
    const lodgingRequest = {
      roomTypeIdOrName: 'Habitación Doble', contactName: 'Ana Pérez',
    }
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Reserva confirmada',
          booking: null,
          orderPayload: null,
          lodgingQuote: null,
          lodgingRequest,
          hasSale: false,
          hasHandoffTag: false,
          isUncertain: false,
          hasActionConflict: false,
        }),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, lodging_enabled: true, takes_orders: false },
    }))

    expect(current.actions.processLodgingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request: lodgingRequest,
        // El nombre solo puede validarse contra lo que escribió el huésped
        guestMessages: expect.arrayContaining(['¿Tienen Perfume Floral Intenso?']),
      }),
    )
    expect(current.actions.createBookingFromTag).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
    expect(current.send).not.toHaveBeenCalledWith('Reserva confirmada')
  })

  it('rechaza STAY combinado con BOOK, PEDIDO o HANDOFF sin efectos', async () => {
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Acciones mezcladas',
          booking: null,
          orderPayload: 'Producto A x1',
          lodgingQuote: {
            checkInRaw: '2026-08-10', checkOutRaw: '2026-08-13',
            roomsRaw: '1', roomsCount: 1,
            adultsRaw: '2', childrenRaw: '0',
            checkIn: '2026-08-10', checkOut: '2026-08-13', adults: 2, children: 0,
          },
          lodgingRequest: null,
          hasSale: true,
          hasHandoffTag: false,
          isUncertain: false,
          hasActionConflict: true,
        }),
      },
      actions: {
        handleConversationOutcome: vi.fn().mockResolvedValue({ handled: true }),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: {
        ...business, lodging_enabled: true, takes_bookings: true, takes_orders: true,
      },
    }))

    expect(current.actions.handleConversationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ hasSale: false, isUncertain: true }),
    )
    expect(current.actions.processLodgingQuote).not.toHaveBeenCalled()
    expect(current.actions.processLodgingRequest).not.toHaveBeenCalled()
    expect(current.actions.createBookingFromTag).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
  })

  it('mantiene RAG, acciones, pedido y media en el mismo tenant y orden lógico', async () => {
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
          booking: null,
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
      null,
      [],
      true,
      true,
    )
    expect(current.actions.createBookingFromTag).toHaveBeenCalledWith(
      business, '0990000001', null, [product],
    )
    expect(current.actions.processOrderPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        business,
        phone: '0990000001',
        payload: null,
        products: [product],
        preFiltered: true,
      }),
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

  it.each([
    ['duplicate', 'ya está registrada'],
    ['conflict', 'acaba de ocuparse'],
    ['error', 'de forma segura'],
  ])('reemplaza una confirmación falsa cuando la reserva termina en %s', async (
    bookingOutcome,
    expectedText,
  ) => {
    const booking = {
      contactName: 'Ana', bookingDateRaw: '2026-07-20', bookingTimeRaw: '09:30',
      service: 'Producto A', bookingDate: '2026-07-20', bookingTime: '09:30',
    }
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Perfecto, tu reserva está confirmada',
          booking,
          orderPayload: null,
          hasSale: false,
          hasHandoffTag: false,
          isUncertain: false,
        }),
      },
      actions: {
        createBookingFromTag: vi.fn().mockResolvedValue(bookingOutcome),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, takes_bookings: true },
      text: 'Confirmo las 09:30',
    }))

    expect(current.send).toHaveBeenCalledTimes(1)
    expect(current.send).toHaveBeenCalledWith(expect.stringContaining(expectedText))
    expect(current.send).not.toHaveBeenCalledWith(expect.stringContaining('está confirmada'))
    expect(current.database.saveMessage).toHaveBeenLastCalledWith(
      'business-a', '0990000001', 'assistant', expect.stringContaining(expectedText),
    )
    expect(current.actions.handleConversationOutcome).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
    expect(current.media.sendRequestedProductMedia).not.toHaveBeenCalled()
  })

  it('prioriza la reserva y no crea un pedido en la misma respuesta', async () => {
    const booking = {
      contactName: 'Ana', bookingDateRaw: '2026-07-20', bookingTimeRaw: '09:30',
      service: 'Corte', bookingDate: '2026-07-20', bookingTime: '09:30',
    }
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Registré tu solicitud de cita',
          booking,
          orderPayload: 'Corte x1',
          hasSale: true,
          hasHandoffTag: false,
          isUncertain: false,
        }),
      },
      actions: {
        createBookingFromTag: vi.fn().mockResolvedValue('created'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, takes_bookings: true, takes_orders: true },
      text: 'Confirmo el corte a las 09:30',
    }))

    expect(current.actions.handleConversationOutcome).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).not.toHaveBeenCalled()
    expect(current.send).toHaveBeenCalledWith(
      expect.stringContaining('todavía no procesé la compra'),
    )
    expect(current.send).not.toHaveBeenCalledWith(
      'Registré tu solicitud de cita',
    )
    expect(current.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('##PEDIDO## pospuesto'),
    )
  })

  it('ignora una reserva no habilitada y conserva un pedido válido', async () => {
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Reserva y pedido confirmados',
          booking: {
            contactName: 'Ana', bookingDateRaw: '2026-07-20', bookingTimeRaw: '09:30',
            service: 'Producto A', bookingDate: '2026-07-20', bookingTime: '09:30',
          },
          orderPayload: 'Producto A x1',
          hasSale: true,
          hasHandoffTag: false,
          isUncertain: false,
        }),
      },
      actions: {
        processOrderPayload: vi.fn().mockResolvedValue(true),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, takes_bookings: false, takes_orders: true },
    }))

    expect(current.actions.createBookingFromTag).not.toHaveBeenCalled()
    expect(current.actions.processOrderPayload).toHaveBeenCalledWith(
      expect.objectContaining({ payload: 'Producto A x1' }),
    )
    expect(current.send).toHaveBeenCalledWith(
      expect.stringContaining('Procesé únicamente el pedido'),
    )
    expect(current.send).not.toHaveBeenCalledWith('Reserva y pedido confirmados')
  })

  it('deriva una etiqueta de pedido si el negocio es informativo', async () => {
    const current = setup({
      tags: {
        parseBotOutput: vi.fn().mockReturnValue({
          finalText: 'Tu pedido está confirmado',
          booking: null,
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
          booking: null,
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
      business: { ...business, takes_bookings: true, takes_orders: true },
    }))

    expect(current.actions.createBookingFromTag).not.toHaveBeenCalled()
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
})
