import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const reports = require('../dist/services/reports')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('servicio de reportes del dueño', () => {
  it('no intercepta mensajes de un número distinto al dueño', async () => {
    const sales = vi.spyOn(db, 'getSalesWithItems')

    const result = await reports.handleOwnerMessage(
      { id: 'business-a', owner_phone: '+593 99 111 2233' },
      '+593 98 000 0000',
      'ventas de hoy',
    )

    expect(result).toEqual({ handled: false })
    expect(sales).not.toHaveBeenCalled()
  })

  it('rechaza colisiones de sufijo entre países y valores de dueño demasiado cortos', async () => {
    const sales = vi.spyOn(db, 'getSalesWithItems')

    const countryCollision = await reports.handleOwnerMessage(
      { id: 'business-a', owner_phone: '+593 99 111 2233' },
      '+1 991 112 233',
      'ventas de hoy',
    )
    const shortOwner = await reports.handleOwnerMessage(
      { id: 'business-a', owner_phone: '2233' },
      '+593 99 111 2233',
      'ventas de hoy',
    )

    expect(countryCollision).toEqual({ handled: false })
    expect(shortOwner).toEqual({ handled: false })
    expect(sales).not.toHaveBeenCalled()
  })

  it('mantiene identificadores Telegram exactos sin mezclarlos con teléfonos', () => {
    expect(reports.samePhone('tg_123456789', 'TG_123456789')).toBe(true)
    expect(reports.samePhone('tg_123456789', 'tg_9123456789')).toBe(false)
    expect(reports.samePhone('tg_123456789', '123456789')).toBe(false)
  })

  it('pide un período antes de consultar datos', async () => {
    const sales = vi.spyOn(db, 'getSalesWithItems')

    const result = await reports.handleOwnerMessage(
      { id: 'business-a', owner_phone: '+593 99 111 2233' },
      '593991112233',
      'muéstrame las ventas',
    )

    expect(result.handled).toBe(true)
    expect(result.reply).toContain('¿De qué período')
    expect(sales).not.toHaveBeenCalled()
  })

  it('genera el resumen usando exclusivamente el negocio resuelto', async () => {
    const getSales = vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([
      {
        total: 12.5,
        contact_phone: '0991112233',
        sold_at: new Date().toISOString(),
        sale_items: [{ quantity: 2 }],
      },
    ])
    const getCustomers = vi.spyOn(db, 'getSaleCustomers').mockResolvedValue([
      { contact_phone: '0991112233', sold_at: new Date().toISOString() },
    ])
    const getWriters = vi.spyOn(db, 'getWritersInRange').mockResolvedValue(2)

    const result = await reports.handleOwnerMessage(
      { id: 'business-a', owner_phone: '+593 99 111 2233' },
      '593991112233',
      'ventas de hoy',
    )

    expect(result.handled).toBe(true)
    expect(result.reply).toContain('Total vendido: $12.50')
    expect(getSales).toHaveBeenCalledWith('business-a', expect.any(String))
    expect(getCustomers).toHaveBeenCalledWith('business-a')
    expect(getWriters).toHaveBeenCalledWith('business-a', expect.any(String))
    expect(getSales).not.toHaveBeenCalledWith('business-b', expect.anything())
  })

  it('unifica al mismo cliente aunque el teléfono cambie de formato', async () => {
    vi.spyOn(db, 'getCustomerSales').mockResolvedValue([
      { contact_phone: '0991112233', contact_name: 'Ana', total: 10, sold_at: '2026-07-01T12:00:00.000Z' },
      { contact_phone: '+593 99 111 2233', contact_name: 'Ana', total: 15, sold_at: '2026-07-02T12:00:00.000Z' },
    ])
    vi.spyOn(db, 'getSessions').mockResolvedValue([
      { contact_phone: '+593991112233', contact_name: 'Ana Actualizada' },
    ])

    const directory = await reports.getCustomerDirectory('business-a')

    expect(directory).toHaveLength(1)
    expect(directory[0]).toMatchObject({
      name: 'Ana Actualizada', orders: 2, total: 25,
    })
  })

  it('getAllReports descarga las ventas UNA sola vez y las comparte (egress)', async () => {
    const getSales = vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([])
    vi.spyOn(db, 'getSaleCustomers').mockResolvedValue([])
    vi.spyOn(db, 'getWritersInRange').mockResolvedValue(0)
    vi.spyOn(db, 'getClientUsers').mockResolvedValue([])
    vi.spyOn(db, 'getProducts').mockResolvedValue([])
    vi.spyOn(db, 'getSessions').mockResolvedValue([])
    vi.spyOn(db, 'getConsultationsInRange').mockResolvedValue([])
    vi.spyOn(db, 'getHistoryInRange').mockResolvedValue([])
    vi.spyOn(db, 'getLowStockProducts').mockResolvedValue([])
    vi.spyOn(db, 'getPendingOrders').mockResolvedValue([])
    vi.spyOn(db, 'getAiGaps').mockResolvedValue([])
    vi.spyOn(db, 'getUserMessagesInRange').mockResolvedValue([])

    const result = await reports.getAllReports('business-a', 'mes')

    // Ventana actual compartida (1) + ventana anterior de la comparación (1)
    // + ventana propia del trend (1). Antes eran 9-10 descargas por carga.
    expect(getSales.mock.calls.length).toBeLessThanOrEqual(3)
    const currentWindowCalls = getSales.mock.calls.filter(call => call[2] === undefined)
    expect(result.period).toBe('mes')
    expect(result.summary).toBeDefined()
    expect(result.comparison).toBeDefined()
    expect(currentWindowCalls.length).toBeLessThanOrEqual(2)
  })

  // Los reportes que el dueño de un delivery pide por WhatsApp. Cada comando
  // recorre su propio cálculo y su propio formateo, y ninguno estaba probado
  // de punta a punta: se cubrían el resumen y el directorio, que comparten
  // camino, y el resto vivía de que nadie los tocara.
  describe('los comandos que el dueño escribe por WhatsApp', () => {
    const dueño = { id: 'business-a', owner_phone: '+593 99 111 2233' }
    const pedir = texto => reports.handleOwnerMessage(dueño, '+593 99 111 2233', texto)

    it('responde "productos más vendidos" con el ranking del período', async () => {
      vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([
        {
          contact_phone: '+593991112233', total: 30, sold_at: '2026-08-10T12:00:00.000Z',
          sale_items: [
            { product_id: 'p1', product_name: 'Pizza Familiar', quantity: 3, subtotal: 30 },
            { product_id: 'p2', product_name: 'Cola 1L', quantity: 1, subtotal: 2 },
          ],
        },
      ])

      const resultado = await pedir('productos más vendidos del mes')

      expect(resultado.handled).toBe(true)
      expect(resultado.reply).toContain('Pizza Familiar')
      // El ranking ordena por cantidad: la pizza va antes que la bebida.
      expect(resultado.reply.indexOf('Pizza Familiar'))
        .toBeLessThan(resultado.reply.indexOf('Cola 1L'))
    })

    it('responde "stock bajo" con lo que está por acabarse', async () => {
      const lowStock = vi.spyOn(db, 'getLowStockProducts').mockResolvedValue([
        { name: 'Queso mozzarella', stock: 'agotado' },
      ])

      const resultado = await pedir('stock bajo')

      expect(resultado.handled).toBe(true)
      expect(resultado.reply).toContain('Queso mozzarella')
      expect(lowStock).toHaveBeenCalledWith('business-a')
    })

    it('responde "pedidos pendientes" con quién quedó sin cerrar', async () => {
      vi.spyOn(db, 'getPendingOrders').mockResolvedValue([
        { contact_name: 'Ana', contact_phone: '+593991112233', last_message: '¿me lo dejas en $15?' },
      ])

      const resultado = await pedir('pedidos pendientes')

      expect(resultado.handled).toBe(true)
      expect(resultado.reply).toContain('Ana')
    })

    it('responde "clientes frecuentes" ordenando por número de compras', async () => {
      vi.spyOn(db, 'getSalesWithItems').mockResolvedValue([
        { contact_phone: '+593991112233', contact_name: 'Ana', total: 10, sold_at: '2026-08-10T12:00:00.000Z', sale_items: [] },
        { contact_phone: '+593991112233', contact_name: 'Ana', total: 12, sold_at: '2026-08-11T12:00:00.000Z', sale_items: [] },
        { contact_phone: '+593988000000', contact_name: 'Luis', total: 40, sold_at: '2026-08-11T12:00:00.000Z', sale_items: [] },
      ])
      vi.spyOn(db, 'getSessions').mockResolvedValue([])

      const resultado = await pedir('clientes frecuentes del mes')

      expect(resultado.handled).toBe(true)
      // Ana compró dos veces y Luis una: manda la RECURRENCIA, no el monto.
      expect(resultado.reply.indexOf('Ana')).toBeLessThan(resultado.reply.indexOf('Luis'))
    })

    it('compara el período con el anterior y dice cuánto creció', async () => {
      vi.spyOn(db, 'getSalesWithItems').mockImplementation((_biz, _desde, hasta) => (
        // La ventana anterior es la única que llega con fecha de fin.
        Promise.resolve(hasta
          ? [{ contact_phone: '+593991112233', total: 100, sold_at: '2026-07-10T12:00:00.000Z', sale_items: [] }]
          : [{ contact_phone: '+593991112233', total: 150, sold_at: '2026-08-10T12:00:00.000Z', sale_items: [] }])
      ))

      const resultado = await pedir('comparar con el mes anterior')

      expect(resultado.handled).toBe(true)
      expect(resultado.reply).toContain('50')
    })

    it('pide el período cuando el reporte lo necesita y no viene', async () => {
      const sales = vi.spyOn(db, 'getSalesWithItems')

      const resultado = await pedir('productos más vendidos')

      expect(resultado.handled).toBe(true)
      expect(resultado.reply).toContain('período')
      // No se consulta nada hasta saber de qué período habla.
      expect(sales).not.toHaveBeenCalled()
    })
  })

  it('mantiene una implementación TypeScript verificable', () => {
    const service = fs.readFileSync(new URL('../src/services/reports.ts', import.meta.url), 'utf8')

    expect(service).toContain('interface ReportsDatabase')
    expect(service).toContain('export { handleOwnerMessage')
    expect(service).not.toContain('@ts-nocheck')
  })
})
