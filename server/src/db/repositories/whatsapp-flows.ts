import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export type FlowProvider = 'meta' | 'ycloud'
export type FlowVersionStatus =
  | 'draft'
  | 'provisioning'
  | 'published'
  | 'deprecated'
  | 'blocked'
  | 'failed'
export type FlowSubmissionStatus = 'processed' | 'rejected' | 'failed'

export type JsonObject = Record<string, unknown>

// WhatsApp limita las fuentes de datos dinámicas del Flow. La consulta trae
// una fila adicional únicamente como centinela para detectar desbordamiento;
// esa fila nunca se usa para construir una lista parcial.
export const WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT = 200
export const WHATSAPP_FLOW_CATALOG_MODIFIER_LIMIT = 200

export interface FlowCatalogProductRecord extends JsonObject {
  id: string
  business_id: string
  name: string
  price?: number | string | null
  price_sale?: number | string | null
  stock?: string | null
  tags?: string[] | null
  active?: boolean | null
}

export interface FlowCatalogModifierRecord extends JsonObject {
  id: string
  business_id: string
  category_tag?: string | null
  group_label?: string | null
  name: string
  active?: boolean | null
}

export interface FlowDefinitionRecord extends JsonObject {
  id: string
  business_id: string
  provider: FlowProvider
  waba_id: string
  flow_key: string
  capability_key: string
  display_name: string
  description?: string | null
  configuration: JsonObject
  enabled: boolean
}

export interface FlowVersionRecord extends JsonObject {
  id: string
  flow_id: string
  business_id: string
  provider: FlowProvider
  waba_id: string
  version: number
  provider_flow_id?: string | null
  provider_version?: string | null
  status: FlowVersionStatus
  is_active: boolean
  flow_json: JsonObject
}

export interface FlowSessionRecord extends JsonObject {
  id: string
  business_id: string
  provider: FlowProvider
  flow_version_id: string
  status: 'open' | 'submitted' | 'expired' | 'cancelled'
  context: JsonObject
  context_revision: number
  expires_at: string
}

export interface ResolvedFlowSession extends FlowSessionRecord {
  flow: {
    id: string
    flow_key: string
    capability_key: string
    version: number
    provider_flow_id?: string | null
  }
}

export interface FlowSubmissionRecord extends JsonObject {
  id: string
  business_id: string
  provider: FlowProvider
  session_id: string
  processing_status: string
  payload: JsonObject
  order_id?: string | null
}

export interface FlowSubmissionClaimResult extends JsonObject {
  created: boolean
  result?: 'unavailable'
  submission: FlowSubmissionRecord | null
}

export interface FlowSessionContextUpdateResult extends JsonObject {
  result: 'updated' | 'stale' | 'unavailable' | 'not_found'
  session: FlowSessionRecord | null
}

export interface FlowOrderCreationResult extends JsonObject {
  created: boolean
  order: JsonObject
}

export interface UpsertFlowDefinitionInput {
  id?: string
  businessId: string
  provider: FlowProvider
  wabaId: string
  flowKey: string
  capabilityKey: string
  displayName: string
  description?: string | null
  configuration?: JsonObject
  enabled?: boolean
}

export interface CreateFlowVersionInput {
  businessId: string
  flowId: string
  flowJson: JsonObject
  providerFlowId?: string | null
  providerVersion?: string | null
  dataApiVersion?: string | null
  dataExchangeEndpointPath?: string | null
}

export interface UpdateFlowVersionStateInput {
  businessId: string
  flowVersionId: string
  status: FlowVersionStatus
  providerFlowId?: string | null
  providerVersion?: string | null
  validationErrors?: unknown[]
  publishedAt?: string | null
}

export interface CreateFlowSessionInput {
  businessId: string
  provider: FlowProvider
  flowVersionId: string
  contact: string
  expiresAt: string | Date
  context?: JsonObject
  providerMessageId?: string | null
}

export interface CreateFlowSessionResult {
  flowToken: string
  session: FlowSessionRecord
}

export interface RecordFlowSubmissionInput {
  businessId: string
  provider: FlowProvider
  flowToken: string
  contact: string
  submissionKey: string
  payload: JsonObject
}

export interface CompleteFlowSubmissionInput {
  businessId: string
  submissionId: string
  status: FlowSubmissionStatus
  orderId?: string | null
  errorCode?: string | null
}

export interface FlowOrderItemInput {
  productId: string
  quantity: number
  modifierIds?: string[]
  note?: string | null
}

export interface CreateOrderFromFlowSubmissionInput {
  businessId: string
  submissionId: string
  contactPhone: string
  contactName?: string | null
  items: FlowOrderItemInput[]
  fulfillmentType: 'delivery' | 'pickup' | 'onsite'
  deliveryAddress?: string | null
  deliveryReference?: string | null
  paymentMethod?: string | null
  requestedFulfillmentAt?: string | null
  customerNotes?: string | null
  deliveryFee?: number
  currency?: string
}

export interface RecordFlowMetricInput {
  businessId: string
  provider: FlowProvider
  flowVersionId: string
  sessionId?: string | null
  eventType: string
  sourceKey: string
  metadata?: JsonObject
  occurredAt?: string | null
}

interface DbError {
  message: string
}

interface DbResponse<T> {
  data: T | null
  error: DbError | null
}

const db = require('../client') as SupabaseClient

const sha256 = (value: string): string => crypto
  .createHash('sha256')
  .update(value)
  .digest('hex')

function unwrap<T>(response: DbResponse<T>, operation: string): T {
  if (response.error) {
    throw new Error(`${operation}: ${response.error.message}`)
  }
  if (response.data === null) {
    throw new Error(`${operation}: la base no devolvió datos`)
  }
  return response.data
}

function nullable<T>(response: DbResponse<T>, operation: string): T | null {
  if (response.error) {
    throw new Error(`${operation}: ${response.error.message}`)
  }
  return response.data
}

export function createWhatsAppFlowsRepository(client: SupabaseClient) {
  const getFlowCatalogProducts = async (
    businessId: string,
  ): Promise<FlowCatalogProductRecord[]> => {
    const response = await client
      .from('products')
      .select('id, business_id, name, price, price_sale, stock, tags, active')
      .eq('business_id', businessId)
      .eq('active', true)
      .or('stock.is.null,stock.neq.agotado')
      .order('name')
      .limit(WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT + 1)
    if (response.error) {
      throw new Error(`No se pudo consultar el catálogo del Flow: ${response.error.message}`)
    }
    return (response.data || []) as FlowCatalogProductRecord[]
  }

  const getFlowCatalogModifiers = async (
    businessId: string,
  ): Promise<FlowCatalogModifierRecord[]> => {
    const response = await client
      .from('menu_modifiers')
      .select('id, business_id, category_tag, group_label, name, active')
      .eq('business_id', businessId)
      .eq('active', true)
      .order('category_tag')
      .order('group_label')
      .order('name')
      .limit(WHATSAPP_FLOW_CATALOG_MODIFIER_LIMIT + 1)
    if (response.error) {
      throw new Error(`No se pudieron consultar las opciones del Flow: ${response.error.message}`)
    }
    return (response.data || []) as FlowCatalogModifierRecord[]
  }

  const upsertFlowDefinition = async (
    input: UpsertFlowDefinitionInput,
  ): Promise<FlowDefinitionRecord> => {
    const payload = {
      ...(input.id ? { id: input.id } : {}),
      business_id: input.businessId,
      provider: input.provider,
      waba_id: input.wabaId.trim(),
      flow_key: input.flowKey.trim(),
      capability_key: input.capabilityKey.trim(),
      display_name: input.displayName.trim(),
      description: input.description?.trim() || null,
      configuration: input.configuration || {},
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updated_at: new Date().toISOString(),
    }
    const response = await client
      .from('whatsapp_flow_definitions')
      .upsert(payload, {
        onConflict: 'business_id,provider,waba_id,flow_key',
      })
      .select('*')
      .single()
    return unwrap(
      response as DbResponse<FlowDefinitionRecord>,
      'No se pudo guardar la definición del Flow',
    )
  }

  const listFlowDefinitions = async (
    businessId: string,
  ): Promise<FlowDefinitionRecord[]> => {
    const response = await client
      .from('whatsapp_flow_definitions')
      .select('*,whatsapp_flow_versions(*)')
      .eq('business_id', businessId)
      .order('created_at', { ascending: true })
    if (response.error) {
      throw new Error(`No se pudieron listar los Flows: ${response.error.message}`)
    }
    return (response.data || []) as FlowDefinitionRecord[]
  }

  const createFlowVersion = async (
    input: CreateFlowVersionInput,
  ): Promise<FlowVersionRecord> => {
    const response = await client.rpc('create_whatsapp_flow_version', {
      p_business_id: input.businessId,
      p_flow_id: input.flowId,
      p_flow_json: input.flowJson,
      p_provider_flow_id: input.providerFlowId || null,
      p_provider_version: input.providerVersion || null,
      p_data_api_version: input.dataApiVersion || null,
      p_data_exchange_endpoint_path: input.dataExchangeEndpointPath || null,
    })
    return unwrap(
      response as DbResponse<FlowVersionRecord>,
      'No se pudo crear la versión del Flow',
    )
  }

  const updateFlowVersionState = async (
    input: UpdateFlowVersionStateInput,
  ): Promise<FlowVersionRecord> => {
    const patch: JsonObject = {
      status: input.status,
      updated_at: new Date().toISOString(),
    }
    if (input.providerFlowId !== undefined) {
      patch.provider_flow_id = input.providerFlowId
    }
    if (input.providerVersion !== undefined) {
      patch.provider_version = input.providerVersion
    }
    if (input.validationErrors !== undefined) {
      patch.validation_errors = input.validationErrors
    }
    if (input.publishedAt !== undefined) {
      patch.published_at = input.publishedAt
    } else if (input.status === 'published') {
      patch.published_at = new Date().toISOString()
    }

    const response = await client
      .from('whatsapp_flow_versions')
      .update(patch)
      .eq('business_id', input.businessId)
      .eq('id', input.flowVersionId)
      .select('*')
      .single()
    return unwrap(
      response as DbResponse<FlowVersionRecord>,
      'No se pudo actualizar la versión del Flow',
    )
  }

  const activateFlowVersion = async (
    businessId: string,
    flowVersionId: string,
  ): Promise<FlowVersionRecord> => {
    const response = await client.rpc('activate_whatsapp_flow_version', {
      p_business_id: businessId,
      p_flow_version_id: flowVersionId,
    })
    return unwrap(
      response as DbResponse<FlowVersionRecord>,
      'No se pudo activar la versión del Flow',
    )
  }

  const getActiveFlowVersion = async (
    businessId: string,
    capabilityKey: string,
    provider: FlowProvider,
  ): Promise<FlowVersionRecord | null> => {
    const response = await client
      .from('whatsapp_flow_versions')
      .select(
        '*,whatsapp_flow_definitions!inner(flow_key,capability_key,display_name,configuration,enabled)',
      )
      .eq('business_id', businessId)
      .eq('provider', provider)
      .eq('is_active', true)
      .eq('whatsapp_flow_definitions.enabled', true)
      .eq('whatsapp_flow_definitions.capability_key', capabilityKey)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    return nullable(
      response as DbResponse<FlowVersionRecord>,
      'No se pudo consultar el Flow activo',
    )
  }

  const createFlowSession = async (
    input: CreateFlowSessionInput,
  ): Promise<CreateFlowSessionResult> => {
    const flowToken = crypto.randomBytes(32).toString('base64url')
    const contact = input.contact.trim()
    if (!contact) throw new Error('El contacto de la sesión es obligatorio')

    const response = await client.rpc('create_whatsapp_flow_session', {
      p_business_id: input.businessId,
      p_provider: input.provider,
      p_flow_version_id: input.flowVersionId,
      p_session_token_hash: sha256(flowToken),
      p_contact_key_hash: sha256(
        `${input.provider}:${input.businessId}:${contact}`,
      ),
      p_expires_at: (
        input.expiresAt instanceof Date
          ? input.expiresAt.toISOString()
          : input.expiresAt
      ),
      p_context: input.context || {},
      p_provider_message_id_hash: input.providerMessageId
        ? sha256(input.providerMessageId)
        : null,
    })
    return {
      flowToken,
      session: unwrap(
        response as DbResponse<FlowSessionRecord>,
        'No se pudo crear la sesión del Flow',
      ),
    }
  }

  const getFlowSessionByToken = async (
    provider: FlowProvider,
    flowToken: string,
  ): Promise<ResolvedFlowSession | null> => {
    const response = await client.rpc('resolve_whatsapp_flow_session', {
      p_provider: provider,
      p_session_token_hash: sha256(flowToken),
    })
    return nullable(
      response as DbResponse<ResolvedFlowSession>,
      'No se pudo resolver la sesión del Flow',
    )
  }

  const updateFlowSessionContext = async (
    businessId: string,
    provider: FlowProvider,
    flowToken: string,
    expectedRevision: number,
    context: JsonObject,
  ): Promise<FlowSessionContextUpdateResult> => {
    const response = await client.rpc(
      'update_whatsapp_flow_session_context',
      {
        p_business_id: businessId,
        p_provider: provider,
        p_session_token_hash: sha256(flowToken),
        p_expected_revision: expectedRevision,
        p_context: context,
      },
    )
    return unwrap(
      response as DbResponse<FlowSessionContextUpdateResult>,
      'No se pudo actualizar el contexto del Flow',
    )
  }

  const recordFlowSubmission = async (
    input: RecordFlowSubmissionInput,
  ): Promise<FlowSubmissionClaimResult> => {
    const contact = input.contact.trim()
    if (!contact) throw new Error('El contacto del submission es obligatorio')
    const response = await client.rpc('record_whatsapp_flow_submission', {
      p_business_id: input.businessId,
      p_provider: input.provider,
      p_session_token_hash: sha256(input.flowToken),
      p_contact_key_hash: sha256(
        `${input.provider}:${input.businessId}:${contact}`,
      ),
      p_submission_key_hash: sha256(input.submissionKey),
      p_payload: input.payload,
    })
    return unwrap(
      response as DbResponse<FlowSubmissionClaimResult>,
      'No se pudo registrar la respuesta del Flow',
    )
  }

  const completeFlowSubmission = async (
    input: CompleteFlowSubmissionInput,
  ): Promise<FlowSubmissionRecord | null> => {
    const response = await client.rpc(
      'complete_whatsapp_flow_submission',
      {
        p_business_id: input.businessId,
        p_submission_id: input.submissionId,
        p_processing_status: input.status,
        p_order_id: input.orderId || null,
        p_error_code: input.errorCode || null,
      },
    )
    return nullable(
      response as DbResponse<FlowSubmissionRecord>,
      'No se pudo finalizar la respuesta del Flow',
    )
  }

  const createOrderFromFlowSubmission = async (
    input: CreateOrderFromFlowSubmissionInput,
  ): Promise<FlowOrderCreationResult> => {
    const response = await client.rpc(
      'create_order_from_flow_submission',
      {
        p_business_id: input.businessId,
        p_submission_id: input.submissionId,
        p_contact_phone: input.contactPhone,
        p_contact_name: input.contactName || null,
        p_items: input.items.map(item => ({
          product_id: item.productId,
          quantity: item.quantity,
          modifier_ids: item.modifierIds || [],
          note: item.note?.trim() || null,
        })),
        p_fulfillment_type: input.fulfillmentType,
        p_delivery_address: input.deliveryAddress || null,
        p_delivery_reference: input.deliveryReference || null,
        p_payment_method: input.paymentMethod || null,
        p_requested_fulfillment_at: input.requestedFulfillmentAt || null,
        p_customer_notes: input.customerNotes || null,
        p_delivery_fee: input.deliveryFee || 0,
        p_currency: input.currency || 'USD',
      },
    )
    return unwrap(
      response as DbResponse<FlowOrderCreationResult>,
      'No se pudo crear el pedido desde el Flow',
    )
  }

  const recordFlowMetric = async (
    input: RecordFlowMetricInput,
  ): Promise<boolean> => {
    const response = await client.rpc('record_whatsapp_flow_metric', {
      p_business_id: input.businessId,
      p_provider: input.provider,
      p_flow_version_id: input.flowVersionId,
      p_session_id: input.sessionId || null,
      p_event_type: input.eventType,
      p_source_key_hash: sha256(input.sourceKey),
      p_metadata: input.metadata || {},
      p_occurred_at: input.occurredAt || new Date().toISOString(),
    })
    return unwrap(
      response as DbResponse<boolean>,
      'No se pudo registrar la métrica del Flow',
    )
  }

  const expireFlowSessions = async (
    businessId: string | null = null,
  ): Promise<number> => {
    const response = await client.rpc('expire_whatsapp_flow_sessions', {
      p_business_id: businessId,
    })
    return unwrap(
      response as DbResponse<number>,
      'No se pudieron expirar las sesiones del Flow',
    )
  }

  const getFlowMetrics = async (
    businessId: string,
    from: string,
    to: string,
  ): Promise<JsonObject[]> => {
    const response = await client.rpc('get_whatsapp_flow_metrics', {
      p_business_id: businessId,
      p_from: from,
      p_to: to,
    })
    if (response.error) {
      throw new Error(`No se pudieron consultar las métricas: ${response.error.message}`)
    }
    return (response.data || []) as JsonObject[]
  }

  return {
    getFlowCatalogProducts,
    getFlowCatalogModifiers,
    upsertFlowDefinition,
    listFlowDefinitions,
    createFlowVersion,
    updateFlowVersionState,
    activateFlowVersion,
    getActiveFlowVersion,
    createFlowSession,
    getFlowSessionByToken,
    updateFlowSessionContext,
    recordFlowSubmission,
    completeFlowSubmission,
    createOrderFromFlowSubmission,
    recordFlowMetric,
    expireFlowSessions,
    getFlowMetrics,
  }
}

const repository = createWhatsAppFlowsRepository(db)

export const getFlowCatalogProducts = repository.getFlowCatalogProducts
export const getFlowCatalogModifiers = repository.getFlowCatalogModifiers
export const upsertFlowDefinition = repository.upsertFlowDefinition
export const listFlowDefinitions = repository.listFlowDefinitions
export const createFlowVersion = repository.createFlowVersion
export const updateFlowVersionState = repository.updateFlowVersionState
export const activateFlowVersion = repository.activateFlowVersion
export const getActiveFlowVersion = repository.getActiveFlowVersion
export const createFlowSession = repository.createFlowSession
export const getFlowSessionByToken = repository.getFlowSessionByToken
export const updateFlowSessionContext = repository.updateFlowSessionContext
export const recordFlowSubmission = repository.recordFlowSubmission
export const completeFlowSubmission = repository.completeFlowSubmission
export const createOrderFromFlowSubmission =
  repository.createOrderFromFlowSubmission
export const recordFlowMetric = repository.recordFlowMetric
export const expireFlowSessions = repository.expireFlowSessions
export const getFlowMetrics = repository.getFlowMetrics
