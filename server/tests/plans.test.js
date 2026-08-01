import { describe, expect, it } from 'vitest'
import {
  PLAN_CATALOG,
  getPlanDefinition,
  normalizePlanId,
} from '../dist/config/plans.js'
import { PLAN_CATALOG as ADMIN_PLAN_CATALOG } from '../../apps/admin/src/features/clients/plans.ts'

describe('catálogo comercial de planes', () => {
  it('mantiene exactamente los seis planes aprobados con sus tarifas y límites', () => {
    expect(PLAN_CATALOG).toEqual([
      {
        id: 'micro',
        label: 'Micro',
        monthlyRate: 25,
        monthlyContactLimit: 50,
        monthlyOutboundMessageLimit: 250,
      },
      {
        id: 'basic',
        label: 'Inicial',
        monthlyRate: 50,
        monthlyContactLimit: 200,
        monthlyOutboundMessageLimit: 1000,
      },
      {
        id: 'pro',
        label: 'Pro',
        monthlyRate: 99,
        monthlyContactLimit: 400,
        monthlyOutboundMessageLimit: 2000,
      },
      {
        id: 'growth',
        label: 'Crecimiento',
        monthlyRate: 199,
        monthlyContactLimit: 800,
        monthlyOutboundMessageLimit: 4000,
      },
      {
        id: 'scale',
        label: 'Escala',
        monthlyRate: 499,
        monthlyContactLimit: 2000,
        monthlyOutboundMessageLimit: 10000,
      },
      {
        id: 'enterprise',
        label: 'Empresarial',
        monthlyRate: 899,
        monthlyContactLimit: 4000,
        monthlyOutboundMessageLimit: 20000,
      },
    ])
    expect(ADMIN_PLAN_CATALOG).toEqual(PLAN_CATALOG)
  })

  it('conserva aliases conocidos sin convertir valores desconocidos', () => {
    expect(normalizePlanId('founder')).toBe('micro')
    expect(normalizePlanId('premium')).toBe('scale')
    expect(normalizePlanId('plan-inventado')).toBeNull()
    expect(getPlanDefinition('basic')?.label).toBe('Inicial')
  })
})
