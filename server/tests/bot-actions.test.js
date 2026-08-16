import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const money = require('../dist/services/money')
const { createBotActions } = require('../dist/services/bot-actions')

function setup(overrides = {}) {
  const database = {
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
  id: 'business-a', name: 'Negocio A', takes_orders: true,
}
const product = {
  id: 'product-a', name: 'Producto A', price: '12.50', duration_minutes: 45,
}

describe('acciones de etiquetas del bot', () => {
  it('activa handoff por etiqueta explícita aunque la respuesta no sea incierta', async () => {
    const { actions, database } = setup()
    const send = vi.fn().mockResolvedValue(undefined)

    const result = await actions.handleConversationOutcome({
      business,
      phone: '0990000001',
      originalText: 'Necesito una persona',
      hasSale: false,
      hasHandoffTag: true,
      isUncertain: false,
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

  it('mantiene las acciones aisladas en TypeScript', () => {
    const service = fs.readFileSync(new URL('../src/services/bot-actions.ts', import.meta.url), 'utf8')
    const conversation = fs.readFileSync(new URL('../src/services/bot-conversation.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('business_id: business.id')
    expect(service).toContain('database.recordAiGap(')
    expect(service).not.toContain('@ts-nocheck')
    expect(conversation).toContain("require('./bot-actions')")
    expect(entry).toContain("require('./bot-conversation')")
  })
})
