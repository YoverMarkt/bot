import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createWhatsAppFlowLauncher,
} = require('../dist/services/whatsapp-flow-launcher')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const VERSION_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_ID = '10000000-0000-4000-8000-000000000003'
const ROOM_ID = '20000000-0000-4000-8000-000000000001'

function setup(capability, overrides = {}) {
  const dependencies = {
    getFlowCatalogProducts: vi.fn(async () => []),
    getFlowCatalogModifiers: vi.fn(async () => []),
    getFlowAppointmentServices: vi.fn(async () => []),
    getSchedule: vi.fn(async () => [{ is_active: true }]),
    getFlowAppointmentAvailability: vi.fn(async () => [{
      booking_date: '2026-08-01',
      booking_time: '09:00',
    }]),
    getLodgingRoomTypes: vi.fn(async () => [{
      id: ROOM_ID,
      name: 'Suite',
      active: true,
      pricing_model: 'per_unit',
      base_rate: 50,
      base_occupancy: 1,
      max_guests: 2,
    }]),
    getActiveFlowVersion: vi.fn(async (_businessId, key) => ({
      id: VERSION_ID,
      business_id: BUSINESS_ID,
      provider: 'ycloud',
      status: 'published',
      is_active: true,
      provider_flow_id: `flow-${key}`,
    })),
    createFlowSession: vi.fn(async () => ({
      flowToken: 'opaque-token',
      session: { id: SESSION_ID },
    })),
    recordFlowMetric: vi.fn(async () => true),
    sendSessionFlow: vi.fn(async () => undefined),
    now: () => Date.parse('2026-07-28T12:00:00.000Z'),
    ...overrides,
  }
  const business = {
    id: BUSINESS_ID,
    name: 'Negocio Demo',
    whatsapp_provider: 'ycloud',
    takes_orders: capability === 'order',
    takes_bookings: capability === 'appointment',
    lodging_enabled: capability === 'lodging',
    active: true,
    bot_active: true,
    suspended: false,
  }
  return {
    dependencies,
    launcher: createWhatsAppFlowLauncher(dependencies),
    input: {
      business,
      phone: '593990001234',
      source: 'menu',
    },
  }
}

describe('launcher de capacidades WhatsApp Flow', () => {
  it('no interpreta una capacidad de pedidos ausente como habilitada', async () => {
    const current = setup('order')
    current.input.business.takes_orders = undefined
    current.dependencies.getFlowCatalogProducts.mockResolvedValue([{
      id: '30000000-0000-4000-8000-000000000001',
    }])

    await expect(current.launcher.launchOrderFlow(current.input))
      .resolves.toBe(false)

    expect(current.dependencies.getActiveFlowVersion).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
  })

  it('lanza una cita solo con agenda activa', async () => {
    const current = setup('appointment')

    await expect(current.launcher.launchAppointmentFlow(current.input))
      .resolves.toBe(true)

    expect(current.dependencies.getActiveFlowVersion)
      .toHaveBeenCalledWith(BUSINESS_ID, 'appointment', 'ycloud')
    expect(current.dependencies.createFlowSession).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          capability: 'appointment',
          source: 'menu',
          schema_version: 1,
        },
      }),
    )
    expect(current.dependencies.sendSessionFlow.mock.calls[0][2].cta)
      .toBe('Solicitar cita')
  })

  it('no abre una cita cuando no existe horario activo', async () => {
    const current = setup('appointment', {
      getSchedule: vi.fn(async () => [{ is_active: false }]),
    })

    await expect(current.launcher.launchAppointmentFlow(current.input))
      .resolves.toBe(false)
    expect(current.dependencies.getActiveFlowVersion).not.toHaveBeenCalled()
  })

  it('cae al chat si la agenda está activa pero no queda disponibilidad real', async () => {
    const current = setup('appointment', {
      getFlowAppointmentAvailability: vi.fn(async () => []),
    })

    await expect(current.launcher.launchAppointmentFlow(current.input))
      .resolves.toBe(false)

    expect(current.dependencies.getFlowAppointmentAvailability)
      .toHaveBeenCalledWith({
        businessId: BUSINESS_ID,
        serviceId: null,
        durationMinutes: null,
        daysAhead: 30,
      })
    expect(current.dependencies.getActiveFlowVersion).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
  })

  it('cae al chat si la disponibilidad de citas no tiene fechas y horas válidas', async () => {
    const current = setup('appointment', {
      getFlowAppointmentAvailability: vi.fn(async () => [
        { booking_date: '2026-02-30', booking_time: '09:00' },
        { booking_date: '2026-08-01', booking_time: '25:00' },
      ]),
    })

    await expect(current.launcher.launchAppointmentFlow(current.input))
      .resolves.toBe(false)

    expect(current.dependencies.getActiveFlowVersion).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
  })

  it('cae al chat si los servicios exceden el límite representable', async () => {
    const current = setup('appointment', {
      getFlowAppointmentServices: vi.fn(async () => Array.from(
        { length: 201 },
        (_, index) => ({ id: `service-${index}` }),
      )),
    })

    await expect(current.launcher.launchAppointmentFlow(current.input))
      .resolves.toBe(false)

    expect(current.dependencies.getActiveFlowVersion).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
  })

  it('lanza hospedaje conservando la habitación que el huésped vio', async () => {
    const current = setup('lodging')

    await expect(current.launcher.launchLodgingFlow({
      ...current.input,
      preferredRoomTypeId: ROOM_ID,
    })).resolves.toBe(true)

    expect(current.dependencies.createFlowSession).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          capability: 'lodging',
          source: 'menu',
          schema_version: 1,
          preferred_room_type_id: ROOM_ID,
        },
      }),
    )
    expect(current.dependencies.sendSessionFlow.mock.calls[0][2].cta)
      .toBe('Cotizar estadía')
  })

  it('cae al chat si hospedaje solo tiene tarifas manuales', async () => {
    const current = setup('lodging', {
      getLodgingRoomTypes: vi.fn(async () => [{
        id: ROOM_ID,
        active: true,
        pricing_model: 'manual',
      }]),
    })

    await expect(current.launcher.launchLodgingFlow(current.input))
      .resolves.toBe(false)
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
  })

  it('cae al chat si una habitación automática está incompleta', async () => {
    const current = setup('lodging', {
      getLodgingRoomTypes: vi.fn(async () => [{
        id: ROOM_ID,
        name: 'Suite sin tarifa',
        active: true,
        pricing_model: 'per_unit',
        base_rate: null,
        base_occupancy: 1,
        max_guests: 2,
      }]),
    })

    await expect(current.launcher.launchLodgingFlow(current.input))
      .resolves.toBe(false)
    expect(current.dependencies.getActiveFlowVersion).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
  })

  it('no sustituye una habitación manual elegida por otra automática', async () => {
    const automaticRoomId = '20000000-0000-4000-8000-000000000002'
    const current = setup('lodging', {
      getLodgingRoomTypes: vi.fn(async () => [
        {
          id: ROOM_ID,
          active: true,
          pricing_model: 'manual',
        },
        {
          id: automaticRoomId,
          name: 'Habitación automática',
          active: true,
          pricing_model: 'per_unit',
          base_rate: 50,
          base_occupancy: 1,
          max_guests: 2,
        },
      ]),
    })

    await expect(current.launcher.launchLodgingFlow({
      ...current.input,
      preferredRoomTypeId: ROOM_ID,
    })).resolves.toBe(false)

    expect(current.dependencies.getActiveFlowVersion).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
    expect(current.dependencies.sendSessionFlow).not.toHaveBeenCalled()
  })

  it('lanza una solicitud genérica sin consultar catálogos ajenos', async () => {
    const current = setup('lead')

    await expect(current.launcher.launchLeadFlow(current.input))
      .resolves.toBe(true)

    expect(current.dependencies.getActiveFlowVersion)
      .toHaveBeenCalledWith(BUSINESS_ID, 'lead', 'ycloud')
    expect(current.dependencies.getFlowCatalogProducts).not.toHaveBeenCalled()
    expect(current.dependencies.createFlowSession).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          capability: 'lead',
          source: 'menu',
          schema_version: 1,
        },
      }),
    )
  })

  it.each([
    ['order', 'launchOrderFlow'],
    ['appointment', 'launchAppointmentFlow'],
    ['lodging', 'launchLodgingFlow'],
    ['lead', 'launchLeadFlow'],
  ])('no abre %s sin una versión publicada y activa', async (
    capability,
    method,
  ) => {
    const current = setup(capability, {
      getActiveFlowVersion: vi.fn(async () => null),
      getFlowCatalogProducts: vi.fn(async () => [{
        id: '30000000-0000-4000-8000-000000000001',
        name: 'Producto operativo',
        price: 10,
        active: true,
      }]),
    })

    await expect(current.launcher[method](current.input)).resolves.toBe(false)

    expect(current.dependencies.createFlowSession).not.toHaveBeenCalled()
    expect(current.dependencies.sendSessionFlow).not.toHaveBeenCalled()
  })
})
