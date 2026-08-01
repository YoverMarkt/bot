import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildAppointmentFlowJson,
} = require('../dist/services/whatsapp-flow-json-appointment')
const {
  createWhatsAppFlowAppointmentDataExchangeService,
} = require('../dist/services/whatsapp-flow-data-exchange-appointment')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const FLOW_VERSION_ID = '10000000-0000-4000-8000-000000000002'
const SERVICE_ID = '20000000-0000-4000-8000-000000000001'
const OTHER_SERVICE_ID = '20000000-0000-4000-8000-000000000002'
const TOKEN = 'valid-appointment-token_1234567890'
const NOT_SETTLED = Symbol('not-settled-before-next-turn')

const beforeNextTurn = promise => Promise.race([
  promise,
  new Promise(resolve => setImmediate(() => resolve(NOT_SETTLED))),
])

const availability = [
  { booking_date: '2099-01-15', booking_time: '09:00:00' },
  { booking_date: '2099-01-15', booking_time: '10:00' },
  { booking_date: '2099-01-16', booking_time: '11:30:00' },
  { booking_date: 'fecha-invalida', booking_time: '12:00' },
]

function appointmentServices(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    business_id: BUSINESS_ID,
    name: `Servicio ${index + 1}`,
    duration_minutes: 30,
    active: true,
  }))
}

function fixture(overrides = {}) {
  const baseSession = {
    id: '30000000-0000-4000-8000-000000000001',
    business_id: BUSINESS_ID,
    provider: 'ycloud',
    flow_version_id: FLOW_VERSION_ID,
    status: 'open',
    context: {},
    context_revision: 0,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    flow: {
      id: '40000000-0000-4000-8000-000000000001',
      flow_key: 'appointment_standard',
      capability_key: 'appointment',
      version: 1,
      provider_flow_id: 'provider-appointment-flow',
    },
  }
  let session = {
    ...baseSession,
    ...overrides.session,
    flow: {
      ...baseSession.flow,
      ...(overrides.session?.flow || {}),
    },
  }
  const dependencies = {
    getFlowSessionByToken: vi.fn(async () => session),
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
    getBusinessById: vi.fn(async () => ({
      id: BUSINESS_ID,
      name: 'Barbería Demo',
      active: true,
      bot_active: true,
      suspended: false,
      takes_bookings: true,
    })),
    getFlowAppointmentServices: vi.fn(async () => [
      {
        id: SERVICE_ID,
        business_id: BUSINESS_ID,
        name: 'Corte completo',
        duration_minutes: 45,
        active: true,
      },
      {
        id: OTHER_SERVICE_ID,
        business_id: 'otro-negocio',
        name: 'Servicio de otro tenant',
        duration_minutes: 15,
        active: true,
      },
    ]),
    getFlowAppointmentAvailability: vi.fn(async () => availability),
    recordFlowMetric: vi.fn(async () => true),
    ...overrides.dependencies,
  }
  return {
    dependencies,
    exchange: createWhatsAppFlowAppointmentDataExchangeService(dependencies),
    session: () => session,
  }
}

describe('appointment_standard', () => {
  it('declara SERVICE → DATE → TIME → DETAILS → REVIEW y termina como solicitud pendiente', () => {
    const json = buildAppointmentFlowJson()
    expect(json.version).toBe('7.3')
    expect(json.data_api_version).toBe('3.0')
    expect(json.screens.map(screen => screen.id)).toEqual([
      'APPOINTMENT_SERVICE',
      'APPOINTMENT_DATE',
      'APPOINTMENT_TIME',
      'APPOINTMENT_DETAILS',
      'APPOINTMENT_REVIEW',
    ])

    const review = json.screens.at(-1)
    const footer = review.layout.children.find(child => child.type === 'Footer')
    expect(review).toMatchObject({ terminal: true, success: true })
    expect(footer).toMatchObject({
      label: 'Enviar solicitud',
      'on-click-action': {
        name: 'complete',
        payload: { request_status: 'pending' },
      },
    })
    expect(JSON.stringify(review)).toMatch(/pendiente|confirmará/i)
    expect(JSON.stringify(review)).not.toMatch(/Confirmar cita/i)
  })

  it('inicializa con servicios tenant-safe y nunca incrusta opciones de otro negocio', async () => {
    const current = fixture()
    const response = await current.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
      data: {},
    })

    expect(response).toEqual({
      screen: 'APPOINTMENT_SERVICE',
      data: {
        business_name: 'Barbería Demo',
        services: [{
          id: SERVICE_ID,
          title: 'Corte completo · 45 min',
        }],
        error_message: '',
      },
    })
    expect(current.dependencies.getBusinessById).toHaveBeenCalledWith(BUSINESS_ID)
    expect(current.dependencies.getFlowAppointmentServices)
      .toHaveBeenCalledWith(BUSINESS_ID)
    expect(current.dependencies.recordFlowMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        eventType: 'step.init',
      }),
    )
  })

  it('deduplica servicios y limita textos dinámicos al contrato remoto', async () => {
    const current = fixture({
      dependencies: {
        getBusinessById: vi.fn(async () => ({
          id: BUSINESS_ID,
          name: 'N'.repeat(120),
          active: true,
          bot_active: true,
          suspended: false,
          takes_bookings: true,
        })),
        getFlowAppointmentServices: vi.fn(async () => [
          {
            id: SERVICE_ID,
            business_id: BUSINESS_ID,
            name: `Servicio ${'muy largo '.repeat(8)}`,
            duration_minutes: 45,
            active: true,
          },
          {
            id: SERVICE_ID,
            business_id: BUSINESS_ID,
            name: 'Duplicado',
            duration_minutes: 30,
            active: true,
          },
        ]),
      },
    })

    const response = await current.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
      data: {},
    })

    expect([...response.data.business_name]).toHaveLength(80)
    expect(response.data.services).toHaveLength(1)
    expect(response.data.services[0].id).toBe(SERVICE_ID)
    expect([...response.data.services[0].title].length)
      .toBeLessThanOrEqual(30)
  })

  it('construye el borrador canónico con CAS y revalida fecha/hora en cada paso', async () => {
    const current = fixture()

    const selectedService = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_SERVICE',
      flow_token: TOKEN,
      data: {
        intent: 'select_service',
        service_id: SERVICE_ID,
        service_name: 'Servicio manipulado',
        duration_minutes: 1,
      },
    })
    expect(selectedService).toMatchObject({
      screen: 'APPOINTMENT_DATE',
      data: {
        service_name: 'Corte completo',
        dates: [
          { id: '2099-01-15' },
          { id: '2099-01-16' },
        ],
      },
    })
    expect(current.dependencies.getFlowAppointmentAvailability)
      .toHaveBeenLastCalledWith({
        businessId: BUSINESS_ID,
        serviceId: SERVICE_ID,
        durationMinutes: 45,
        daysAhead: 30,
      })
    expect(current.session().context).toMatchObject({
      service_id: SERVICE_ID,
      service_name: 'Corte completo',
      duration_minutes: 45,
    })

    const selectedDate = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_DATE',
      flow_token: TOKEN,
      data: {
        intent: 'select_date',
        booking_date: '2099-01-15',
        service_id: OTHER_SERVICE_ID,
      },
    })
    expect(selectedDate).toMatchObject({
      screen: 'APPOINTMENT_TIME',
      data: {
        service_name: 'Corte completo',
        times: [
          { id: '09:00', title: '09:00' },
          { id: '10:00', title: '10:00' },
        ],
      },
    })
    expect(current.session().context).toMatchObject({
      service_id: SERVICE_ID,
      booking_date: '2099-01-15',
    })

    const selectedTime = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_TIME',
      flow_token: TOKEN,
      data: {
        intent: 'select_time',
        booking_time: '09:00',
        booking_date: '2099-01-16',
      },
    })
    expect(selectedTime).toMatchObject({
      screen: 'APPOINTMENT_DETAILS',
      data: {
        appointment_summary: expect.stringMatching(
          /Corte completo.*15\/01\/2099.*09:00/,
        ),
      },
    })

    const review = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_DETAILS',
      flow_token: TOKEN,
      data: {
        intent: 'review_appointment',
        contact_name: 'Andrea Pérez',
        notes: 'Prefiero tijera',
        service_name: 'Servicio manipulado',
        booking_date: '2099-01-16',
        booking_time: '10:00',
        request_status: 'confirmed',
      },
    })
    expect(review).toMatchObject({
      screen: 'APPOINTMENT_REVIEW',
      data: {
        service_id: SERVICE_ID,
        service_name: 'Corte completo',
        booking_date: '2099-01-15',
        booking_time: '09:00',
        contact_name: 'Andrea Pérez',
        notes: 'Prefiero tijera',
        request_status: 'pending',
        pending_notice: expect.stringMatching(/no es una cita confirmada/i),
      },
    })
    expect(current.session().context).toMatchObject({
      service_id: SERVICE_ID,
      service_name: 'Corte completo',
      duration_minutes: 45,
      booking_date: '2099-01-15',
      booking_time: '09:00',
      appointment_draft: {
        contact_name: 'Andrea Pérez',
        notes: 'Prefiero tijera',
        request_status: 'pending',
      },
    })
    expect(current.dependencies.updateFlowSessionContext).toHaveBeenCalledTimes(4)
  })

  it('persiste el servicio y responde sin esperar una métrica colgada', async () => {
    const current = fixture({
      dependencies: {
        recordFlowMetric: vi.fn(() => new Promise(() => {})),
      },
    })

    const response = await beforeNextTurn(current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_SERVICE',
      flow_token: TOKEN,
      data: {
        intent: 'select_service',
        service_id: SERVICE_ID,
      },
    }))

    expect(response).not.toBe(NOT_SETTLED)
    expect(response).toMatchObject({ screen: 'APPOINTMENT_DATE' })
    expect(current.session().context).toMatchObject({
      service_id: SERVICE_ID,
      service_name: 'Corte completo',
      duration_minutes: 45,
    })
    expect(current.dependencies.updateFlowSessionContext).toHaveBeenCalledOnce()
  })

  it('ofrece Cita general cuando no existen servicios configurados', async () => {
    const current = fixture({
      dependencies: {
        getFlowAppointmentServices: vi.fn(async () => []),
      },
    })
    const initialized = await current.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
    })
    expect(initialized.data.services).toEqual([{
      id: 'general',
      title: 'Cita general',
    }])

    const response = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_SERVICE',
      flow_token: TOKEN,
      data: {
        intent: 'select_service',
        service_id: 'general',
      },
    })
    expect(response.screen).toBe('APPOINTMENT_DATE')
    expect(current.dependencies.getFlowAppointmentAvailability)
      .toHaveBeenCalledWith({
        businessId: BUSINESS_ID,
        serviceId: null,
        durationMinutes: null,
        daysAhead: 30,
      })
    expect(current.session().context).toMatchObject({
      service_id: 'general',
      service_name: 'Cita general',
      duration_minutes: null,
    })
  })

  it('reconstruye BACK solo desde el contexto del servidor', async () => {
    const current = fixture({
      session: {
        context: {
          service_id: SERVICE_ID,
          service_name: 'Nombre anterior',
          duration_minutes: 1,
          booking_date: '2099-01-15',
          booking_time: '09:00',
          appointment_draft: {
            contact_name: 'Andrea',
            notes: null,
            request_status: 'pending',
          },
        },
        context_revision: 4,
      },
    })
    const response = await current.exchange({
      version: '3.0',
      action: 'BACK',
      screen: 'APPOINTMENT_REVIEW',
      flow_token: TOKEN,
      data: {
        service_id: OTHER_SERVICE_ID,
        service_name: 'Manipulado',
        booking_date: '2099-01-16',
        booking_time: '11:30',
      },
    })

    expect(response).toMatchObject({
      screen: 'APPOINTMENT_DETAILS',
      data: {
        appointment_summary: expect.stringMatching(
          /Corte completo.*15\/01\/2099.*09:00/,
        ),
      },
    })
    expect(current.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
  })

  it('rechaza una hora que no pertenece a la disponibilidad canónica', async () => {
    const current = fixture({
      session: {
        context: {
          service_id: SERVICE_ID,
          service_name: 'Corte completo',
          duration_minutes: 45,
          booking_date: '2099-01-15',
        },
        context_revision: 2,
      },
    })
    const response = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_TIME',
      flow_token: TOKEN,
      data: {
        intent: 'select_time',
        booking_time: '12:00',
      },
    })

    expect(response).toEqual({
      screen: 'APPOINTMENT_TIME',
      data: expect.objectContaining({
        times: [
          { id: '09:00', title: '09:00' },
          { id: '10:00', title: '10:00' },
        ],
        error_message: expect.stringMatching(/dejar de estar disponible/i),
      }),
    })
    expect(current.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
  })

  it('falla de forma visible ante CAS obsoleto y nunca filtra el token', async () => {
    const current = fixture({
      dependencies: {
        updateFlowSessionContext: vi.fn(async () => ({
          result: 'stale',
        })),
      },
    })
    const response = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT_SERVICE',
      flow_token: TOKEN,
      data: {
        intent: 'select_service',
        service_id: SERVICE_ID,
      },
    })

    expect(response).toEqual({
      screen: 'APPOINTMENT_SERVICE',
      data: expect.objectContaining({
        error_message: 'El formulario cambió. Intenta nuevamente.',
      }),
    })
    expect(JSON.stringify(response)).not.toContain(TOKEN)
  })

  it('no trunca silenciosamente más de 200 servicios', async () => {
    const current = fixture({
      dependencies: {
        getFlowAppointmentServices: vi.fn(async () => appointmentServices(201)),
      },
    })
    const response = await current.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
    })

    expect(response).toEqual({
      screen: 'APPOINTMENT_SERVICE',
      data: {
        business_name: 'Barbería Demo',
        services: [],
        error_message: expect.stringMatching(/demasiados.*continúa.*chat/i),
      },
    })
    expect(current.dependencies.getFlowAppointmentAvailability)
      .not.toHaveBeenCalled()
    expect(current.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
  })

  it('falla cerrado para otra capability, sesión expirada o negocio sin citas', async () => {
    const wrongCapability = fixture({
      session: { flow: { capability_key: 'order' } },
    })
    await expect(wrongCapability.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 403 })

    const expired = fixture({
      session: {
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    })
    await expect(expired.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 410 })

    const disabled = fixture({
      dependencies: {
        getBusinessById: vi.fn(async () => ({
          id: BUSINESS_ID,
          active: true,
          bot_active: true,
          suspended: false,
          takes_bookings: false,
        })),
      },
    })
    await expect(disabled.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 403 })
    expect(disabled.dependencies.getFlowAppointmentServices)
      .not.toHaveBeenCalled()
  })
})
