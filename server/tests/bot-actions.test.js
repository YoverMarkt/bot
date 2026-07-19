import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const money = require('../dist/services/money')
const { createBotActions, guestWroteName, resolveRelativeStayDates } = require('../dist/services/bot-actions')

function setup(overrides = {}) {
  const database = {
    createBooking: vi.fn().mockResolvedValue({
      data: { id: 'booking-a' }, error: null, duplicate: false, conflict: false,
    }),
    upsertSession: vi.fn().mockResolvedValue({ error: null }),
    recordAiGap: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue({ error: null }),
    getProducts: vi.fn().mockResolvedValue([]),
    createOrder: vi.fn().mockResolvedValue({ data: { id: 'order-a' }, error: null }),
    ...overrides.database,
  }
  const lodging = {
    quoteLodging: vi.fn().mockResolvedValue({
      quoteId: 'quote-a',
      checkIn: '2026-08-10',
      checkOut: '2026-08-13',
      checkInTime: '15:00',
      checkOutTime: '11:00',
      adults: 2,
      children: 0,
      nights: 3,
      expiresAt: '2026-08-01T12:00:00Z',
      options: [{
        roomTypeId: '11111111-1111-4111-8111-111111111111',
        name: 'Habitación Doble',
        description: 'Baño privado',
        maxGuests: 2,
        availableUnits: 3,
        unitsRequired: 1,
        pricingModel: 'per_room',
        currency: 'USD',
        pricesIncludeTax: true,
        subtotal: 90,
        tax: 0,
        fees: 0,
        total: 90,
        amenities: ['Wi-Fi'],
        mediaUrls: ['https://cdn.example/doble.jpg'],
        nightlyRates: [],
        summary: null,
      }],
    }),
    requestLodging: vi.fn().mockResolvedValue({
      ok: true,
      request: {
        requestId: 'request-a',
        quoteId: 'quote-a',
        status: 'pending_owner',
        roomTypeId: '11111111-1111-4111-8111-111111111111',
        roomTypeName: 'Habitación Doble',
        checkIn: '2026-08-10',
        checkOut: '2026-08-13',
        checkInTime: '15:00',
        checkOutTime: '11:00',
        adults: 2,
        children: 0,
        nights: 3,
        unitsRequired: 1,
        currency: 'USD',
        subtotal: 90,
        tax: 0,
        fees: 0,
        total: 90,
        expiresAt: '2026-08-01T12:15:00Z',
      },
    }),
    ...overrides.lodging,
  }
  const logger = { log: vi.fn(), error: vi.fn() }
  const actions = createBotActions({
    database,
    money,
    lodging,
    logger,
  })
  return { actions, database, lodging, logger }
}

const business = {
  id: 'business-a', name: 'Negocio A', takes_bookings: true, takes_orders: true,
}
const product = {
  id: 'product-a', name: 'Producto A', price: '12.50', duration_minutes: 45,
}

describe('acciones de etiquetas del bot', () => {
  it('crea una reserva únicamente dentro del negocio resuelto', async () => {
    const { actions, database } = setup()
    const booking = {
      contactName: ' Ana ',
      bookingDateRaw: '2026-07-20',
      bookingTimeRaw: '09:30',
      service: ' Producto A ',
      bookingDate: '2026-07-20',
      bookingTime: '09:30',
    }

    await expect(actions.createBookingFromTag(
      business, '0990000001', booking, [product],
    )).resolves.toBe('created')

    expect(database.createBooking).toHaveBeenCalledWith('business-a', {
      contact_phone: '0990000001',
      contact_name: 'Ana',
      service: 'Producto A',
      booking_date: '2026-07-20',
      booking_time: '09:30',
      duration_minutes: 45,
      status: 'pending',
    })
    expect(database.createBooking).not.toHaveBeenCalledWith(
      'business-b', expect.anything(),
    )
  })

  it('no escribe una reserva con fecha u hora inválida', async () => {
    const { actions, database, logger } = setup()
    const invalid = {
      contactName: 'Ana', bookingDateRaw: 'mañana', bookingTimeRaw: 'tarde',
      service: 'Producto A', bookingDate: null, bookingTime: null,
    }

    await expect(actions.createBookingFromTag(
      business, '0990000001', invalid, [product],
    )).resolves.toBe('error')
    expect(database.createBooking).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      '❌ Error creando reserva:',
      'formato inválido: fecha="mañana" hora="tarde"',
    )
  })

  it('deja que la agenda resuelva la duración cuando el servicio es ambiguo', async () => {
    const { actions, database } = setup()
    const booking = {
      contactName: 'Ana', bookingDateRaw: '2026-07-20', bookingTimeRaw: '09:30',
      service: 'Consulta', bookingDate: '2026-07-20', bookingTime: '09:30',
    }

    await expect(actions.createBookingFromTag(
      business,
      '0990000001',
      booking,
      [
        { id: 'service-a', name: 'Consulta inicial', price: 20, duration_minutes: 30 },
        { id: 'service-b', name: 'Consulta control', price: 15, duration_minutes: 30 },
      ],
    )).resolves.toBe('created')

    expect(database.createBooking).toHaveBeenCalledWith('business-a', expect.objectContaining({
      duration_minutes: null,
    }))
  })

  it('ignora una etiqueta de reserva si el negocio no habilitó citas', async () => {
    const { actions, database, logger } = setup()
    const booking = {
      contactName: 'Ana', bookingDateRaw: '2026-07-20', bookingTimeRaw: '09:30',
      service: 'Producto A', bookingDate: '2026-07-20', bookingTime: '09:30',
    }

    await expect(actions.createBookingFromTag(
      { ...business, takes_bookings: false }, '0990000001', booking, [product],
    )).resolves.toBe('error')
    expect(database.createBooking).not.toHaveBeenCalled()
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('negocio sin reservas'))
  })

  it('distingue reintentos, conflictos y fallos sin anunciar una creación', async () => {
    const booking = {
      contactName: 'Ana', bookingDateRaw: '2026-07-20', bookingTimeRaw: '09:30',
      service: 'Producto A', bookingDate: '2026-07-20', bookingTime: '09:30',
    }
    const duplicate = setup({
      database: {
        createBooking: vi.fn().mockResolvedValue({
          data: { id: 'booking-a' }, error: null, duplicate: true, conflict: false,
        }),
      },
    })
    await expect(duplicate.actions.createBookingFromTag(
      business, '0990000001', booking, [product],
    )).resolves.toBe('duplicate')
    expect(duplicate.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Reserva ya registrada'),
    )
    expect(duplicate.logger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Reserva creada:'),
    )

    const conflict = setup({
      database: {
        createBooking: vi.fn().mockResolvedValue({
          data: null, error: null, duplicate: false, conflict: true,
        }),
      },
    })
    await expect(conflict.actions.createBookingFromTag(
      business, '0990000002', booking, [product],
    )).resolves.toBe('conflict')

    const failure = setup({
      database: {
        createBooking: vi.fn().mockResolvedValue({
          data: null, error: { message: 'sin conexión' },
        }),
      },
    })
    await expect(failure.actions.createBookingFromTag(
      business, '0990000003', booking, [product],
    )).resolves.toBe('error')
    expect(failure.logger.error).toHaveBeenCalledWith(
      '❌ Error creando reserva:', 'sin conexión',
    )
  })

  it('activa handoff, registra el hueco y responde sin cambiar de tenant', async () => {
    const { actions, database } = setup()
    const send = vi.fn().mockResolvedValue(undefined)

    const result = await actions.handleConversationOutcome({
      business,
      phone: '0990000001',
      originalText: 'Necesito una persona',
      hasSale: false,
      hasHandoffTag: true,
      isUncertain: true,
      wasManual: false,
      send,
    })

    expect(result).toEqual({ handled: true })
    expect(database.upsertSession).toHaveBeenCalledWith(
      'business-a',
      '0990000001',
      expect.objectContaining({ manual_mode: true, unread_owner: true }),
    )
    expect(database.recordAiGap).toHaveBeenCalledWith(
      'business-a', '0990000001', 'Necesito una persona', 'handoff',
    )
    expect(database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'assistant', expect.stringContaining('un asesor'),
    )
    expect(send).toHaveBeenCalledWith(expect.stringContaining('un asesor'))
  })

  it('diferencia venta confirmada de una conversación normal', async () => {
    const sale = setup()
    await sale.actions.handleConversationOutcome({
      business,
      phone: '0990000001',
      originalText: 'Gracias',
      hasSale: true,
      hasHandoffTag: false,
      isUncertain: false,
      send: vi.fn(),
    })
    expect(sale.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({ manual_mode: true }),
    )

    const normal = setup()
    await normal.actions.handleConversationOutcome({
      business,
      phone: '0990000001',
      originalText: '¿Qué precio tiene?',
      hasSale: false,
      hasHandoffTag: false,
      isUncertain: false,
      send: vi.fn(),
    })
    expect(normal.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({
        manual_mode: false, unread_owner: false,
      }),
    )
  })

  it('calcula y persiste un pedido mediante la operación atómica', async () => {
    const { actions, database } = setup()
    const send = vi.fn().mockResolvedValue(undefined)

    await expect(actions.processOrderPayload({
      business,
      phone: '0990000001',
      session: { contact_name: 'Ana' },
      payload: 'Producto A x2',
      products: [product],
      preFiltered: false,
      send,
    })).resolves.toBe(true)

    expect(database.createOrder).toHaveBeenCalledWith({
      business_id: 'business-a',
      contact_phone: '0990000001',
      contact_name: 'Ana',
      status: 'pendiente',
      subtotal: 25,
      discount: 0,
      total: 25,
    }, [{
      product_id: 'product-a',
      product_name: 'Producto A',
      quantity: 2,
      unit_price: 12.5,
      line_total: 25,
    }])
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Total: $25.00'))
    expect(send).toHaveBeenCalledWith(expect.stringContaining('coordinará con usted'))
    expect(database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'assistant', expect.stringContaining('Total: $25.00'),
    )
  })

  it('consulta el catálogo completo del mismo negocio cuando el RAG fue filtrado', async () => {
    const { actions, database } = setup({
      database: { getProducts: vi.fn().mockResolvedValue([product]) },
    })

    await actions.processOrderPayload({
      business,
      phone: '0990000001',
      payload: 'Producto A',
      products: [],
      preFiltered: true,
      send: vi.fn().mockResolvedValue(undefined),
    })

    expect(database.getProducts).toHaveBeenCalledWith('business-a')
    expect(database.getProducts).not.toHaveBeenCalledWith('business-b')
  })

  it('no crea pedidos informativos, ambiguos o sin precio', async () => {
    const informational = setup()
    await informational.actions.processOrderPayload({
      business: { ...business, takes_orders: false },
      phone: '0990000001',
      payload: 'Producto A',
      products: [product],
      preFiltered: false,
      send: vi.fn(),
    })
    expect(informational.database.createOrder).not.toHaveBeenCalled()

    const unresolved = setup()
    const send = vi.fn()
    await unresolved.actions.processOrderPayload({
      business,
      phone: '0990000001',
      payload: 'Producto desconocido',
      products: [product],
      preFiltered: false,
      send,
    })
    expect(unresolved.database.createOrder).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('cotiza hospedaje con totales oficiales y media sin crear pedido o cita', async () => {
    const { actions, database, lodging } = setup()
    const send = vi.fn().mockResolvedValue(undefined)
    const sendImage = vi.fn().mockResolvedValue(undefined)

    await expect(actions.processLodgingQuote({
      business: { ...business, lodging_enabled: true },
      phone: '0990000001',
      originalText: 'Somos dos del 10 al 13 de agosto',
      quote: {
        checkInRaw: '2026-08-10', checkOutRaw: '2026-08-13',
        roomsRaw: '2', roomsCount: 2,
        adultsRaw: '2', childrenRaw: '0',
        checkIn: '2026-08-10', checkOut: '2026-08-13',
        adults: 2, children: 0,
      },
      send,
      sendImage,
    })).resolves.toBe('quoted')

    expect(lodging.quoteLodging).toHaveBeenCalledWith({
      businessId: 'business-a',
      contactPhone: '0990000001',
      checkIn: '2026-08-10',
      checkOut: '2026-08-13',
      roomsCount: 2,
      adults: 2,
      children: 0,
    })
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Total oficial: $90.00'))
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Impuestos incluidos: $0.00'))
    expect(send).toHaveBeenCalledWith(expect.stringContaining(
      'Entrada: 2026-08-10 desde 15:00 · Salida: 2026-08-13 hasta 11:00',
    ))
    expect(send).toHaveBeenCalledWith(expect.stringContaining('todavía no confirma'))
    expect(sendImage).toHaveBeenCalledWith(
      'https://cdn.example/doble.jpg', 'Habitación Doble',
    )
    expect(database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({ manual_mode: false }),
    )
    expect(database.createBooking).not.toHaveBeenCalled()
    expect(database.createOrder).not.toHaveBeenCalled()
  })

  it('distingue impuestos adicionales en el resumen oficial', async () => {
    const current = setup({
      lodging: {
        quoteLodging: vi.fn().mockResolvedValue({
          quoteId: 'quote-tax', checkIn: '2026-08-10', checkOut: '2026-08-11',
          checkInTime: '15:00', checkOutTime: '11:00',
          adults: 2, children: 0, roomsCount: 1, nights: 1,
          options: [{
            roomTypeId: 'room-a', name: 'Doble', maxGuests: 2,
            availableUnits: 1, unitsRequired: 1, currency: 'USD',
            pricesIncludeTax: false, subtotal: 100, tax: 12, fees: 0, total: 112,
          }],
        }),
      },
    })
    const send = vi.fn().mockResolvedValue(undefined)

    await current.actions.processLodgingQuote({
      business: { ...business, lodging_enabled: true }, phone: '0990000001',
      originalText: 'Una habitación',
      quote: {
        checkInRaw: '2026-08-10', checkOutRaw: '2026-08-11',
        roomsRaw: '1', adultsRaw: '2', childrenRaw: '0',
        checkIn: '2026-08-10', checkOut: '2026-08-11',
        roomsCount: 1, adults: 2, children: 0,
      },
      send,
    })

    expect(send).toHaveBeenCalledWith(expect.stringContaining(
      'Impuestos adicionales: $12.00',
    ))
  })

  it('deriva una cotización con tarifa manual sin inventar total', async () => {
    const current = setup({
      lodging: {
        quoteLodging: vi.fn().mockResolvedValue({
          quoteId: 'quote-manual',
          checkIn: '2026-08-10', checkOut: '2026-08-13',
          checkInTime: '15:00', checkOutTime: '11:00',
          adults: 2, children: 0, nights: 3,
          options: [{
            roomTypeId: 'room-manual', name: 'Suite', maxGuests: 2,
            availableUnits: 1, unitsRequired: 1, currency: 'USD',
            subtotal: null, tax: null, fees: null, total: null,
          }],
        }),
      },
    })
    const send = vi.fn().mockResolvedValue(undefined)

    await expect(current.actions.processLodgingQuote({
      business: { ...business, lodging_enabled: true },
      phone: '0990000001',
      originalText: 'Cotízame una suite',
      quote: {
        checkInRaw: '2026-08-10', checkOutRaw: '2026-08-13',
        roomsRaw: '1', roomsCount: 1,
        adultsRaw: '2', childrenRaw: '0',
        checkIn: '2026-08-10', checkOut: '2026-08-13',
        adults: 2, children: 0,
      },
      send,
    })).resolves.toBe('handoff')

    expect(send).toHaveBeenCalledWith(expect.stringContaining('revisión manual'))
    expect(send.mock.calls.flat().join(' ')).not.toContain('Total')
    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({
        manual_mode: true, unread_owner: true,
      }),
    )
    expect(current.database.createOrder).not.toHaveBeenCalled()
  })

  it('maneja falta de disponibilidad sin confirmar ni derivar una reserva falsa', async () => {
    const unavailable = Object.assign(new Error('sin disponibilidad'), {
      code: 'unavailable',
    })
    const current = setup({
      lodging: { quoteLodging: vi.fn().mockRejectedValue(unavailable) },
    })
    const send = vi.fn().mockResolvedValue(undefined)

    await expect(current.actions.processLodgingQuote({
      business: { ...business, lodging_enabled: true },
      phone: '0990000001',
      originalText: 'Del 10 al 13',
      quote: {
        checkInRaw: '2026-08-10', checkOutRaw: '2026-08-13',
        roomsRaw: '1', roomsCount: 1,
        adultsRaw: '2', childrenRaw: '0',
        checkIn: '2026-08-10', checkOut: '2026-08-13',
        adults: 2, children: 0,
      },
      send,
    })).resolves.toBe('retry')

    expect(send).toHaveBeenCalledWith(expect.stringContaining('No hay habitaciones'))
    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({ manual_mode: false }),
    )
    expect(current.database.createBooking).not.toHaveBeenCalled()
  })

  it('crea solo el hold pendiente elegido, envía total y deriva al dueño', async () => {
    const { actions, database, lodging } = setup()
    const send = vi.fn().mockResolvedValue(undefined)

    await expect(actions.processLodgingRequest({
      business: { ...business, lodging_enabled: true },
      phone: '0990000001',
      originalText: 'Elijo la doble, soy Ana Pérez',
      request: {
        roomTypeIdOrName: 'Habitación Doble',
        contactName: 'Ana Pérez',
      },
      guestMessages: ['Elijo la doble, soy Ana Pérez'],
      send,
    })).resolves.toBe('requested')

    expect(lodging.requestLodging).toHaveBeenCalledWith({
      businessId: 'business-a',
      contactPhone: '0990000001',
      contactName: 'Ana Pérez',
      roomTypeName: 'Habitación Doble',
    })
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Total oficial: $90.00'))
    expect(send).toHaveBeenCalledWith(expect.stringContaining('pendiente de confirmación'))
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Todavía no está confirmada'))
    expect(database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({
        manual_mode: true, unread_owner: true,
      }),
    )
    expect(database.createBooking).not.toHaveBeenCalled()
    expect(database.createOrder).not.toHaveBeenCalled()
  })

  it('rechaza solicitudes con nombres que el huésped nunca escribió', async () => {
    const current = setup()
    const send = vi.fn().mockResolvedValue(undefined)

    await expect(current.actions.processLodgingRequest({
      business: { ...business, lodging_enabled: true },
      phone: '0990000001',
      originalText: 'si por favor',
      request: { roomTypeIdOrName: 'Suite Familiar', contactName: 'Familia García' },
      guestMessages: ['necesito habitaciones para mi familia', 'si por favor'],
      send,
    })).resolves.toBe('retry')

    // Nada se crea con un nombre inventado por la IA: se pide al huésped
    expect(current.lodging.requestLodging).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.stringContaining('solo me falta el nombre'))
    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({ manual_mode: false }),
    )
  })

  it('resuelve fechas relativas con el calendario, no con la opinión del modelo', () => {
    // Hoy sábado 2026-07-18: "del lunes al miércoles" = 20 → 22 aunque el modelo diga otra cosa
    expect(resolveRelativeStayDates(
      'desde el lunes hasta el miercoles 2 adultos y 3 niños', '2026-07-21', '2026-07-23', '2026-07-18',
    )).toEqual({ checkIn: '2026-07-20', checkOut: '2026-07-22' })
    // El modelo acertó → sin cambios
    expect(resolveRelativeStayDates(
      'del lunes al miércoles', '2026-07-20', '2026-07-22', '2026-07-18',
    )).toEqual({ checkIn: '2026-07-20', checkOut: '2026-07-22' })
    // Fecha explícita del cliente → se respeta al modelo
    expect(resolveRelativeStayDates(
      'del 21 de julio al 23 de julio', '2026-07-21', '2026-07-23', '2026-07-18',
    )).toEqual({ checkIn: '2026-07-21', checkOut: '2026-07-23' })
    // Un solo día mencionado conserva la cantidad de noches
    expect(resolveRelativeStayDates(
      'llegando el viernes por dos noches', '2026-07-23', '2026-07-25', '2026-07-18',
    )).toEqual({ checkIn: '2026-07-24', checkOut: '2026-07-26' })
    // Sin días de semana no se toca nada
    expect(resolveRelativeStayDates(
      'para esas fechas que te dije', '2026-08-01', '2026-08-03', '2026-07-18',
    )).toEqual({ checkIn: '2026-08-01', checkOut: '2026-08-03' })
  })

  it('valida el origen del nombre con acentos y palabras sueltas', () => {
    expect(guestWroteName('Ana Pérez', ['elijo la doble, soy ana perez'])).toBe(true)
    expect(guestWroteName('Yover', ['me llamo Yover, gracias'])).toBe(true)
    expect(guestWroteName('Familia García', ['habitaciones para mi familia', 'si por favor'])).toBe(false)
    expect(guestWroteName('Carlos', ['si por favor'])).toBe(false)
    expect(guestWroteName('', ['soy Ana'])).toBe(false)
  })

  it('deriva una solicitud de precio manual sin inventar un total', async () => {
    const current = setup({
      lodging: {
        requestLodging: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: 'manual_quote', message: 'precio manual' },
        }),
      },
    })
    const send = vi.fn().mockResolvedValue(undefined)

    await expect(current.actions.processLodgingRequest({
      business: { ...business, lodging_enabled: true },
      phone: '0990000001',
      originalText: 'Elijo la suite',
      request: { roomTypeIdOrName: 'Suite', contactName: 'Ana' },
      guestMessages: ['Elijo la suite, soy Ana'],
      send,
    })).resolves.toBe('handoff')

    expect(send).toHaveBeenCalledWith(expect.stringContaining('tarifa manual'))
    expect(send.mock.calls.flat().join(' ')).not.toContain('Total')
    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({ manual_mode: true }),
    )
  })

  it('mantiene las acciones aisladas en TypeScript', () => {
    const service = fs.readFileSync(new URL('../src/services/bot-actions.ts', import.meta.url), 'utf8')
    const conversation = fs.readFileSync(new URL('../src/services/bot-conversation.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('business_id: business.id')
    expect(service).toContain('database.createBooking(business.id')
    expect(service).toContain('database.recordAiGap(')
    expect(service).not.toContain('@ts-nocheck')
    expect(conversation).toContain("require('./bot-actions')")
    expect(entry).toContain("require('./bot-conversation')")
  })
})
