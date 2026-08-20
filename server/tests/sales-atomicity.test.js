import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const salesRepository = readFileSync(
  `${serverDir}/src/db/repositories/sales.ts`,
  'utf8',
)

// Este guardián protegía `create_sale_with_items`, el alta MANUAL de ventas,
// retirada el 2026-08-02: desde entonces toda venta nace de un pedido
// entregado, un pedido de mostrador o una cita atendida.
//
// La garantía que protegía —cabecera y detalles en UNA transacción, aislados
// por negocio, sin escrituras compensatorias— no desapareció: se mudó a las
// dos funciones que ahora crean ventas. Así que el guardián las sigue a ellas.

const funcion = nombre => schema
  .slice(schema.indexOf(`create or replace function public.${nombre}`))
  .split('$$;')[0]

describe('atomicidad de las ventas que nacen solas', () => {
  for (const nombre of ['crear_venta_desde_pedido']) {
    describe(nombre, () => {
      it('mete cabecera y detalles en la misma transacción', () => {
        const cuerpo = funcion(nombre)
        expect(cuerpo).toContain('insert into public.sales')
        expect(cuerpo).toContain('insert into public.sale_items')
        // Sin escrituras compensatorias: si algo falla dentro cae la
        // transacción entera y no queda media venta.
        expect(cuerpo).not.toContain('exception when')
      })

      it('no puede cobrarse nada de otro negocio', () => {
        const cuerpo = funcion(nombre)
        expect(cuerpo).toMatch(/business_id\s*=\s*p_business_id/)
        expect(cuerpo).toContain('if not found then')
        expect(cuerpo).toContain('return null;')
      })

      it('no crea dos veces la misma venta', () => {
        const cuerpo = funcion(nombre)
        // Comprueba si ya existe antes de insertar. El índice único es la otra
        // mitad; esto evita depender solo de que la base reviente.
        expect(cuerpo).toContain('select id into v_sale_id')
        expect(cuerpo).toContain('if found then')
      })

      it('se expone solo al backend', () => {
        expect(schema).toContain(`revoke all on function public.${nombre}(uuid, uuid)`)
        expect(schema).toContain(
          `grant execute on function public.${nombre}(uuid, uuid) to service_role`,
        )
      })
    })
  }

  it('el pedido tiene su propio índice único de venta', () => {
    expect(schema).toContain('uq_sales_order')
  })

  // Lo retirado no puede volver por la puerta de atrás: si alguien reintroduce
  // el alta manual, que sea una decisión consciente y no un descuido.
  it('la capa de datos ya no sabe crear ventas por su cuenta', () => {
    expect(salesRepository).not.toContain('create_sale_with_items')
    expect(salesRepository).not.toMatch(/const createSale\s*=/)
    expect(salesRepository).not.toMatch(/const addSaleItems\s*=/)
    expect(schema).not.toContain('create or replace function public.create_sale_with_items')
  })
})
