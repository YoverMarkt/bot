import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const templates = require('../dist/services/whatsapp-flow-templates')
const contracts = require('../dist/services/whatsapp-flow-contracts')
const flowJson = require('../dist/services/whatsapp-flow-json')

describe('arquitectura reutilizable de WhatsApp Flows', () => {
  it('elige plantillas por capacidades y admite combinaciones/futuros tipos', () => {
    expect(templates.recommendedFlowCapabilities({
      type: 'pizzería',
      takes_orders: true,
      takes_bookings: false,
      lodging_enabled: false,
    })).toEqual(['order'])
    expect(templates.recommendedFlowCapabilities({
      type: 'complejo nuevo no conocido',
      takes_orders: true,
      takes_bookings: true,
      lodging_enabled: true,
    })).toEqual(['lodging', 'order', 'appointment'])
    expect(templates.recommendedFlowCapabilities({
      type: 'negocio futuro',
      takes_orders: false,
      takes_bookings: false,
      lodging_enabled: false,
    })).toEqual(['lead'])
  })

  it('expone cuatro familias versionadas sin atarlas al nombre del negocio', () => {
    expect(templates.listFlowTemplates().map(item => item.capability)).toEqual([
      'order', 'appointment', 'lodging', 'lead',
    ])
    expect(templates.flowTemplateByKey('order_standard')).toMatchObject({
      version: 2,
      firstScreen: 'ORDER_METHOD',
      implementation: 'ready',
    })
  })

  it('genera el pedido dinámico sin incrustar precios ni un catálogo de tenant', () => {
    const json = flowJson.buildOrderFlowJson()
    expect(json.data_api_version).toBe('3.0')
    expect(json.screens.map(screen => screen.id)).toEqual([
      'ORDER_METHOD',
      'ORDER_ITEM_ONE',
      'ORDER_ITEM_TWO',
      'ORDER_ITEM_THREE',
      'ORDER_DETAILS',
      'ORDER_REVIEW',
    ])
    expect(JSON.stringify(json)).not.toContain('"unit_price"')
    expect(JSON.stringify(json)).not.toContain('"price"')
  })

  it('valida una respuesta de pedido y nunca acepta precios del cliente', () => {
    const result = contracts.parseOrderFlowSubmission({
      flow_token: 'flow-token-with-enough-entropy',
      fulfillment: 'delivery',
      contact_name: 'María',
      address: 'Av. Principal 123',
      payment_method: 'cash',
      items: [{
        product_id: '11111111-1111-4111-8111-111111111111',
        quantity: 2,
        unit_price: 0.01,
        modifier_ids: ['22222222-2222-4222-8222-222222222222'],
      }],
    })
    expect(result.items).toEqual([{
      productId: '11111111-1111-4111-8111-111111111111',
      quantity: 2,
      modifierIds: ['22222222-2222-4222-8222-222222222222'],
      note: null,
    }])
    expect(result).not.toHaveProperty('unitPrice')
    expect(result.items[0]).not.toHaveProperty('unitPrice')
  })

  it('exige dirección en delivery y rechaza carritos manipulados', () => {
    const base = {
      flow_token: 'flow-token-with-enough-entropy',
      fulfillment: 'delivery',
      contact_name: 'María',
      items: [{
        product_id: '11111111-1111-4111-8111-111111111111',
        quantity: 1,
      }],
    }
    expect(() => contracts.parseOrderFlowSubmission(base)).toThrow(/dirección/i)
    expect(() => contracts.parseOrderFlowSubmission({
      ...base,
      address: 'Calle 1',
      items: [{ ...base.items[0], quantity: 100 }],
    })).toThrow(/producto o cantidad/i)
  })
})
