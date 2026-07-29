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
  status?: FlowDefinitionStatus
  error?: string
  validationErrors?: unknown[]
  isActive?: boolean
  activationRequired?: boolean
  activeVersion?: number
  enabled?: boolean
  idempotent?: boolean
}

const businessPath = (businessId: string): string => (
  `/api/admin/flows/${encodeURIComponent(businessId)}`
)

export const getAdminFlows = () =>
  api<AdminFlowsResponse>('/api/admin/flows')

function flowValidationMessage(errors: unknown[] | undefined): string | null {
  const first = errors?.[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  const record = first as Record<string, unknown>
  const message = typeof record.message === 'string'
    ? record.message.trim()
    : typeof record.error === 'string'
      ? record.error.trim()
      : ''
  return message || null
}

export const provisionBusinessFlow = async (
  businessId: string,
  templateKey: string,
) => {
  const result = await api<FlowMutationResult>(
    `${businessPath(businessId)}/provision`,
    {
      method: 'POST',
      body: JSON.stringify({ templateKey }),
    },
  )
  const status = String(result.status || '').toLowerCase()
  const hasValidationContract = Array.isArray(result.validationErrors)
  const validationErrors = hasValidationContract
    ? result.validationErrors as unknown[]
    : []
  if (result.ok !== true
    || status !== 'draft'
    || !hasValidationContract
    || validationErrors.length) {
    throw new Error(
      flowValidationMessage(validationErrors)
      || result.error
      || 'YCloud no confirmó un borrador válido del Flow',
    )
  }
  return result
}

export const publishBusinessFlow = (
  businessId: string,
  definitionId: string,
) => api<FlowMutationResult>(
  `${businessPath(businessId)}/${encodeURIComponent(definitionId)}/publish`,
  { method: 'POST' },
).then((result) => {
  if (result.ok !== true
    || String(result.status || '').toLowerCase() !== 'published') {
    throw new Error(result.error || 'El proveedor no confirmó la publicación del Flow')
  }
  return result
})

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
).then((result) => {
  if (result.ok !== true
    || String(result.status || '').toLowerCase() !== 'published'
    || result.isActive !== true) {
    throw new Error(result.error || 'No se confirmó la versión activa del Flow')
  }
  return result
})

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
).then((result) => {
  if (result.ok !== true || result.enabled !== enabled) {
    throw new Error(result.error || 'No se confirmó el estado del Flow')
  }
  return result
})
