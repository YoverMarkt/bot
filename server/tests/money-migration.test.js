import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const money = require('../dist/services/money')

describe('migración TypeScript del núcleo monetario', () => {
  it('mantiene el contrato público de cálculo y resumen', () => {
    for (const method of [
      'money', 'parseItems', 'resolveItems', 'computeOrder', 'buildSummary',
    ]) {
      expect(money[method]).toBeTypeOf('function')
    }

    const parsed = money.parseItems('Producto A x99')
    const resolved = money.resolveItems(parsed, [{
      id: 'product-a', name: 'Producto A', price: '10.005', price_sale: null,
    }])
    const order = money.computeOrder(resolved.resolved)

    expect(order).toEqual({
      items: [{
        product_id: 'product-a',
        product_name: 'Producto A',
        quantity: 99,
        unit_price: 10.01,
        line_total: 990.99,
      }],
      subtotal: 990.99,
      discount: 0,
      total: 990.99,
    })
    expect(money.buildSummary(order)).toContain('*Total: $990.99*')
  })

  it('usa precio normal cuando la oferta no es válida', () => {
    const { resolved, unresolved } = money.resolveItems(
      [{ name: 'Producto A', qty: 1 }],
      [{ id: 'a', name: 'Producto A', price: '7.25', price_sale: '0' }],
    )

    expect(unresolved).toEqual([])
    expect(resolved[0].unit).toBe(7.25)
  })

  it('mantiene servicios estrictamente tipados y conectados directamente', () => {
    const moneyService = fs.readFileSync(new URL('../src/services/money.ts', import.meta.url), 'utf8')
    const actions = fs.readFileSync(new URL('../src/services/bot-actions.ts', import.meta.url), 'utf8')

    expect(moneyService).not.toContain('@ts-nocheck')
    expect(actions).toContain("money: require('./money')")
    expect(actions).not.toContain("require('./payments')")
  })

  it('mantiene la integridad monetaria en las migraciones atómicas', () => {
    const ordersMigration = fs.readFileSync(
      new URL('../migration-atomicidad-pedidos.sql', import.meta.url),
      'utf8',
    )
    const salesMigration = fs.readFileSync(
      new URL('../migration-atomicidad-ventas.sql', import.meta.url),
      'utf8',
    )
    const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

    expect(ordersMigration).toContain("p.business_id = p_business_id")
    expect(schema).toContain('v_requested_price is distinct from v_unit_price')
    expect(salesMigration).toContain("p.business_id = p_business_id")
    expect(schema).not.toContain('payment_link')
  })
})
