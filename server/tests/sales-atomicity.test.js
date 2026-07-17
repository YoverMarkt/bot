import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/schema.sql`,
  'utf8',
)
const salesRepository = readFileSync(
  `${serverDir}/src/db/repositories/sales.ts`,
  'utf8',
)

describe('atomicidad de ventas manuales', () => {
  it('mantiene cabecera y detalles dentro de una sola RPC aislada por negocio', () => {
    expect(migration).toContain('create or replace function public.create_sale_with_items')
    expect(migration).toContain('insert into sales')
    expect(migration).toContain('insert into sale_items')
    expect(migration).toMatch(/p\.business_id\s*=\s*p_business_id/)
    expect(migration).toMatch(/cu\.business_id\s*=\s*p_business_id/)
    expect(migration).toContain('for share;')
    expect(migration).toContain("v_product_stock = 'agotado'")
    expect(migration).not.toContain("v_item ->> 'product_name'")
    expect(migration).not.toContain('exception when')
  })

  it('expone la función solo al backend service_role', () => {
    expect(migration).toContain('from anon;')
    expect(migration).toContain('from authenticated;')
    expect(migration).toContain('to service_role;')
    const saleFunction = migration
      .split('create or replace function public.create_sale_with_items')[1]
      .split('revoke all on function public.create_sale_with_items')[0]
    expect(saleFunction).not.toContain('security definer')
  })

  it('evita reintroducir escrituras separadas desde la capa de datos', () => {
    expect(salesRepository).toContain("'create_sale_with_items'")
    expect(salesRepository).not.toMatch(/const createSale\s*=/)
    expect(salesRepository).not.toMatch(/const addSaleItems\s*=/)
    expect(salesRepository).not.toMatch(/const deleteSale\s*=/)
  })
})
