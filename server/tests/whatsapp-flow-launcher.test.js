import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createWhatsAppFlowLauncher,
} = require('../dist/services/whatsapp-flow-launcher')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const VERSION_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_ID = '10000000-0000-4000-8000-000000000003'

function setup(overrides = {}) {
  const dependencies = {
    getFlowCatalogProducts: vi.fn(async () => [{ id: 'product-a' }]),
    getFlowCatalogModifiers: vi.fn(async () => []),
    getActiveFlowVersion: vi.fn(async () => ({
      id: VERSION_ID,
      business_id: BUSINESS_ID,
      provider: 'ycloud',
      status: 'published',
      is_active: true,
      provider_flow_id: 'provider-flow-123',
    })),
    createFlowSession: vi.fn(async () => ({
      flowToken: 'opaque-token',
      session: { id: SESSION_ID },
    })),
    recordFlowMetric: vi.fn(async () => true),
    sendSessionFlow: vi.fn(async () => undefined),
    now: () => Date.parse('2026-07-28T12:00:00.000Z'),
    ...overrides,
  }
  return {
    dependencies,
    launcher: createWhatsAppFlowLauncher(dependencies),
    input: {
      business: {
        id: BUSINESS_ID,
        name: 'Monster Pizza',
        whatsapp_provider: 'ycloud',
        takes_orders: true,
        active: true,
        bot_active: true,
        suspended: false,
      },
      phone: '593990001234',
    },
  }
}

describe('launcher de WhatsApp Flow', () => {
  it('crea token efímero y envía el Flow publicado dentro de la sesión', async () => {
    const current = setup()

    await expect(current.launcher.launchOrderFlow(current.input)).resolves.toBe(true)

    expect(current.dependencies.getActiveFlowVersion).toHaveBeenCalledWith(
      BUSINESS_ID,
      'order',
      'ycloud',
    )
    expect(current.dependencies.getFlowCatalogProducts)
      .toHaveBeenCalledWith(BUSINESS_ID)
    expect(current.dependencies.getFlowCatalogModifiers)
      .toHaveBeenCalledWith(BUSINESS_ID)
    expect(current.dependencies.createFlowSession).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      provider: 'ycloud',
      flowVersionId: VERSION_ID,
      contact: '593990001234',
      expiresAt: new Date('2026-07-28T12:30:00.000Z'),
      context: {
        capability: 'order',
        source: 'menu',
        schema_version: 1,
      },
    })
    expect(current.dependencies.sendSessionFlow).toHaveBeenCalledWith(
      current.input.business,
      '593990001234',
      {
        flowId: 'provider-flow-123',
        flowToken: 'opaque-token',
        action: 'data_exchange',
        body: 'Arma tu pedido de Monster Pizza en un solo formulario.',
        cta: 'Armar pedido',
      },
      'direct',
    )
  })

  it('usa el menú existente cuando no hay versión publicada y activa', async () => {
    const current = setup({
      getActiveFlowVersion: vi.fn(async () => null),
    })

    await expect(current.launcher.launchOrderFlow(current.input)).resolves.toBe(false)
    expect(current.dependencies.getFlowCatalogProducts).not.toHaveBeenCalled()
    expect(current.dependencies.getFlowCatalogModifiers).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
    expect(current.dependencies.sendSessionFlow).not.toHaveBeenCalled()
  })

  it.each([
    [
      'no hay productos disponibles',
      {
        getFlowCatalogProducts: vi.fn(async () => []),
      },
    ],
    [
      'hay más de 200 productos',
      {
        getFlowCatalogProducts: vi.fn(async () => Array.from(
          { length: 201 },
          (_, index) => ({ id: `product-${index}` }),
        )),
      },
    ],
    [
      'hay más de 200 modificadores',
      {
        getFlowCatalogModifiers: vi.fn(async () => Array.from(
          { length: 201 },
          (_, index) => ({ id: `modifier-${index}` }),
        )),
      },
    ],
  ])('cae al chat normal antes de crear la sesión cuando %s', async (
    _reason,
    overrides,
  ) => {
    const current = setup(overrides)

    await expect(current.launcher.launchOrderFlow(current.input)).resolves.toBe(false)
    expect(current.dependencies.getFlowCatalogProducts)
      .toHaveBeenCalledWith(BUSINESS_ID)
    expect(current.dependencies.getFlowCatalogModifiers)
      .toHaveBeenCalledWith(BUSINESS_ID)
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
    expect(current.dependencies.sendSessionFlow).not.toHaveBeenCalled()
    expect(current.dependencies.recordFlowMetric).not.toHaveBeenCalled()
  })

  it('acepta exactamente 200 productos y 200 modificadores', async () => {
    const current = setup({
      getFlowCatalogProducts: vi.fn(async () => Array.from(
        { length: 200 },
        (_, index) => ({ id: `product-${index}` }),
      )),
      getFlowCatalogModifiers: vi.fn(async () => Array.from(
        { length: 200 },
        (_, index) => ({ id: `modifier-${index}` }),
      )),
    })

    await expect(current.launcher.launchOrderFlow(current.input)).resolves.toBe(true)
    expect(current.dependencies.createFlowSession).toHaveBeenCalledOnce()
    expect(current.dependencies.sendSessionFlow).toHaveBeenCalledOnce()
  })

  it('no cruza un Flow YCloud con un negocio Meta', async () => {
    const current = setup()
    current.input.business.whatsapp_provider = 'meta'

    await expect(current.launcher.launchOrderFlow(current.input)).resolves.toBe(false)
    expect(current.dependencies.sendSessionFlow).not.toHaveBeenCalled()
  })

  it('propaga el fallo de transporte para que la conversación use su fallback', async () => {
    const current = setup({
      sendSessionFlow: vi.fn(async () => {
        throw new Error('proveedor no disponible')
      }),
    })

    await expect(current.launcher.launchOrderFlow(current.input))
      .rejects.toThrow(/proveedor no disponible/)
    expect(current.dependencies.recordFlowMetric).not.toHaveBeenCalled()
  })
})
