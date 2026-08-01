import type {
  FlowProvider,
  FlowSessionContextUpdateResult,
  JsonObject,
  ResolvedFlowSession,
} from '../db/repositories/whatsapp-flows'
import {
  FlowDataExchangeError,
  type FlowDataExchangeRequest,
  type FlowDataExchangeResponse,
} from './whatsapp-flow-data-exchange'
import { recordFlowMetricBestEffort } from './whatsapp-flow-metrics'

const MAX_TOKEN_LENGTH = 512
const MAX_TOPICS = 20
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

type DataRecord = Record<string, unknown>

export interface LeadFlowBusiness extends JsonObject {
  id?: string
  name?: string | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
  lead_enabled?: boolean | null
  lead_topics?: unknown
}

export interface LeadTopicOption extends JsonObject {
  id: string
  title: string
}

export interface CanonicalLeadDraft extends JsonObject {
  schema_version: 1
  contact_name: string
  topic_id: string
  topic_label: string
  details: string
  email: string | null
  preferred_time: string | null
}

interface LeadContext extends JsonObject {
  lead_draft?: CanonicalLeadDraft
}

export interface LeadFlowDataExchangeDependencies {
  updateFlowSessionContext(
    businessId: string,
    provider: FlowProvider,
    flowToken: string,
    expectedRevision: number,
    context: JsonObject,
  ): Promise<FlowSessionContextUpdateResult>
  recordFlowMetric?(input: {
    businessId: string
    provider: FlowProvider
    flowVersionId: string
    sessionId?: string | null
    eventType: string
    sourceKey: string
    metadata?: JsonObject
  }): Promise<boolean>
}

export interface LeadFlowDataExchangeInput {
  request: FlowDataExchangeRequest
  session: ResolvedFlowSession
  business: LeadFlowBusiness
  flowToken: string
  configuration?: JsonObject | null
}

const FALLBACK_TOPICS: readonly LeadTopicOption[] = [
  { id: 'informacion', title: 'Información' },
  { id: 'cotizacion', title: 'Cotización' },
  { id: 'hablar-equipo', title: 'Hablar con el equipo' },
]

const asRecord = (value: unknown): DataRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as DataRecord
    : {}
)

const cleanText = (
  value: unknown,
  maximum: number,
  required = false,
): string | null => {
  if (value === undefined || value === null) {
    if (required) {
      throw new FlowDataExchangeError(422, 'Completa los campos obligatorios.')
    }
    return null
  }
  if (typeof value !== 'string') {
    throw new FlowDataExchangeError(422, 'Uno de los campos no es válido.')
  }
  const clean = value.trim()
  if ((required && !clean) || clean.length > maximum) {
    throw new FlowDataExchangeError(422, 'Uno de los campos no es válido.')
  }
  return clean || null
}

const topicId = (value: unknown): string => String(value || '')
  .trim()
  .toLocaleLowerCase('es')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\p{L}\p{N}_-]+/gu, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64)

const topicTitle = (value: unknown): string => {
  const clean = String(value || '').trim()
  if (clean.length <= 30) return clean
  return `${clean.slice(0, 29)}…`
}
const headingText = (value: unknown): string => {
  const clean = String(value || '').trim()
  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`
}

function configuredTopicSource(configuration: unknown): unknown[] {
  if (Array.isArray(configuration)) return configuration
  const source = asRecord(configuration)
  const lead = asRecord(source.lead)
  const candidate = source.lead_topics ?? source.topics ?? lead.topics
  return Array.isArray(candidate) ? candidate : []
}

/**
 * Convierte una configuración controlada por el negocio en opciones válidas
 * del Flow. Nunca mezcla catálogos: si la configuración entregada no contiene
 * temas utilizables se usan opciones genéricas locales.
 */
export function resolveLeadTopics(configuration?: unknown): LeadTopicOption[] {
  const topics: LeadTopicOption[] = []
  const usedIds = new Set<string>()
  for (const raw of configuredTopicSource(configuration)) {
    const item = asRecord(raw)
    const title = topicTitle(
      typeof raw === 'string'
        ? raw
        : item.title ?? item.label ?? item.name,
    )
    const id = topicId(
      typeof raw === 'string'
        ? raw
        : item.id ?? item.value ?? title,
    )
    if (!id || !title || usedIds.has(id)) continue
    usedIds.add(id)
    topics.push({ id, title })
    if (topics.length >= MAX_TOPICS) break
  }
  return topics.length
    ? topics
    : FALLBACK_TOPICS.map(topic => ({ ...topic }))
}

function contextOf(session: ResolvedFlowSession): LeadContext {
  return asRecord(session.context) as LeadContext
}

function token(value: string): string {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (!clean
    || clean.length > MAX_TOKEN_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new FlowDataExchangeError(400, 'El token del formulario no es válido.')
  }
  return clean
}

function validateResolvedInput(
  session: ResolvedFlowSession,
  business: LeadFlowBusiness,
): void {
  if (session.flow?.capability_key !== 'lead') {
    throw new FlowDataExchangeError(
      403,
      'Este formulario no corresponde a solicitudes.',
    )
  }
  if (session.status !== 'open' || Date.parse(session.expires_at) <= Date.now()) {
    throw new FlowDataExchangeError(
      410,
      'La sesión del formulario expiró. Vuelve al chat.',
    )
  }
  if ((business.id && business.id !== session.business_id)
    || business.active === false
    || business.bot_active === false
    || business.suspended === true
    || business.lead_enabled === false) {
    throw new FlowDataExchangeError(
      403,
      'Las solicitudes no están disponibles en este momento.',
    )
  }
}

function storedDraft(
  context: LeadContext,
  topics: LeadTopicOption[],
): CanonicalLeadDraft | null {
  const source = asRecord(context.lead_draft)
  if (source.schema_version !== 1) return null
  try {
    const contactName = cleanText(source.contact_name, 120, true) as string
    const selectedTopic = topics.find(topic => topic.id === source.topic_id)
    const details = cleanText(source.details, 1000, true) as string
    const email = cleanText(source.email, 254)
    if (!selectedTopic || (email && !EMAIL_PATTERN.test(email))) return null
    return {
      schema_version: 1,
      contact_name: contactName,
      topic_id: selectedTopic.id,
      topic_label: selectedTopic.title,
      details,
      email,
      preferred_time: cleanText(source.preferred_time, 120),
    }
  } catch {
    return null
  }
}

function detailsData(
  business: LeadFlowBusiness,
  topics: LeadTopicOption[],
  draft: CanonicalLeadDraft | null,
  errorMessage = '',
): DataRecord {
  return {
    business_name: headingText(business.name || 'Nuestro negocio'),
    topics,
    contact_name: draft?.contact_name || '',
    topic_id: draft?.topic_id || '',
    details: draft?.details || '',
    email: draft?.email || '',
    preferred_time: draft?.preferred_time || '',
    error_message: errorMessage,
  }
}

function reviewData(
  flowToken: string,
  draft: CanonicalLeadDraft,
): DataRecord {
  const optional = [
    draft.email ? `Correo: ${draft.email}` : '',
    draft.preferred_time ? `Horario preferido: ${draft.preferred_time}` : '',
  ].filter(Boolean)
  return {
    flow_token: flowToken,
    contact_name: draft.contact_name,
    topic_id: draft.topic_id,
    topic_label: draft.topic_label,
    details: draft.details,
    email: draft.email || '',
    preferred_time: draft.preferred_time || '',
    summary: [
      `Nombre: ${draft.contact_name}`,
      `Solicitud: ${draft.details}`,
      ...optional,
    ].join('\n'),
  }
}

function recordStepMetric(
  dependencies: LeadFlowDataExchangeDependencies,
  session: ResolvedFlowSession,
  eventType: string,
  discriminator = '',
): void {
  recordFlowMetricBestEffort(
    dependencies.recordFlowMetric,
    {
      businessId: session.business_id,
      provider: session.provider,
      flowVersionId: session.flow_version_id,
      sessionId: session.id,
      eventType,
      sourceKey: [
        session.id,
        eventType,
        session.context_revision,
        discriminator,
      ].join(':'),
      metadata: {},
    },
  )
}

async function persistDraft(
  dependencies: LeadFlowDataExchangeDependencies,
  session: ResolvedFlowSession,
  flowToken: string,
  context: LeadContext,
  draft: CanonicalLeadDraft,
): Promise<void> {
  const result = await dependencies.updateFlowSessionContext(
    session.business_id,
    session.provider,
    flowToken,
    session.context_revision,
    {
      ...context,
      lead_draft: draft,
    },
  )
  if (result.result === 'stale') {
    throw new FlowDataExchangeError(
      409,
      'El formulario cambió. Intenta nuevamente.',
    )
  }
  if (result.result !== 'updated') {
    throw new FlowDataExchangeError(
      410,
      'La sesión del formulario ya no está disponible.',
    )
  }
}

function leadConfiguration(input: LeadFlowDataExchangeInput): unknown {
  if (input.configuration) return input.configuration
  return { lead_topics: input.business.lead_topics }
}

/**
 * Maneja únicamente la capacidad `lead`. La resolución del token, sesión y
 * negocio corresponde al dispatcher común; aquí se vuelve a comprobar su
 * coherencia como defensa en profundidad.
 */
export async function handleLeadFlowDataExchange(
  input: LeadFlowDataExchangeInput,
  dependencies: LeadFlowDataExchangeDependencies,
): Promise<FlowDataExchangeResponse> {
  const { request, session, business } = input
  const flowToken = token(input.flowToken)
  validateResolvedInput(session, business)
  const topics = resolveLeadTopics(leadConfiguration(input))
  const context = contextOf(session)
  const currentDraft = storedDraft(context, topics)

  try {
    if (request.action === 'INIT') {
      recordStepMetric(dependencies, session, 'step.init')
      return {
        screen: 'LEAD_DETAILS',
        data: detailsData(business, topics, currentDraft),
      }
    }

    if (request.action === 'BACK') {
      const currentScreen = cleanText(request.screen, 64)
      recordStepMetric(
        dependencies,
        session,
        'step.back',
        currentScreen || 'LEAD_REVIEW',
      )
      return {
        screen: 'LEAD_DETAILS',
        data: detailsData(business, topics, currentDraft),
      }
    }

    const requestData = asRecord(request.data)
    const intent = request.action === 'data_exchange'
      ? String(requestData.intent || '')
      : String(request.action || '')
    if (intent !== 'review_lead') {
      throw new FlowDataExchangeError(
        422,
        'La acción del formulario no es válida.',
      )
    }

    const contactName = cleanText(
      requestData.contact_name,
      120,
      true,
    ) as string
    if (contactName.length < 2) {
      throw new FlowDataExchangeError(
        422,
        'Escribe un nombre válido para la solicitud.',
      )
    }
    const selectedTopicId = cleanText(
      requestData.topic_id,
      64,
      true,
    ) as string
    const selectedTopic = topics.find(topic => topic.id === selectedTopicId)
    if (!selectedTopic) {
      throw new FlowDataExchangeError(422, 'Elige un tema válido.')
    }
    const details = cleanText(requestData.details, 1000, true) as string
    if (details.length < 2) {
      throw new FlowDataExchangeError(
        422,
        'Describe brevemente lo que necesitas.',
      )
    }
    const email = cleanText(requestData.email, 254)
    if (email && !EMAIL_PATTERN.test(email)) {
      throw new FlowDataExchangeError(
        422,
        'Escribe un correo electrónico válido.',
      )
    }
    const preferredTime = cleanText(requestData.preferred_time, 120)
    const canonicalDraft: CanonicalLeadDraft = {
      schema_version: 1,
      contact_name: contactName,
      topic_id: selectedTopic.id,
      topic_label: selectedTopic.title,
      details,
      email,
      preferred_time: preferredTime,
    }

    await persistDraft(
      dependencies,
      session,
      flowToken,
      context,
      canonicalDraft,
    )
    recordStepMetric(dependencies, session, 'step.review_lead')
    return {
      screen: 'LEAD_REVIEW',
      data: reviewData(flowToken, canonicalDraft),
    }
  } catch (error) {
    if (error instanceof FlowDataExchangeError
      && (error.status === 409 || error.status === 422)) {
      return {
        screen: 'LEAD_DETAILS',
        data: detailsData(
          business,
          topics,
          currentDraft,
          error.publicMessage,
        ),
      }
    }
    throw error
  }
}

export function createLeadFlowDataExchangeHandler(
  dependencies: LeadFlowDataExchangeDependencies,
) {
  return (
    input: LeadFlowDataExchangeInput,
  ): Promise<FlowDataExchangeResponse> => (
    handleLeadFlowDataExchange(input, dependencies)
  )
}
