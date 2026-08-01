import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createWhatsAppFlowResponseProcessor,
} = require('../dist/services/whatsapp-flow-runtime')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const SESSION_ID = '10000000-0000-4000-8000-000000000002'
const VERSION_ID = '10000000-0000-4000-8000-000000000003'
const SUBMISSION_ID = '10000000-0000-4000-8000-000000000004'
const RESOURCE_ID = '20000000-0000-4000-8000-000000000001'
const ROOM_ID = '30000000-0000-4000-8000-000000000001'
const QUOTE_ID = '40000000-0000-4000-8000-000000000001'
const SERVICE_ID = '50000000-0000-4000-8000-000000000001'
const TOKEN = 'opaque-flow-token_123456789'

function setup(capability, context, overrides = {}) {
  const dependencies = {
    getBusinessById: vi.fn(async () => ({
      id: BUSINESS_ID,
      name: 'Negocio Demo',
      active: true,
      bot_active: true,
      suspended: false,
      takes_orders: capability === 'order',
      takes_bookings: capability === 'appointment',
      lodging_enabled: capability === 'lodging',
    })),
    getFlowSessionByToken: vi.fn(async () => ({
      id: SESSION_ID,
      business_id: BUSINESS_ID,
      provider: 'ycloud',
      flow_version_id: VERSION_ID,
      status: 'open',
      context_revision: 3,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      context,
      flow: {
        id: '60000000-0000-4000-8000-000000000001',
        flow_key: `${capability}_standard`,
        capability_key: capability,
        version: 1,
      },
    })),
    recordFlowSubmission: vi.fn(async () => ({
      created: true,
      submission: {
        id: SUBMISSION_ID,
        processing_status: 'received',
      },
    })),
    completeFlowSubmission: vi.fn(async () => ({})),
    createOrderFromFlowSubmission: vi.fn(),
    createBookingFromFlowSubmission: vi.fn(async () => ({
      result: 'created',
      created: true,
      booking: {
        id: RESOURCE_ID,
        service: 'Corte',
        booking_date: '2026-08-05',
        booking_time: '10:00:00',
      },
    })),
    createLodgingRequestFromFlowSubmission: vi.fn(async () => ({
      result: 'created',
      created: true,
      request: {
        id: RESOURCE_ID,
        room_type_name: 'Suite',
        check_in: '2026-08-05',
        check_out: '2026-08-07',
        total: 80,
        currency: 'USD',
      },
    })),
    createLeadFromFlowSubmission: vi.fn(async () => ({
      result: 'created',
      created: true,
      lead: {
        id: RESOURCE_ID,
        topic: 'Cotización',
      },
    })),
    getContactHistory: vi.fn(async () => []),
    saveMessage: vi.fn(async () => ({ error: null })),
    upsertSession: vi.fn(async () => ({})),
    recordFlowMetric: vi.fn(async () => true),
    sendText: vi.fn(async () => undefined),
    ...overrides,
  }
  return {
    dependencies,
    processor: createWhatsAppFlowResponseProcessor(dependencies),
    input: {
      businessId: BUSINESS_ID,
      provider: 'ycloud',
      from: '593990001234',
      inboundId: `wamid-${capability}`,
      channelAddress: {
        provider: 'ycloud',
        identifierType: 'phone',
        identifier: '593999999999',
      },
      response: {
        flow_token: TOKEN,
        business_id: 'tenant-atacante',
        total: 0.01,
        booking_time: '00:00',
      },
    },
  }
}

describe('runtime de capacidades WhatsApp Flow', () => {
  it('crea la cita desde el draft servidor e ignora el terminal manipulado', async () => {
    const current = setup('appointment', {
      service_id: SERVICE_ID,
      service_name: 'Corte',
      booking_date: '2026-08-05',
      booking_time: '10:00',
      appointment_draft: {
        contact_name: 'Andrea',
        notes: null,
        request_status: 'pending',
      },
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.createBookingFromFlowSubmission)
      .toHaveBeenCalledWith({
        businessId: BUSINESS_ID,
        submissionId: SUBMISSION_ID,
        contactPhone: '593990001234',
      })
    expect(current.dependencies.createOrderFromFlowSubmission)
      .not.toHaveBeenCalled()
    expect(current.dependencies.sendText.mock.calls[0][2])
      .toContain('pendiente')
    expect(current.dependencies.upsertSession).toHaveBeenCalledWith(
      BUSINESS_ID,
      '593990001234',
      expect.not.objectContaining({ manual_mode: expect.anything() }),
    )
  })

  it('crea hospedaje fijado a quote/room del contexto y no al teléfono', async () => {
    const current = setup('lodging', {
      lodging_search: { quote_id: QUOTE_ID },
      lodging_draft: {
        quote_id: QUOTE_ID,
        room_type_id: ROOM_ID,
        contact_name: 'Andrea',
        notes: null,
      },
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.createLodgingRequestFromFlowSubmission)
      .toHaveBeenCalledWith({
        businessId: BUSINESS_ID,
        submissionId: SUBMISSION_ID,
        contactPhone: '593990001234',
      })
    expect(current.dependencies.sendText.mock.calls[0][2])
      .toContain('Total oficial')
    expect(current.dependencies.upsertSession).toHaveBeenCalledWith(
      BUSINESS_ID,
      '593990001234',
      expect.not.objectContaining({ manual_mode: expect.anything() }),
    )
  })

  it('registra lead estructurado, alerta al dueño y confirma al contacto', async () => {
    const current = setup('lead', {
      lead_draft: {
        schema_version: 1,
        contact_name: 'Andrea',
        topic_id: 'cotizacion',
        topic_label: 'Cotización',
        details: 'Necesito una propuesta',
        email: 'andrea@example.com',
        preferred_time: null,
      },
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.createLeadFromFlowSubmission)
      .toHaveBeenCalledOnce()
    expect(current.dependencies.saveMessage).toHaveBeenCalledWith(
      BUSINESS_ID,
      '593990001234',
      'user',
      expect.stringContaining('Necesito una propuesta'),
    )
    expect(current.dependencies.upsertSession).toHaveBeenCalledWith(
      BUSINESS_ID,
      '593990001234',
      expect.objectContaining({ manual_mode: true, unread_owner: true }),
    )
  })

  it('rechaza un horario ocupado solo después de avisar por WhatsApp', async () => {
    const current = setup('appointment', {
      service_id: SERVICE_ID,
      service_name: 'Corte',
      booking_date: '2026-08-05',
      booking_time: '10:00',
      appointment_draft: {
        contact_name: 'Andrea',
        notes: null,
        request_status: 'pending',
      },
    }, {
      createBookingFromFlowSubmission: vi.fn(async () => ({
        result: 'conflict',
        created: false,
        booking: null,
      })),
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.sendText).toHaveBeenCalledOnce()
    expect(current.dependencies.completeFlowSubmission).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      submissionId: SUBMISSION_ID,
      status: 'rejected',
      errorCode: 'slot_unavailable',
    })
  })

  it('mantiene el submission reintentable si falla el aviso de rechazo', async () => {
    const current = setup('lodging', {
      lodging_draft: {
        quote_id: QUOTE_ID,
        room_type_id: ROOM_ID,
        contact_name: 'Andrea',
        notes: null,
      },
    }, {
      createLodgingRequestFromFlowSubmission: vi.fn(async () => ({
        result: 'quote_expired',
        created: false,
        request: null,
      })),
      sendText: vi.fn(async () => {
        throw new Error('YCloud temporalmente no disponible')
      }),
    })

    await expect(current.processor.handleResponse(current.input))
      .rejects.toThrow(/YCloud/)
    expect(current.dependencies.completeFlowSubmission).not.toHaveBeenCalled()
  })
})
