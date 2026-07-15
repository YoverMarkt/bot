import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/schema.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const repository = readFileSync(
  `${serverDir}/src/db/repositories/orders.ts`,
  'utf8',
)

describe('atomicidad de pedidos del bot', () => {
  it('crea cabecera e ítems dentro de una sola función PostgreSQL', () => {
    expect(migration).toContain(
      'create or replace function public.create_order_with_items',
    )
    expect(migration).toContain('insert into orders')
    expect(migration).toContain('insert into order_items')
    expect(migration).not.toContain('exception when')
  })

  it('recalcula dinero y valida que cada producto pertenezca al negocio', () => {
    expect(migration).toContain('v_line_total := round(v_quantity * v_unit_price, 2)')
    expect(migration).toContain('v_total := round(v_subtotal - v_discount, 2)')
    expect(migration).toMatch(/p\.business_id\s*=\s*p_business_id/)
    expect(migration).toContain('and p.active = true')
    expect(migration).toContain('v_requested_price is distinct from v_unit_price')
    expect(migration).toContain("v_product_stock = 'agotado'")
    expect(migration).toContain('for share;')
  })

  it('expone la función únicamente al backend service_role', () => {
    expect(migration).toContain('from anon;')
    expect(migration).toContain('from authenticated;')
    expect(migration).toContain('to service_role;')
  })

  it('sincroniza esquema y repositorio sin escrituras compensatorias', () => {
    expect(schema).toContain(
      'create or replace function public.create_order_with_items',
    )
    expect(repository).toContain("'create_order_with_items'")
    expect(repository).not.toContain("from('order_items').insert")
    expect(repository).not.toContain("from('orders').delete")
  })
})
