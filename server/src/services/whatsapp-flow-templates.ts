export const KNOWN_FLOW_CAPABILITIES = [
  'order',
  'appointment',
  'lodging',
  'lead',
] as const

export type KnownFlowCapability = typeof KNOWN_FLOW_CAPABILITIES[number]
export type FlowCapability = KnownFlowCapability | (string & {})

export type MetaFlowCategory =
  | 'SIGN_UP'
  | 'SIGN_IN'
  | 'APPOINTMENT_BOOKING'
  | 'LEAD_GENERATION'
  | 'CONTACT_US'
  | 'CUSTOMER_SUPPORT'
  | 'SURVEY'
  | 'OTHER'

export interface FlowTemplateDescriptor {
  key: string
  capability: KnownFlowCapability
  version: number
  title: string
  description: string
  categories: MetaFlowCategory[]
  firstScreen: string
  implementation: 'ready' | 'foundation'
}

export interface FlowBusinessCapabilities {
  type?: string | null
  takes_orders?: boolean | null
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
}

const FLOW_TEMPLATE_REGISTRY: readonly FlowTemplateDescriptor[] = [
  {
    key: 'order_standard',
    capability: 'order',
    version: 1,
    title: 'Pedido',
    description: 'Catálogo, variantes, cantidades, entrega o retiro y confirmación.',
    categories: ['OTHER'],
    firstScreen: 'ORDER_METHOD',
    implementation: 'ready',
  },
  {
    key: 'appointment_standard',
    capability: 'appointment',
    version: 1,
    title: 'Agendar una cita',
    description: 'Servicio, fecha, horario disponible y datos de contacto.',
    categories: ['APPOINTMENT_BOOKING'],
    firstScreen: 'APPOINTMENT_SERVICE',
    implementation: 'foundation',
  },
  {
    key: 'lodging_standard',
    capability: 'lodging',
    version: 1,
    title: 'Cotizar hospedaje',
    description: 'Fechas, huéspedes, habitación, cotización y solicitud.',
    categories: ['OTHER'],
    firstScreen: 'LODGING_DATES',
    implementation: 'foundation',
  },
  {
    key: 'lead_standard',
    capability: 'lead',
    version: 1,
    title: 'Solicitar información',
    description: 'Interés, datos mínimos y derivación al equipo.',
    categories: ['LEAD_GENERATION', 'CONTACT_US'],
    firstScreen: 'LEAD_DETAILS',
    implementation: 'foundation',
  },
] as const

export function listFlowTemplates(): FlowTemplateDescriptor[] {
  return FLOW_TEMPLATE_REGISTRY.map(template => ({
    ...template,
    categories: [...template.categories],
  }))
}

export function flowTemplateByKey(
  key: string,
): FlowTemplateDescriptor | null {
  const normalized = String(key || '').trim()
  const template = FLOW_TEMPLATE_REGISTRY.find(item => item.key === normalized)
  return template ? {
    ...template,
    categories: [...template.categories],
  } : null
}

/**
 * La fuente de verdad son capacidades persistidas, no el nombre comercial.
 * Así un tipo nuevo obtiene Flows sin cambiar esta función: onboarding solo
 * debe activar takes_orders, takes_bookings o lodging_enabled.
 */
export function recommendedFlowCapabilities(
  business: FlowBusinessCapabilities,
): KnownFlowCapability[] {
  const capabilities: KnownFlowCapability[] = []
  if (business.lodging_enabled === true) capabilities.push('lodging')
  // `takes_orders` históricamente fue una capacidad opt-out; algunos tenants
  // antiguos pueden tener NULL aunque el bot ya les permita vender.
  if (business.takes_orders !== false) capabilities.push('order')
  if (business.takes_bookings === true) capabilities.push('appointment')
  if (!capabilities.length) capabilities.push('lead')
  return capabilities
}

export function recommendedFlowTemplates(
  business: FlowBusinessCapabilities,
): FlowTemplateDescriptor[] {
  const capabilities = new Set(recommendedFlowCapabilities(business))
  return listFlowTemplates().filter(template => capabilities.has(template.capability))
}
