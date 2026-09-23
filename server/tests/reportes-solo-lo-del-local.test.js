import { describe, expect, it, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const reports = require('../dist/services/reports')

// ═══════════════════════════════════════════════════════════════════════════
// LOS REPORTES ENSEÑAN SOLO LO QUE RECIBE EL LOCAL
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido por el dueño el 2026-09-21: «sobre los reportes, claro, tiene que ir
// solo lo que el dueño recibe, no con mi margen de ganancia». Y antes, sobre
// la carrera: «eso es del motorizado».
//
// `sales.total` es lo que pagó el CLIENTE y lleva dentro dos dineros ajenos.
// Las cifras de abajo son las REALES de Monster Pizza en agosto, medidas
// contra producción:
//
//     «Total vendido» que veía .......... $112.32
//     de comida vendió de verdad ........  $94.12
//     carreras (de quien entrega) .......  $16.00
//     comisión de la plataforma .........   $2.20
//
// $18.20 de diferencia en un mes flojo, y ese es el número con el que el dueño
// paga a su cocinero.

const DUENO = { id: 'monster', owner_phone: '+593 99 097 8367' }

/** Una venta tal como la guarda la base: el total del cliente y las dos partes ajenas. */
const venta = (total, shipping, markup, extra = {}) => ({
  total, shipping, platform_markup: markup,
  sold_at: new Date().toISOString(),
  contact_phone: extra.phone ?? '+593 98 000 0001',
  contact_name: extra.name ?? 'Cliente',
  sale_items: extra.items ?? [],
  ...extra.resto,
})

afterEach(() => { vi.restoreAllMocks() })

describe('el resumen no cuenta la carrera ni la comisión', () => {
  it('el mes real de Monster Pizza: $94.12, no $112.32', async () => {
    // Nueve pedidos que suman exactamente lo medido en producción.
    const ventas = [
      venta(14.09, 2.00, 1.10), venta(12.99, 2.00, 1.10),
      venta(14.00, 2.00, 0), venta(7.75, 2.00, 0),
      venta(15.50, 2.00, 0), venta(12.99, 2.00, 0),
      venta(4.50, 2.00, 0), venta(18.00, 2.00, 0),
      venta(12.50, 0, 0),
    ]
    vi.spyOn(db, 'getSalesWithItems').mockResolvedValue(ventas)
    vi.spyOn(db, 'getSaleCustomers').mockResolvedValue([])
    vi.spyOn(db, 'getWritersInRange').mockResolvedValue([])

    const r = await reports.handleOwnerMessage(DUENO, DUENO.owner_phone, 'ventas de hoy')

    expect(r.handled).toBe(true)
    // Lo que pagaron los clientes: 112.32. Lo del local: 112.32 − 16 − 2.20.
    expect(r.reply).toContain('$94.12')
    expect(r.reply).not.toContain('$112.32')
  })

  it('se llama «Tus ventas», no «Total vendido»', async () => {
    vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([venta(14.09, 2.00, 1.10)])
    vi.spyOn(db, 'getSaleCustomers').mockResolvedValue([])
    vi.spyOn(db, 'getWritersInRange').mockResolvedValue([])

    const r = await reports.handleOwnerMessage(DUENO, DUENO.owner_phone, 'ventas de hoy')
    expect(r.reply).toContain('Tus ventas')
  })

  it('una venta sin carrera ni comisión se cuenta entera', async () => {
    vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([venta(20.00, 0, 0)])
    vi.spyOn(db, 'getSaleCustomers').mockResolvedValue([])
    vi.spyOn(db, 'getWritersInRange').mockResolvedValue([])

    const r = await reports.handleOwnerMessage(DUENO, DUENO.owner_phone, 'ventas de hoy')
    expect(r.reply).toContain('$20.00')
  })

  it('una venta vieja, sin las columnas, no rompe ni resta de más', async () => {
    // Las anteriores a la migración se rellenaron desde su pedido, pero si
    // alguna llegara sin ellas debe contarse entera en vez de dar NaN.
    vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([
      { total: 18.00, sold_at: new Date().toISOString(), sale_items: [] },
    ])
    vi.spyOn(db, 'getSaleCustomers').mockResolvedValue([])
    vi.spyOn(db, 'getWritersInRange').mockResolvedValue([])

    const r = await reports.handleOwnerMessage(DUENO, DUENO.owner_phone, 'ventas de hoy')
    expect(r.reply).toContain('$18.00')
    expect(r.reply).not.toContain('NaN')
  })
})

describe('el ticket promedio también sale de lo del local', () => {
  it('dos pedidos de $14.09 con $2 de envío y $1.10 de comisión promedian $10.99', async () => {
    vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([
      venta(14.09, 2.00, 1.10), venta(14.09, 2.00, 1.10),
    ])
    vi.spyOn(db, 'getSaleCustomers').mockResolvedValue([])
    vi.spyOn(db, 'getWritersInRange').mockResolvedValue([])

    const r = await reports.handleOwnerMessage(DUENO, DUENO.owner_phone, 'ventas de hoy')
    // 21.98 de productos entre 2 pedidos.
    expect(r.reply).toContain('$21.98')
    expect(r.reply).toContain('$10.99')
  })
})

describe('el directorio de clientes cuenta lo mismo', () => {
  it('lo que un cliente ha gastado es lo que le quedó al local', async () => {
    vi.spyOn(db, 'getCustomerSales').mockResolvedValue([
      { contact_phone: '+593 98 000 0001', contact_name: 'Ana', total: 14.09,
        shipping: 2.00, platform_markup: 1.10, sold_at: new Date().toISOString() },
    ])
    vi.spyOn(db, 'getSessions').mockResolvedValue([])

    const dir = await reports.getCustomerDirectory('monster')
    expect(dir[0].total).toBe(10.99)
  })
})
