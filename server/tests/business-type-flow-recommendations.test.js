import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  BUSINESS_TYPE_OPTIONS,
  recommendedLodgingForBusinessType,
  recommendedModeForBusinessType,
  recommendedSalesForBusinessType,
} from '../../apps/admin/src/features/clients/business-types.ts'

const require = createRequire(import.meta.url)
const {
  recommendedFlowCapabilities,
} = require('../dist/services/whatsapp-flow-templates')

const LODGING_TYPES = new Set([
  'hotel',
  'hostal',
  'alojamiento',
  'complejo turístico',
  'resort',
  'cabañas',
])

function persistedRecommendations(type) {
  return {
    type,
    takes_orders: recommendedSalesForBusinessType(type) === 'vende',
    takes_bookings: recommendedModeForBusinessType(type) === 'citas',
    lodging_enabled: recommendedLodgingForBusinessType(type),
  }
}

function expectedCapabilities(flags) {
  const expected = []
  if (flags.lodging_enabled) expected.push('lodging')
  if (flags.takes_orders) expected.push('order')
  if (flags.takes_bookings) expected.push('appointment')
  if (!expected.length) expected.push('lead')
  return expected
}

describe('recomendaciones de Flow por tipo de negocio del panel', () => {
  it.each(BUSINESS_TYPE_OPTIONS)(
    '$label persiste capacidades coherentes con su recomendación',
    option => {
      const persisted = persistedRecommendations(option.value)
      const expected = {
        type: option.value,
        takes_orders: option.sales === 'vende',
        takes_bookings: option.mode === 'citas',
        lodging_enabled: LODGING_TYPES.has(option.value),
      }

      expect(recommendedModeForBusinessType(option.value)).toBe(option.mode)
      expect(recommendedSalesForBusinessType(option.value)).toBe(option.sales)
      expect(persisted).toEqual(expected)
      expect(recommendedFlowCapabilities(persisted))
        .toEqual(expectedCapabilities(expected))
    },
  )

  it.each([
    ['pizzería vegana futura', ['order']],
    ['barbería canina futura', ['appointment']],
    ['nuevo hotel cápsula', ['lodging']],
    ['laboratorio submarino futuro', ['lead']],
  ])('un tipo personalizado “%s” obtiene un fallback seguro', (
    type,
    expected,
  ) => {
    expect(recommendedFlowCapabilities(persistedRecommendations(type)))
      .toEqual(expected)
  })

  it('un tipo futuro puede activar cualquier combinación sin depender de su nombre', () => {
    expect(recommendedFlowCapabilities({
      type: 'tipo que todavía no existe',
      takes_orders: true,
      takes_bookings: true,
      lodging_enabled: true,
    })).toEqual(['lodging', 'order', 'appointment'])
  })
})
