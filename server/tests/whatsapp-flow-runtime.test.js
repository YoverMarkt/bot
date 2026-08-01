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
const PRODUCT_ID = '20000000-0000-4000-8000-000000000001'
const MODIFIER_ID = '30000000-0000-4000-8000-000000000001'
const ORDER_ID = '40000000-0000-4000-8000-000000000001'
const TOKEN = 'opaque-flow-token_123456789'

function fixture(overrides = {}) {
  const session = {
    id: SESSION_ID,
    business_id: BUSINESS_ID,
    provider: 'ycloud',
    flow_version_id: VERSION_ID,
    status: 'open',
    context_revision: 4,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    context: {
      fulfillment: 'delivery',
      items: [{
        product_id: PRODUCT_ID,
        quantity: 2,
        modifier_ids: [MODIFIER_ID],
        note: 'Sin cebolla',
      }],
      order_draft: {
        fulfillment: 'delivery',
        items: [{
          product_id: PRODUCT_ID,
          quantity: 2,
          modifier_ids: [MODIFIER_ID],
          note: 'Sin cebolla',
        }],
        contact_name: 'Andrea',
        address: 'Av. Principal 123',
        address_reference: 'Casa azul',
        payment_method: 'efectivo',
        requested_for: '19:30',
        notes: 'Tocar el timbre',
        total_cents: 2500,
      },
    },
    flow: {
      id: '50000000-0000-4000-8000-000000000001',
      flow_key: 'order_standard',
      capability_key: 'order',
      version: 1,
      provider_flow_id: 'provider-flow-1',
    },
  }
  const dependencies = {
    getBusinessById: vi.fn(async () => ({
      id: BUSINESS_ID,
      name: 'Monster Pizza',
      active: true,
      bot_active: true,
      suspended: false,
      takes_orders: true,
    })),
    getFlowSessionByToken: vi.fn(async () => session),
    recordFlowSubmission: vi.fn(async () => ({
      created: true,
      submission: {
        id: SUBMISSION_ID,
        processing_status: 'received',
      },
    })),
    completeFlowSubmission: vi.fn(async () => ({})),
    createOrderFromFlowSubmission: vi.fn(async () => ({
      created: true,
      order: {
        id: ORDER_ID,
        total: '25.00',
        currency: 'USD',
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
      inboundId: 'wamid-flow-1',
      channelAddress: {
        provider: 'ycloud',
        identifierType: 'phone',
        identifier: '593999999999',
      },
      response: {
        flow_token: TOKEN,
        // Valores manipulados: deben ignorarse completamente.
        fulfillment: 'pickup',
        contact_name: 'Atacante',
        items_json: JSON.stringify([{
          product_id: '90000000-0000-4000-8000-000000000001',
          quantity: 99,
          price: 0.01,
        }]),
        total: 0.01,
      },
    },
  }
}

describe('runtime de respuestas WhatsApp Flow', () => {
  it('crea una sola orden con el draft del servidor e ignora el terminal manipulado', async () => {
    const current = fixture()

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.recordFlowSubmission).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      provider: 'ycloud',
      flowToken: TOKEN,
      contact: '593990001234',
      submissionKey: 'wamid-flow-1',
      payload: current.input.response,
    })
    expect(current.dependencies.createOrderFromFlowSubmission).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      submissionId: SUBMISSION_ID,
      contactPhone: '593990001234',
      contactName: 'Andrea',
      items: [{
        productId: PRODUCT_ID,
        quantity: 2,
        modifierIds: [MODIFIER_ID],
        note: 'Sin cebolla',
      }],
      fulfillmentType: 'delivery',
      deliveryAddress: 'Av. Principal 123',
      deliveryReference: 'Casa azul',
      paymentMethod: 'efectivo',
      requestedFulfillmentAt: null,
      customerNotes: 'Hora solicitada por el cliente: 19:30\nTocar el timbre',
      deliveryFee: 0,
      currency: 'USD',
    })
    expect(current.dependencies.sendText).toHaveBeenCalledOnce()
    expect(current.dependencies.sendText.mock.calls[0][2]).toContain('Total oficial')
    expect(current.dependencies.sendText.mock.calls[0][2]).toContain('40000000')
    expect(current.dependencies.upsertSession).not.toHaveBeenCalled()
  })

  it('no repite la confirmación cuando la redelivery ya está en el historial', async () => {
    const current = fixture({
      recordFlowSubmission: vi.fn(async () => ({
        created: false,
        submission: {
          id: SUBMISSION_ID,
          processing_status: 'processed',
          order_id: ORDER_ID,
        },
      })),
      createOrderFromFlowSubmission: vi.fn(async () => ({
        created: false,
        order: { id: ORDER_ID, total: 25, currency: 'USD' },
      })),
      getContactHistory: vi.fn(async () => [{
        role: 'assistant',
        content: '✅ Pedido recibido\nCódigo: *40000000*',
      }]),
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.sendText).not.toHaveBeenCalled()
    expect(current.dependencies.createOrderFromFlowSubmission).toHaveBeenCalledOnce()
  })

  it('propaga un fallo de envío para que el inbox durable pueda reintentar', async () => {
    const current = fixture({
      sendText: vi.fn(async () => {
        throw new Error('YCloud temporalmente no disponible')
      }),
    })

    await expect(current.processor.handleResponse(current.input))
      .rejects.toThrow(/YCloud temporalmente/)
    expect(current.dependencies.saveMessage).not.toHaveBeenCalled()
  })

  it('reanuda una sesión submitted aunque haya vencido después de registrarse', async () => {
    const current = fixture({
      getFlowSessionByToken: vi.fn(async () => ({
        ...(await fixture().dependencies.getFlowSessionByToken()),
        status: 'submitted',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      })),
      recordFlowSubmission: vi.fn(async () => ({
        created: false,
        submission: {
          id: SUBMISSION_ID,
          processing_status: 'processed',
          order_id: ORDER_ID,
        },
      })),
      createOrderFromFlowSubmission: vi.fn(async () => ({
        created: false,
        order: { id: ORDER_ID, total: 25, currency: 'USD' },
      })),
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.createOrderFromFlowSubmission).toHaveBeenCalledOnce()
    expect(current.dependencies.sendText).toHaveBeenCalledOnce()
  })

  it('rechaza de forma final un catálogo que cambió sin crear otro pedido', async () => {
    const current = fixture({
      createOrderFromFlowSubmission: vi.fn(async () => {
        throw new Error('Uno de los productos está agotado')
      }),
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.completeFlowSubmission).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      submissionId: SUBMISSION_ID,
      status: 'rejected',
      errorCode: 'catalog_changed',
    })
    expect(current.dependencies.sendText.mock.calls[0][2]).toContain(
      'producto u opción cambió',
    )
  })

  it('no cierra el rechazo si el aviso no pudo enviarse y permite reintento', async () => {
    const current = fixture({
      createOrderFromFlowSubmission: vi.fn(async () => {
        throw new Error('Uno de los productos está agotado')
      }),
      sendText: vi.fn(async () => {
        throw new Error('YCloud temporalmente no disponible')
      }),
    })

    await expect(current.processor.handleResponse(current.input))
      .rejects.toThrow(/YCloud temporalmente/)
    expect(current.dependencies.completeFlowSubmission).not.toHaveBeenCalled()
    expect(current.dependencies.saveMessage).not.toHaveBeenCalled()
  })

  it('descarta tokens sin draft canónico sin invocar mutaciones', async () => {
    const current = fixture({
      getFlowSessionByToken: vi.fn(async () => ({
        ...(await fixture().dependencies.getFlowSessionByToken()),
        context: {},
      })),
    })

    await current.processor.handleResponse(current.input)

    expect(current.dependencies.recordFlowSubmission).not.toHaveBeenCalled()
    expect(current.dependencies.createOrderFromFlowSubmission).not.toHaveBeenCalled()
    expect(current.dependencies.sendText).not.toHaveBeenCalled()
  })
})
