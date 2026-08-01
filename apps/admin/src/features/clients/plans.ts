export type PlanId =
  | 'micro'
  | 'basic'
  | 'pro'
  | 'growth'
  | 'scale'
  | 'enterprise'

export interface PlanDefinition {
  id: PlanId
  label: string
  monthlyRate: number
  monthlyContactLimit: number
  monthlyOutboundMessageLimit: number
}

// Espejo visual del catálogo validado por el servidor. Mantener los ids permite
// que los contratos anteriores sigan siendo editables sin cambiar su historial.
export const PLAN_CATALOG: readonly PlanDefinition[] = [
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
    monthlyOutboundMessageLimit: 1_000,
  },
  {
    id: 'pro',
    label: 'Pro',
    monthlyRate: 99,
    monthlyContactLimit: 400,
    monthlyOutboundMessageLimit: 2_000,
  },
  {
    id: 'growth',
    label: 'Crecimiento',
    monthlyRate: 199,
    monthlyContactLimit: 800,
    monthlyOutboundMessageLimit: 4_000,
  },
  {
    id: 'scale',
    label: 'Escala',
    monthlyRate: 499,
    monthlyContactLimit: 2_000,
    monthlyOutboundMessageLimit: 10_000,
  },
  {
    id: 'enterprise',
    label: 'Empresarial',
    monthlyRate: 899,
    monthlyContactLimit: 4_000,
    monthlyOutboundMessageLimit: 20_000,
  },
] as const

export function planById(value: string | null | undefined): PlanDefinition | undefined {
  const current = value?.trim().toLowerCase()
  const normalized = current === 'premium'
    ? 'scale'
    : current === 'founder'
      ? 'micro'
      : current
  return PLAN_CATALOG.find(plan => plan.id === normalized)
}

export function planLabel(value: string | null | undefined): string {
  return planById(value)?.label || value || 'Sin asignar'
}
