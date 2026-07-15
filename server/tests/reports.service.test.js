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

  it('pide un período antes de consultar datos', async () => {
    const sales = vi.spyOn(db, 'getSalesWithItems')

    const result = await reports.handleOwnerMessage(
      { id: 'business-a', owner_phone: '+593 99 111 2233' },
      '0991112233',
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
      '0991112233',
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

  it('mantiene una implementación TypeScript verificable', () => {
    const service = fs.readFileSync(new URL('../src/services/reports.ts', import.meta.url), 'utf8')

    expect(service).toContain('interface ReportsDatabase')
    expect(service).toContain('export { handleOwnerMessage')
    expect(service).not.toContain('@ts-nocheck')
  })
})
