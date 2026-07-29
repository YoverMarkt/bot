import { api } from '../../api/client'

export type FlowImplementation = 'ready' | 'foundation'

export type FlowTemplate = {
  key: string
  capability: string
  version: number
  title: string
  description: string
  categories: string[]
  firstScreen: string
  implementation: FlowImplementation
}

export type FlowDefinitionStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'DEPRECATED'
  | 'PROVISIONING'
  | 'BLOCKED'
  | 'FAILED'
  | 'draft'
  | 'published'
  | 'deprecated'
  | 'provisioning'
  | 'blocked'
  | 'failed'

export type BusinessFlowDefinition = {
  id: string
  templateKey: string
  capability: string
  name: string
  enabled: boolean
  versionId: string | null
  providerFlowId: string | null
  status: FlowDefinitionStatus
  version: number
  isActive: boolean
  activeVersion: number | null
  lastError?: string | null
  updatedAt?: string | null
}

export type FlowBusinessMetrics = Record<string, number | null>

export type FlowBusiness = {
  id: string
  name: string
  type: string | null
  provider: 'ycloud' | 'meta' | 'telegram' | string | null
  wabaId: string | null
  recommendedCapabilities: string[]
  definitions: BusinessFlowDefinition[]
  metrics?: FlowBusinessMetrics
}

export type AdminFlowsResponse = {
  templates: FlowTemplate[]
  businesses: FlowBusiness[]
}

type FlowMutationResult = {
  ok?: boolean
  isActive?: boolean
  activationRequired?: boolean
  activeVersion?: number
  idempotent?: boolean
}

const businessPath = (businessId: string): string => (
  `/api/admin/flows/${encodeURIComponent(businessId)}`
)

export const getAdminFlows = () =>
  api<AdminFlowsResponse>('/api/admin/flows')

export const provisionBusinessFlow = (
  businessId: string,
  templateKey: string,
) => api<FlowMutationResult>(`${businessPath(businessId)}/provision`, {
  method: 'POST',
  body: JSON.stringify({ templateKey }),
})

export const publishBusinessFlow = (
  businessId: string,
  definitionId: string,
) => api<FlowMutationResult>(
  `${businessPath(businessId)}/${encodeURIComponent(definitionId)}/publish`,
  { method: 'POST' },
)

export const activateBusinessFlowVersion = (
  businessId: string,
  definitionId: string,
  versionId: string,
) => api<FlowMutationResult>(
  `${businessPath(businessId)}/${encodeURIComponent(definitionId)}/activate`,
  {
    method: 'POST',
    body: JSON.stringify({ versionId }),
  },
)

export const setBusinessFlowEnabled = (
  businessId: string,
  definitionId: string,
  enabled: boolean,
) => api<FlowMutationResult>(
  `${businessPath(businessId)}/${encodeURIComponent(definitionId)}`,
  {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  },
)
