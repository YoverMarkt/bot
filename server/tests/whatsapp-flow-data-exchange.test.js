import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createWhatsAppFlowDataExchangeService,
} = require('../dist/services/whatsapp-flow-data-exchange')
const dataExchangeRouter = require('../dist/routes/whatsapp-flow-data-exchange.routes')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const FLOW_VERSION_ID = '10000000-0000-4000-8000-000000000002'
const PRODUCT_ID = '20000000-0000-4000-8000-000000000001'
const SOLD_OUT_ID = '20000000-0000-4000-8000-000000000002'
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000003'
const MODIFIER_ID = '30000000-0000-4000-8000-000000000001'
const TOKEN = 'valid-flow-token_1234567890'

function fixture(overrides = {}) {
  let session = {
    id: '40000000-0000-4000-8000-000000000001',
    business_id: BUSINESS_ID,
    provider: 'ycloud',
    flow_version_id: FLOW_VERSION_ID,
    status: 'open',
    context: {},
    context_revision: 0,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    flow: {
      id: '50000000-0000-4000-8000-000000000001',
      flow_key: 'order_standard',
      capability_key: 'order',
      version: 1,
      provider_flow_id: 'provider-flow-1',
    },
    ...overrides.session,
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
      if (businessId !== BUSINESS_ID || provider !== 'ycloud'
        || flowToken !== TOKEN || expectedRevision !== session.context_revision) {
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
      name: 'Monster Pizza',
      active: true,
      bot_active: true,
      suspended: false,
      takes_orders: true,
      payment_methods: 'Efectivo, Transferencia',
    })),
    getFlowCatalogProducts: vi.fn(async () => [
      {
        id: PRODUCT_ID,
        business_id: BUSINESS_ID,
        name: 'Pizza familiar',
        price: '12.50',
        price_sale: null,
        stock: 'disponible',
        tags: ['Pizzas'],
        active: true,
      },
      {
        id: SOLD_OUT_ID,
        business_id: BUSINESS_ID,
        name: 'Pizza agotada',
        price: 1,
        stock: 'agotado',
        tags: ['Pizzas'],
        active: true,
      },
      {
        id: OTHER_TENANT_ID,
        business_id: 'otro-negocio',
        name: 'Nunca debe llegar desde el repositorio tenant-safe',
        price: 999,
        stock: 'disponible',
        tags: ['Otro'],
        active: false,
      },
    ]),
    getFlowCatalogModifiers: vi.fn(async () => [{
      id: MODIFIER_ID,
      business_id: BUSINESS_ID,
      category_tag: 'Pizzas',
      group_label: 'Sabor',
      name: 'Pepperoni',
      active: true,
    }]),
    recordFlowMetric: vi.fn(async () => true),
    ...overrides.dependencies,
  }
  return {
    dependencies,
    exchange: createWhatsAppFlowDataExchangeService(dependencies),
    session: () => session,
  }
}

function productsOfSize(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    business_id: BUSINESS_ID,
    name: `Producto ${index + 1}`,
    price: 1,
    price_sale: null,
    stock: 'disponible',
    tags: ['Pizzas'],
    active: true,
  }))
}

function modifiersOfSize(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    business_id: BUSINESS_ID,
    category_tag: 'Pizzas',
    group_label: 'Opciones',
    name: `Opción ${index + 1}`,
    active: true,
  }))
}

describe('YCloud WhatsApp Flow data_exchange para pedidos', () => {
  it('responde el health check sin resolver una sesión', async () => {
    const { exchange, dependencies } = fixture()

    await expect(exchange({ action: 'ping' })).resolves.toEqual({
      data: { status: 'active' },
    })
    expect(dependencies.getFlowSessionByToken).not.toHaveBeenCalled()
  })

  it('inicializa usando únicamente el tenant resuelto por el token opaco', async () => {
    const { exchange, dependencies } = fixture()
    const response = await exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
      data: {},
    })

    expect(response.screen).toBe('ORDER_METHOD')
    expect(response.data.business_name).toBe('Monster Pizza')
    expect(response.data.fulfillment_options).toHaveLength(3)
    expect(dependencies.getBusinessById).toHaveBeenCalledWith(BUSINESS_ID)
    expect(dependencies.getFlowCatalogProducts).toHaveBeenCalledWith(BUSINESS_ID)
    expect(dependencies.recordFlowMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        eventType: 'step.init',
        sessionId: '40000000-0000-4000-8000-000000000001',
      }),
    )
  })

  it('guarda con CAS, excluye agotados y nunca acepta precios del cliente', async () => {
    const { exchange, dependencies, session } = fixture()
    const started = await exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: { intent: 'start_order', fulfillment: 'delivery' },
    })
    expect(started.screen).toBe('ORDER_ITEM_1')
    expect(started.data.products).toEqual([{
      id: PRODUCT_ID,
      title: 'Pizza familiar · $12.50',
    }])

    const saved = await exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: {
        intent: 'save_item',
        item_position: 1,
        category_id: 'pizzas',
        product_id: PRODUCT_ID,
        modifier_id: MODIFIER_ID,
        quantity: '2',
        item_note: 'sin cebolla',
        next_step: 'finish_items',
        unit_price: '0.01',
        total: '0.01',
      },
    })

    expect(saved.screen).toBe('ORDER_DETAILS')
    expect(saved.data.cart_summary).toContain('$25.00')
    expect(saved.data.cart_summary).not.toContain('$0.01')
    expect(session().context.items).toEqual([{
      product_id: PRODUCT_ID,
      quantity: 2,
      modifier_ids: [MODIFIER_ID],
      note: 'sin cebolla',
    }])
    expect(dependencies.updateFlowSessionContext).toHaveBeenCalledTimes(2)
  })

  it('recalcula la revisión con el catálogo y devuelve el payload canónico', async () => {
    const { exchange, session } = fixture({
      session: {
        context: {
          fulfillment: 'delivery',
          items: [{
            product_id: PRODUCT_ID,
            quantity: 2,
            modifier_ids: [MODIFIER_ID],
            note: null,
          }],
        },
        context_revision: 4,
      },
    })
    const response = await exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: {
        intent: 'review_order',
        fulfillment: 'pickup',
        items_json: JSON.stringify([{
          product_id: PRODUCT_ID,
          quantity: 2,
          price: 0.01,
        }]),
        contact_name: 'Andrea',
        address: 'Av. Principal 123',
        payment_method: 'efectivo',
      },
    })

    expect(response).toEqual({
      screen: 'ORDER_REVIEW',
      data: {
        flow_token: TOKEN,
        fulfillment: 'delivery',
        items_json: JSON.stringify([{
          product_id: PRODUCT_ID,
          quantity: 2,
          modifier_ids: [MODIFIER_ID],
          note: null,
        }]),
        contact_name: 'Andrea',
        address: 'Av. Principal 123',
        address_reference: '',
        payment_method: 'efectivo',
        requested_for: '',
        notes: '',
        summary: '2 × Pizza familiar (Pepperoni) — $25.00',
        total: '$25.00',
      },
    })
    expect(session().context.order_draft.total_cents).toBe(2500)
  })

  it('reconstruye BACK desde el estado del servidor sin confiar en datos del teléfono', async () => {
    const { exchange, dependencies } = fixture({
      session: {
        context: {
          fulfillment: 'delivery',
          items: [{
            product_id: PRODUCT_ID,
            quantity: 2,
            modifier_ids: [MODIFIER_ID],
            note: 'sin cebolla',
          }],
        },
        context_revision: 3,
      },
    })

    const response = await exchange({
      version: '3.0',
      action: 'BACK',
      screen: 'ORDER_DETAILS',
      flow_token: TOKEN,
      data: {
        items: [{
          product_id: OTHER_TENANT_ID,
          quantity: 99,
          price: 0.01,
        }],
      },
    })

    expect(response.screen).toBe('ORDER_ITEM_1')
    expect(response.data.products).toEqual([{
      id: PRODUCT_ID,
      title: 'Pizza familiar · $12.50',
    }])
    expect(response.data.cart_summary).toBe(
      '2 × Pizza familiar (Pepperoni) — $25.00',
    )
    expect(dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
    expect(dependencies.recordFlowMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'step.back',
        sourceKey: expect.stringContaining('ORDER_DETAILS'),
      }),
    )
  })

  it('reconoce la notificación de error sin guardar su mensaje sensible', async () => {
    const { exchange, dependencies } = fixture()

    await expect(exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: {
        error: 'ENDPOINT ERROR',
        error_message: 'Dirección privada y detalle que no debe persistirse',
      },
    })).resolves.toEqual({
      data: { acknowledged: true },
    })

    await vi.waitFor(() => {
      expect(dependencies.recordFlowMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'flow.error',
          sourceKey: expect.stringContaining('ENDPOINT_ERROR'),
          metadata: {},
        }),
      )
    })
    expect(dependencies.getBusinessById).not.toHaveBeenCalled()
    expect(dependencies.getFlowCatalogProducts).not.toHaveBeenCalled()
    expect(dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
  })

  it('reconoce la notificación de error aunque la base no esté disponible', async () => {
    const { exchange } = fixture({
      dependencies: {
        getFlowSessionByToken: vi.fn(async () => {
          throw new Error('Supabase temporalmente no disponible')
        }),
      },
    })

    await expect(exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: { error: 'ENDPOINT_ERROR' },
    })).resolves.toEqual({
      data: { acknowledged: true },
    })
  })

  it('falla cerrado para token inválido, capability distinta o sesión expirada', async () => {
    const invalid = fixture()
    await expect(invalid.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: 'token con espacios',
    })).rejects.toMatchObject({ status: 400 })
    expect(invalid.dependencies.getFlowSessionByToken).not.toHaveBeenCalled()

    const wrongCapability = fixture({
      session: { flow: { capability_key: 'appointment' } },
    })
    await expect(wrongCapability.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 403 })

    const expired = fixture({
      session: { expires_at: new Date(Date.now() - 1000).toISOString() },
    })
    await expect(expired.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 410 })
    expect(expired.dependencies.getFlowCatalogProducts).not.toHaveBeenCalled()
  })

  it('rechaza el body mayor a 64 KiB antes de tocar la base', async () => {
    const layer = dataExchangeRouter.stack.find(item => (
      item.route?.path === '/webhook/ycloud/flows/data-exchange'
    ))
    const handler = layer.route.stack.at(-1).handle
    const result = { status: 200, body: null }
    const req = {
      body: { action: 'ping' },
      rawBody: Buffer.alloc((64 * 1024) + 1),
      headers: {},
    }
    const res = {
      status(code) { result.status = code; return this },
      json(value) { result.body = value; return this },
    }
    let nextError
    await handler(req, res, error => { nextError = error })

    expect(nextError).toBeUndefined()
    expect(result.status).toBe(413)
    expect(result.body.error).toMatch(/demasiado grande/)
  })

  it('devuelve errores recuperables dentro del Flow con HTTP lógico exitoso', async () => {
    const { exchange } = fixture({
      dependencies: {
        updateFlowSessionContext: vi.fn(async () => ({ result: 'stale' })),
      },
    })
    const response = await exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'ORDER_METHOD',
      flow_token: TOKEN,
      data: { intent: 'start_order', fulfillment: 'pickup' },
    })

    expect(response).toEqual({
      screen: 'ORDER_METHOD',
      data: expect.objectContaining({
        error_message: 'El formulario cambió. Intenta nuevamente.',
      }),
    })
    expect(JSON.stringify(response)).not.toContain(TOKEN)
  })

  it('admite el límite completo del catálogo sin recortarlo', async () => {
    const products = productsOfSize(200)
    const { exchange } = fixture({
      dependencies: {
        getFlowCatalogProducts: vi.fn(async () => products),
      },
    })

    const response = await exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: { intent: 'start_order', fulfillment: 'pickup' },
    })

    expect(response.screen).toBe('ORDER_ITEM_1')
    expect(response.data.products).toHaveLength(200)
    expect(response.data.products.at(-1)).toEqual({
      id: products.at(-1).id,
      title: 'Producto 200 · $1.00',
    })
  })

  it.each([
    [
      'productos',
      {
        getFlowCatalogProducts: vi.fn(async () => productsOfSize(201)),
      },
    ],
    [
      'opciones',
      {
        getFlowCatalogModifiers: vi.fn(async () => modifiersOfSize(201)),
      },
    ],
  ])('no trunca silenciosamente un exceso de %s', async (_label, dependencies) => {
    const current = fixture({ dependencies })
    const response = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      screen: 'ORDER_METHOD',
      flow_token: TOKEN,
      data: { intent: 'start_order', fulfillment: 'delivery' },
    })

    expect(response).toEqual({
      screen: 'ORDER_METHOD',
      data: expect.objectContaining({
        error_message: expect.stringMatching(/demasiado grande.*continúa.*chat/i),
      }),
    })
    expect(response.data).not.toHaveProperty('products')
    expect(response.data).not.toHaveProperty('modifiers')
    expect(current.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
  })
})
