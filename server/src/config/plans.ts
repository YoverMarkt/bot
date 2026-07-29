export interface PlanDefinition {
  id: 'micro' | 'basic' | 'pro' | 'growth' | 'scale' | 'enterprise'
  label: string
  monthlyRate: number
  monthlyContactLimit: number
  monthlyOutboundMessageLimit: number
}

// Catálogo comercial oficial. Los identificadores se mantienen estables para
// no romper negocios existentes; por eso "basic" se muestra como "Inicial".
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

export type PlanId = PlanDefinition['id']

const PLAN_ALIASES: Readonly<Record<string, PlanId>> = {
  founder: 'micro',
  premium: 'scale',
}

export function normalizePlanId(value: unknown): PlanId | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  const aliased = PLAN_ALIASES[normalized] || normalized
  return PLAN_CATALOG.some(plan => plan.id === aliased)
    ? aliased as PlanId
    : null
}

export function getPlanDefinition(value: unknown): PlanDefinition | null {
  const id = normalizePlanId(value)
  return id ? PLAN_CATALOG.find(plan => plan.id === id) || null : null
}
