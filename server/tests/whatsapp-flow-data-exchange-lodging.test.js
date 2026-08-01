import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createWhatsAppFlowLodgingDataExchangeHandler,
} = require('../dist/services/whatsapp-flow-data-exchange-lodging')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const VERSION_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_ID = '10000000-0000-4000-8000-000000000003'
const QUOTE_ID = '20000000-0000-4000-8000-000000000001'
const ROOM_ID = '30000000-0000-4000-8000-000000000001'
const PREFERRED_ROOM_ID = '30000000-0000-4000-8000-000000000002'
const MANUAL_ROOM_ID = '30000000-0000-4000-8000-000000000003'
const TOKEN = 'opaque-lodging-flow-token_123456789'
const NOW = Date.parse('2026-07-28T12:00:00.000Z')
const NOT_SETTLED = Symbol('not-settled-before-next-turn')

const beforeNextTurn = promise => Promise.race([
  promise,
  new Promise(resolve => setImmediate(() => resolve(NOT_SETTLED))),
])

const stay = {
  checkIn: '2026-08-01',
  checkOut: '2026-08-03',
  adults: 2,
  children: 1,
  roomsCount: 1,
  nights: 2,
}

const automaticOption = {
  roomTypeId: ROOM_ID,
  name: 'Habitación Familiar',
  description: 'Baño privado',
  maxGuests: 4,
  availableUnits: 3,
  unitsRequired: 1,
  pricingModel: 'base_plus_extra',
  currency: 'USD',
  pricesIncludeTax: true,
  subtotal: 100,
  tax: 12,
  fees: 2,
  total: 102,
}

const preferredOption = {
  ...automaticOption,
  roomTypeId: PREFERRED_ROOM_ID,
  name: 'Suite Preferida',
  subtotal: 120,
  tax: 14.4,
  total: 122,
}

const manualOption = {
  ...automaticOption,
  roomTypeId: MANUAL_ROOM_ID,
  name: 'Suite Manual',
  pricingModel: 'manual',
  subtotal: null,
  tax: null,
  fees: null,
  total: null,
}

function normalizedQuote(overrides = {}) {
  return {
    quoteId: QUOTE_ID,
    ...stay,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    expiresAt: '2026-07-28T13:00:00.000Z',
    options: [automaticOption, preferredOption, manualOption],
    ...overrides,
  }
}

function rawQuote(overrides = {}) {
  const normalized = normalizedQuote()
  return {
    id: normalized.quoteId,
    business_id: BUSINESS_ID,
    contact_phone: `flow-session:${SESSION_ID}`,
    status: 'quoted',
    check_in: normalized.checkIn,
    check_out: normalized.checkOut,
    check_in_time: normalized.checkInTime,
    check_out_time: normalized.checkOutTime,
    adults: normalized.adults,
    children: normalized.children,
    rooms_count: normalized.roomsCount,
    nights: normalized.nights,
    expires_at: normalized.expiresAt,
    options: normalized.options.map(option => ({
      room_type_id: option.roomTypeId,
      name: option.name,
      description: option.description,
      max_guests: option.maxGuests,
      available_units: option.availableUnits,
      units_required: option.unitsRequired,
      pricing_model: option.pricingModel,
      currency: option.currency,
      prices_include_tax: option.pricesIncludeTax,
      subtotal: option.subtotal,
      tax: option.tax,
      fees: option.fees,
      total: option.total,
      available: true,
      closed: false,
    })),
    ...overrides,
  }
}

function fixture(overrides = {}) {
  let session = {
    id: SESSION_ID,
    business_id: BUSINESS_ID,
    provider: 'ycloud',
    flow_version_id: VERSION_ID,
    status: 'open',
    context: {
      capability: 'lodging',
      schema_version: 1,
    },
    context_revision: 0,
    expires_at: '2026-07-28T13:30:00.000Z',
    flow: { capability_key: 'lodging' },
    ...overrides.session,
  }
  const dependencies = {
    quoteLodging: vi.fn(async () => normalizedQuote()),
    getLodgingQuoteById: vi.fn(async () => rawQuote()),
    updateFlowSessionContext: vi.fn(async (
      businessId,
      provider,
      flowToken,
      expectedRevision,
      context,
    ) => {
      if (businessId !== BUSINESS_ID
        || provider !== 'ycloud'
        || flowToken !== TOKEN
        || expectedRevision !== session.context_revision) {
        return { result: 'stale', session }
      }
      session = {
        ...session,
        context,
        context_revision: session.context_revision + 1,
      }
      return { result: 'updated', session }
    }),
    recordFlowMetric: vi.fn(async () => true),
    now: () => NOW,
    ...overrides.dependencies,
  }
  const handler = createWhatsAppFlowLodgingDataExchangeHandler(dependencies)
  const business = {
    id: BUSINESS_ID,
    name: 'Hostal Vista Andina',
    active: true,
    bot_active: true,
    suspended: false,
    lodging_enabled: true,
    ...overrides.business,
  }
  const input = (request, sessionOverride = null) => ({
    request: {
      version: '3.0',
      flow_token: TOKEN,
      data: {},
      ...request,
    },
    session: sessionOverride || session,
    business,
  })
  return {
    business,
    dependencies,
    handler,
    input,
    session: () => session,
  }
}

async function createQuote(current) {
  return current.handler(current.input({
    action: 'data_exchange',
    screen: 'LODGING_GUESTS',
    data: {
      intent: 'quote_lodging',
      check_in: stay.checkIn,
      check_out: stay.checkOut,
      adults: String(stay.adults),
      children: String(stay.children),
      rooms_count: String(stay.roomsCount),
      total: '0.01',
    },
  }))
}

describe('data_exchange aislado del WhatsApp Flow de hospedaje', () => {
  it('inicializa las fechas con el calendario de Ecuador y el tenant resuelto', async () => {
    const current = fixture()

    const response = await current.handler(current.input({
      action: 'INIT',
    }))

    expect(response).toEqual({
      screen: 'LODGING_DATES',
      data: {
        business_name: 'Hostal Vista Andina',
        min_date: '2026-07-28',
        max_date: '2028-07-27',
        error_message: '',
      },
    })
    expect(current.dependencies.quoteLodging).not.toHaveBeenCalled()
    expect(current.dependencies.recordFlowMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        flowVersionId: VERSION_ID,
        eventType: 'lodging.step.init',
      }),
    )
  })

  it('valida el rango antes de pasar a huéspedes', async () => {
    const current = fixture()
    const valid = await current.handler(current.input({
      action: 'data_exchange',
      screen: 'LODGING_DATES',
      data: {
        intent: 'continue_lodging_dates',
        check_in: '2026-08-01',
        check_out: '2026-08-03',
      },
    }))
    const invalid = await current.handler(current.input({
      action: 'data_exchange',
      screen: 'LODGING_DATES',
      data: {
        intent: 'continue_lodging_dates',
        check_in: '2026-08-03',
        check_out: '2026-08-01',
      },
    }))

    expect(valid).toEqual({
      screen: 'LODGING_GUESTS',
      data: {
        check_in: '2026-08-01',
        check_out: '2026-08-03',
        stay_summary: 'Entrada: 2026-08-01 · Salida: 2026-08-03',
        error_message: '',
      },
    })
    expect(invalid.screen).toBe('LODGING_DATES')
    expect(invalid.data.error_message).toMatch(/entre 1 y 365 noches/)
  })

  it('cotiza con alias de sesión, guarda solo IDs canónicos y excluye tarifas manuales', async () => {
    const current = fixture()

    const response = await createQuote(current)

    expect(response.screen).toBe('LODGING_OPTIONS')
    expect(response.data.room_options).toEqual([
      expect.objectContaining({
        id: ROOM_ID,
        title: expect.stringContaining('Habitación Familiar'),
      }),
      expect.objectContaining({
        id: PREFERRED_ROOM_ID,
        title: expect.stringContaining('Suite Preferida'),
      }),
    ])
    expect(JSON.stringify(response.data.room_options))
      .not.toContain(MANUAL_ROOM_ID)
    expect(response.data.manual_notice).toMatch(/1 opción/)
    expect(current.dependencies.quoteLodging).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      contactPhone: `flow-session:${SESSION_ID}`,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      adults: stay.adults,
      children: stay.children,
      roomsCount: stay.roomsCount,
      idempotencyKey: expect.stringMatching(
        new RegExp(`^flow:${SESSION_ID}:[0-9a-f]{64}:0$`),
      ),
    })
    const context = current.session().context
    expect(context).toMatchObject({
      capability: 'lodging',
      lodging_search: {
        check_in: stay.checkIn,
        check_out: stay.checkOut,
        adults: 2,
        children: 1,
        rooms_count: 1,
        quote_id: QUOTE_ID,
      },
    })
    expect(context).not.toHaveProperty('contact_phone')
    expect(JSON.stringify(context)).not.toContain('0.01')
    expect(JSON.stringify(context)).not.toContain('102')
  })

  it('deduplica habitaciones y limita sus títulos dinámicos para Meta', async () => {
    const longOption = {
      ...automaticOption,
      name: `Habitación ${'muy larga '.repeat(8)}`,
    }
    const current = fixture({
      business: {
        name: 'N'.repeat(120),
      },
      dependencies: {
        quoteLodging: vi.fn(async () => normalizedQuote({
          options: [
            longOption,
            {
              ...longOption,
              name: 'Habitación duplicada',
            },
          ],
        })),
      },
    })

    const init = await current.handler(current.input({
      action: 'INIT',
    }))
    const response = await createQuote(current)

    expect([...init.data.business_name]).toHaveLength(80)
    expect(response.data.room_options).toHaveLength(1)
    expect(response.data.room_options[0].id).toBe(ROOM_ID)
    expect([...response.data.room_options[0].title].length)
      .toBeLessThanOrEqual(30)
  })

  it('persiste la cotización y responde sin esperar una métrica colgada', async () => {
    const current = fixture({
      dependencies: {
        recordFlowMetric: vi.fn(() => new Promise(() => {})),
      },
    })

    const response = await beforeNextTurn(createQuote(current))

    expect(response).not.toBe(NOT_SETTLED)
    expect(response).toMatchObject({ screen: 'LODGING_OPTIONS' })
    expect(current.session().context.lodging_search).toMatchObject({
      quote_id: QUOTE_ID,
      check_in: stay.checkIn,
      check_out: stay.checkOut,
    })
    expect(current.dependencies.updateFlowSessionContext).toHaveBeenCalledOnce()
  })

  it('conserva la habitación elegida y avanza a datos sin pedirla otra vez', async () => {
    const current = fixture({
      session: {
        context: {
          capability: 'lodging',
          schema_version: 1,
          preferred_room_type_id: PREFERRED_ROOM_ID,
        },
      },
    })

    const response = await createQuote(current)

    expect(response.screen).toBe('LODGING_DETAILS')
    expect(response.data.room_type_id).toBe(PREFERRED_ROOM_ID)
    expect(response.data.chosen_room_summary).toContain('Suite Preferida')
    expect(response.data).not.toHaveProperty('room_options')

    const manipulated = await current.handler(current.input({
      action: 'data_exchange',
      screen: 'LODGING_DETAILS',
      data: {
        intent: 'review_lodging',
        room_type_id: ROOM_ID,
        contact_name: 'Andrea Pérez',
        notes: '',
      },
    }))

    expect(manipulated.screen).toBe('LODGING_DETAILS')
    expect(manipulated.data.room_type_id).toBe(PREFERRED_ROOM_ID)
    expect(manipulated.data.error_message).toMatch(/no puede cambiarse/i)
  })

  it('fija quote y habitación en contexto e ignora IDs y total manipulados', async () => {
    const current = fixture()
    await createQuote(current)

    const response = await current.handler(current.input({
      action: 'data_exchange',
      screen: 'LODGING_OPTIONS',
      data: {
        intent: 'review_lodging',
        quote_id: '90000000-0000-4000-8000-000000000001',
        room_type_id: ROOM_ID,
        contact_name: 'Andrea Rosado',
        notes: 'Llegamos por la tarde',
        total: '0.01',
      },
    }))

    expect(current.dependencies.getLodgingQuoteById).toHaveBeenCalledWith(
      BUSINESS_ID,
      QUOTE_ID,
    )
    expect(response).toMatchObject({
      screen: 'LODGING_REVIEW',
      data: {
        flow_token: TOKEN,
        total: expect.stringMatching(/102/),
        notice: expect.stringMatching(/pendiente de confirmación/),
      },
    })
    expect(response.data.summary).toContain('Habitación Familiar')
    expect(current.session().context.lodging_draft).toEqual({
      quote_id: QUOTE_ID,
      room_type_id: ROOM_ID,
      contact_name: 'Andrea Rosado',
      notes: 'Llegamos por la tarde',
    })
    expect(JSON.stringify(current.session().context)).not.toContain('0.01')
    expect(JSON.stringify(current.session().context)).not.toContain(
      '90000000-0000-4000-8000-000000000001',
    )
  })

  it('no guarda un hospedaje con nombre de una sola letra', async () => {
    const current = fixture()
    await createQuote(current)

    const response = await current.handler(current.input({
      action: 'data_exchange',
      screen: 'LODGING_OPTIONS',
      data: {
        intent: 'review_lodging',
        room_type_id: ROOM_ID,
        contact_name: 'A',
      },
    }))

    expect(response.screen).toBe('LODGING_OPTIONS')
    expect(response.data.error_message).toMatch(/nombre válido/i)
    expect(current.session().context).not.toHaveProperty('lodging_draft')
  })

  it('devuelve validaciones recuperables dentro de la pantalla', async () => {
    const current = fixture()

    const response = await current.handler(current.input({
      action: 'data_exchange',
      screen: 'LODGING_GUESTS',
      data: {
        intent: 'quote_lodging',
        check_in: stay.checkIn,
        check_out: stay.checkOut,
        adults: '80',
        children: '30',
        rooms_count: '1',
      },
    }))

    expect(response.screen).toBe('LODGING_GUESTS')
    expect(response.data.error_message).toMatch(/superar 100 huéspedes/)
    expect(current.dependencies.quoteLodging).not.toHaveBeenCalled()
    expect(current.dependencies.updateFlowSessionContext)
      .not.toHaveBeenCalled()
  })

  it('no crea opciones automáticas ni inventa total si todas son manuales', async () => {
    const current = fixture({
      dependencies: {
        quoteLodging: vi.fn(async () => normalizedQuote({
          options: [manualOption],
        })),
      },
    })

    const response = await createQuote(current)

    expect(response.screen).toBe('LODGING_GUESTS')
    expect(response.data.error_message).toMatch(/tarifas.*por chat/i)
    expect(current.session().context.lodging_search.quote_id).toBe(QUOTE_ID)
    expect(JSON.stringify(response.data)).not.toContain('$0.00')
  })

  it('no trunca silenciosamente más de 200 habitaciones automáticas', async () => {
    const options = Array.from({ length: 201 }, (_, index) => ({
      ...automaticOption,
      roomTypeId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `Habitación ${index + 1}`,
    }))
    const current = fixture({
      dependencies: {
        quoteLodging: vi.fn(async () => normalizedQuote({ options })),
      },
    })

    const response = await createQuote(current)

    expect(response.screen).toBe('LODGING_GUESTS')
    expect(response.data.error_message).toMatch(
      /demasiadas habitaciones.*chat/i,
    )
    expect(current.dependencies.updateFlowSessionContext)
      .not.toHaveBeenCalled()
  })

  it('recupera un CAS stale si otro retry ya guardó la misma cotización', async () => {
    const fingerprint = 'a'.repeat(64)
    const staleSession = {
      id: SESSION_ID,
      business_id: BUSINESS_ID,
      provider: 'ycloud',
      flow_version_id: VERSION_ID,
      status: 'open',
      context_revision: 1,
      expires_at: '2026-07-28T13:30:00.000Z',
      flow: { capability_key: 'lodging' },
      context: {
        lodging_search: {
          fingerprint,
          check_in: stay.checkIn,
          check_out: stay.checkOut,
          adults: stay.adults,
          children: stay.children,
          rooms_count: stay.roomsCount,
          quote_id: QUOTE_ID,
          quote_expires_at: '2026-07-28T13:00:00.000Z',
        },
      },
    }
    const current = fixture({
      dependencies: {
        updateFlowSessionContext: vi.fn(async () => ({
          result: 'stale',
          session: staleSession,
        })),
      },
    })
    // Usa el fingerprint real calculado por el handler en la sesión que
    // devuelve CAS; se obtiene de la primera escritura propuesta.
    current.dependencies.updateFlowSessionContext.mockImplementation(
      async (_businessId, _provider, _token, _revision, context) => ({
        result: 'stale',
        session: {
          ...staleSession,
          context: {
            lodging_search: context.lodging_search,
          },
        },
      }),
    )

    const response = await createQuote(current)

    expect(response.screen).toBe('LODGING_OPTIONS')
    expect(response.data.error_message).toBe('')
    expect(current.dependencies.getLodgingQuoteById)
      .toHaveBeenCalledWith(BUSINESS_ID, QUOTE_ID)
  })

  it('reconstruye BACK desde quote_id del servidor y detecta expiración', async () => {
    const current = fixture()
    await createQuote(current)

    const back = await current.handler(current.input({
      action: 'BACK',
      screen: 'LODGING_REVIEW',
    }))
    expect(back.screen).toBe('LODGING_OPTIONS')
    expect(back.data.room_options).toHaveLength(2)

    current.dependencies.getLodgingQuoteById.mockResolvedValueOnce(rawQuote({
      expires_at: '2026-07-28T11:59:00.000Z',
    }))
    const expired = await current.handler(current.input({
      action: 'BACK',
      screen: 'LODGING_REVIEW',
    }))
    expect(expired.screen).toBe('LODGING_GUESTS')
    expect(expired.data.error_message).toMatch(/cotización venció/i)
  })

  it('infiere el paso de BACK cuando Meta omite screen', async () => {
    const current = fixture()
    await createQuote(current)

    const response = await current.handler(current.input({
      action: 'BACK',
    }))

    expect(response).toEqual({
      screen: 'LODGING_GUESTS',
      data: {
        check_in: stay.checkIn,
        check_out: stay.checkOut,
        stay_summary: `Entrada: ${stay.checkIn} · Salida: ${stay.checkOut}`,
        error_message: '',
      },
    })
  })

  it('falla cerrado para otra capability, sesión vencida o negocio suspendido', async () => {
    const wrong = fixture({
      session: { flow: { capability_key: 'order' } },
    })
    await expect(wrong.handler(wrong.input({ action: 'INIT' })))
      .rejects.toMatchObject({ status: 403 })

    const expired = fixture({
      session: { expires_at: '2026-07-28T11:00:00.000Z' },
    })
    await expect(expired.handler(expired.input({ action: 'INIT' })))
      .rejects.toMatchObject({ status: 410 })

    const suspended = fixture({
      business: { suspended: true },
    })
    await expect(suspended.handler(suspended.input({ action: 'INIT' })))
      .rejects.toMatchObject({ status: 403 })
  })
})
