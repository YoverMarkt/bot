// ── TESTS DEL NÚCLEO DE DINERO ───────────────────────────────────────
// Los primeros tests automatizados del proyecto, y van directo a lo más
// crítico: la plata. Son funciones PURAS (sin BD ni red) → corren en CI
// sin credenciales. Regla probada: la IA conversa, el CÓDIGO calcula.
import { describe, it, expect } from 'vitest'
import m from '../dist/services/money.js'

// Catálogo de prueba (misma forma que devuelve la base)
const CATALOG = [
  { id: 'p1', name: 'Pizza Familiar Pepperoni', price: '18.50', price_sale: null },
  { id: 'p2', name: 'Coca Cola 1.5L', price: '2.75', price_sale: null },
  { id: 'p3', name: 'Pizza Familiar Hawaiana', price: '19.00', price_sale: null },
  { id: 'p4', name: 'Carcasa 10x2.5 Azul', price: '12.30', price_sale: null },
  { id: 'p5', name: 'Perfume Oferta 100ml', price: '100.00', price_sale: '80.00' },
  { id: 'p6', name: 'Producto Sin Precio', price: '0', price_sale: null },
  { id: 'p7', name: 'Producto Agotado', price: '8.00', price_sale: null, stock: 'agotado' },
]

describe('parseItems (parseo de la etiqueta ##PEDIDO##)', () => {
  it('parsea "A x2; B x1" con cantidades', () => {
    const r = m.parseItems('Pizza Familiar Pepperoni x2; Coca Cola 1.5L x1')
    expect(r).toEqual([
      { name: 'Pizza Familiar Pepperoni', qty: 2 },
      { name: 'Coca Cola 1.5L', qty: 1 },
    ])
  })

  it('parsea "2x A" (cantidad adelante) y sin cantidad (=1)', () => {
    const r = m.parseItems('2x Pizza Familiar, Empanada')
    expect(r).toEqual([
      { name: 'Pizza Familiar', qty: 2 },
      { name: 'Empanada', qty: 1 },
    ])
  })

  it('NO confunde medidas tipo "10x2.5" con cantidades', () => {
    const r = m.parseItems('Carcasa 10x2.5 Azul')
    expect(r).toEqual([{ name: 'Carcasa 10x2.5 Azul', qty: 1 }])
  })

  it('acota cantidades al rango 1..99 y descarta basura', () => {
    expect(m.parseItems('Pizza x0')[0].qty).toBe(1)      // el regex de sufijo exige 1-2 dígitos; 0 → mínimo 1
    expect(m.parseItems('')).toEqual([])
    expect(m.parseItems(';;;')).toEqual([])
  })
})

describe('resolveItems (resolución ESTRICTA — con dinero no se adivina)', () => {
  it('resuelve nombre exacto (insensible a mayúsculas/tildes)', () => {
    const { resolved, unresolved } = m.resolveItems([{ name: 'pizza familiar pepperoni', qty: 2 }], CATALOG)
    expect(unresolved).toEqual([])
    expect(resolved[0].product.id).toBe('p1')
    expect(resolved[0].unit).toBe(18.50)
  })

  it('resuelve coincidencia parcial SOLO si hay un único candidato', () => {
    const { resolved } = m.resolveItems([{ name: 'Coca Cola', qty: 1 }], CATALOG)
    expect(resolved[0].product.id).toBe('p2')
  })

  it('NO resuelve nombres ambiguos (varias pizzas familiares)', () => {
    const { resolved, unresolved } = m.resolveItems([{ name: 'Pizza Familiar', qty: 1 }], CATALOG)
    expect(resolved).toEqual([])
    expect(unresolved).toEqual(['Pizza Familiar'])
  })

  it('NO resuelve productos inexistentes', () => {
    const { unresolved } = m.resolveItems([{ name: 'Hamburguesa Doble', qty: 1 }], CATALOG)
    expect(unresolved).toEqual(['Hamburguesa Doble'])
  })

  it('usa price_sale (oferta) cuando existe', () => {
    const { resolved } = m.resolveItems([{ name: 'Perfume Oferta 100ml', qty: 1 }], CATALOG)
    expect(resolved[0].unit).toBe(80.00)
  })

  it('NO cobra productos con precio $0 (van a unresolved)', () => {
    const { resolved, unresolved } = m.resolveItems([{ name: 'Producto Sin Precio', qty: 1 }], CATALOG)
    expect(resolved).toEqual([])
    expect(unresolved[0]).toContain('Producto Sin Precio')
  })

  it('NO cobra productos agotados aunque tengan precio', () => {
    const { resolved, unresolved } = m.resolveItems(
      [{ name: 'Producto Agotado', qty: 1 }], CATALOG,
    )
    expect(resolved).toEqual([])
    expect(unresolved).toEqual(['Producto Agotado (agotado)'])
  })
})

describe('computeOrder (totales EN CÓDIGO)', () => {
  it('calcula subtotal/total exactos con multiplicación y suma', () => {
    const { resolved } = m.resolveItems([
      { name: 'Pizza Familiar Pepperoni', qty: 2 },
      { name: 'Coca Cola 1.5L', qty: 3 },
    ], CATALOG)
    const o = m.computeOrder(resolved)
    expect(o.items[0].line_total).toBe(37.00)
    expect(o.items[1].line_total).toBe(8.25)
    expect(o.subtotal).toBe(45.25)
    expect(o.total).toBe(45.25)
    expect(o.discount).toBe(0)
  })

  it('sin errores de punto flotante (el clásico 0.1+0.2)', () => {
    const fake = [
      { product: { id: 'a', name: 'A', price: '0.10' }, qty: 3, unit: 0.10 },
      { product: { id: 'b', name: 'B', price: '0.20' }, qty: 1, unit: 0.20 },
    ]
    expect(m.computeOrder(fake).total).toBe(0.50)   // no 0.5000000000000001
  })

  it('congela el precio unitario en el ítem (auditoría)', () => {
    const { resolved } = m.resolveItems([{ name: 'Perfume Oferta 100ml', qty: 2 }], CATALOG)
    const o = m.computeOrder(resolved)
    expect(o.items[0].unit_price).toBe(80.00)
    expect(o.items[0].line_total).toBe(160.00)
    expect(o.items[0].product_id).toBe('p5')
  })
})

describe('buildSummary (resumen oficial — lo envía el SERVIDOR, no la IA)', () => {
  const order = {
    items: [
      { product_name: 'Pizza Familiar Pepperoni', quantity: 2, unit_price: 18.50, line_total: 37.00 },
      { product_name: 'Coca Cola 1.5L', quantity: 1, unit_price: 2.75, line_total: 2.75 },
    ],
    subtotal: 39.75, discount: 0, total: 39.75,
  }

  it('incluye el total exacto con 2 decimales y cada línea', () => {
    const s = m.buildSummary(order)
    expect(s).toContain('*Total: $39.75*')
    expect(s).toContain('2 x Pizza Familiar Pepperoni — $18.50 c/u = $37.00')
    expect(s).toContain('1 x Coca Cola 1.5L — $2.75')
    expect(s).toContain('coordinará con usted el pago')
  })

})

describe('money (redondeo seguro a centavos)', () => {
  it('redondea a 2 decimales sin sorpresas', () => {
    expect(m.money(1.005)).toBe(1.01)
    expect(m.money(160.41)).toBe(160.41)
    expect(m.money(0.1 + 0.2)).toBe(0.30)
  })
})
