import crypto from 'node:crypto'
import axios from 'axios'
import {
  buildOrderFlowJson,
} from './whatsapp-flow-json'
import {
  buildAppointmentFlowJson,
} from './whatsapp-flow-json-appointment'
import {
  buildLeadFlowJson,
} from './whatsapp-flow-json-lead'
import {
  buildLodgingFlowJson,
} from './whatsapp-flow-json-lodging'
import {
  flowTemplateByKey,
  recommendedFlowTemplates,
  type FlowTemplateDescriptor,
} from './whatsapp-flow-templates'
import {
  normalizeChannelIdentifier,
} from '../types/channels'
import * as ycloud from '../integrations/ycloud'
import type {
  CreateFlowVersionInput,
  FlowDefinitionRecord,
  FlowVersionRecord,
  JsonObject,
  UpdateFlowVersionStateInput,
  UpsertFlowDefinitionInput,
} from '../db/repositories/whatsapp-flows'

export type FlowProvisionStatus =
  | 'draft'
  | 'published'
  | 'blocked'
  | 'unsupported'
  | 'failed'

export type RecommendedFlowSetupStatus =
  | 'ready'
  | 'partial'
  | 'unsupported'
  | 'failed'

export interface FlowProvisionResult {
  ok: boolean
  businessId: string
  templateKey: string
  capability: string | null
  status: FlowProvisionStatus
  stage: string
  idempotent: boolean
  definitionId: string | null
  versionId: string | null
  providerFlowId: string | null
  enabled: boolean
  validationErrors: unknown[]
  error?: string
}

export interface RecommendedFlowSetupResult {
  ok: boolean
  businessId: string
  status: RecommendedFlowSetupStatus
  publishAndEnable: boolean
  results: FlowProvisionResult[]
  error?: string
}

export interface SetupRecommendedFlowsOptions {
  publishAndEnable: boolean
}

export interface ProvisionFlowDraftOptions {
  /**
   * Crea una versión correctiva aunque ya exista una versión remota válida.
   * El setup automático nunca usa esta opción: es exclusivamente para una
   * acción manual y deliberada del superadmin.
   */
  forceNewVersion?: boolean
}

export interface FlowProvisioningBusiness extends JsonObject {
  id: string
  name?: string | null
  type?: string | null
  slug?: string | null
  whatsapp_provider?: string | null
  whatsapp_number?: string | null
  ycloud_number?: string | null
  ycloud_api_key?: string | null
  ycloud_webhook_secret?: string | null
  takes_orders?: boolean | null
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
  active?: boolean | null
  suspended?: boolean | null
}

export interface FlowDefinitionWithVersions extends FlowDefinitionRecord {
  whatsapp_flow_versions?: FlowVersionRecord[] | null
}

export interface YCloudPhoneNumber {
  phoneNumber?: string | null
  displayName?: string | null
  verifiedName?: string | null
  wabaId?: string | null
  whatsappBusinessAccountId?: string | null
  businessAccountId?: string | null
}

export interface ProviderFlowCreateInput {
  wabaId: string
  name: string
  categories: ycloud.YCloudFlowCategory[]
  flowJson: JsonObject
  publish: false
  endpointUri: string
}

export interface WhatsAppFlowProvisionerDependencies {
  getBusinessById(
    businessId: string,
  ): Promise<FlowProvisioningBusiness | null>
  listFlowDefinitions(
    businessId: string,
  ): Promise<FlowDefinitionWithVersions[]>
  upsertFlowDefinition(
    input: UpsertFlowDefinitionInput,
  ): Promise<FlowDefinitionRecord>
  createFlowVersion(
    input: CreateFlowVersionInput,
  ): Promise<FlowVersionRecord>
  updateFlowVersionState(
    input: UpdateFlowVersionStateInput,
  ): Promise<FlowVersionRecord>
  activateFlowVersion(
    businessId: string,
    flowVersionId: string,
  ): Promise<FlowVersionRecord>
  isWhatsAppFlowCapabilitiesSchemaReady(): Promise<boolean>
  acquireFlowProvisioningLease(input: {
    businessId: string
    templateKey: string
    ownerToken: string
    leaseSeconds?: number
  }): Promise<boolean>
  renewFlowProvisioningLease(input: {
    businessId: string
    templateKey: string
    ownerToken: string
    leaseSeconds?: number
  }): Promise<boolean>
  releaseFlowProvisioningLease(input: {
    businessId: string
    templateKey: string
    ownerToken: string
  }): Promise<boolean>
  listYCloudPhoneNumbers(apiKey: string): Promise<YCloudPhoneNumber[]>
  createProviderFlow(
    apiKey: string,
    input: ProviderFlowCreateInput,
  ): Promise<ycloud.YCloudFlowCreateResult>
  listProviderFlows(
    apiKey: string,
    wabaId: string,
  ): Promise<ycloud.YCloudFlowListItem[]>
  pingDataExchangeEndpoint(endpointUri: string): Promise<unknown>
  retrieveProviderFlow(
    apiKey: string,
    providerFlowId: string,
  ): Promise<ycloud.YCloudFlowListItem>
  publishProviderFlow(
    apiKey: string,
    providerFlowId: string,
  ): Promise<ycloud.YCloudFlowOperationResult>
  getBaseUrl(): string | undefined
  getFallbackYCloudApiKey(): string | undefined
  isProviderNotFound?(error: unknown): boolean
  wait?(milliseconds: number): Promise<void>
}

export interface WhatsAppFlowProvisioner {
  provisionFlowDraft(
    businessId: string,
    templateKey: string,
    options?: ProvisionFlowDraftOptions,
  ): Promise<FlowProvisionResult>
  setupRecommendedFlowsForBusiness(
    businessId: string,
    options: SetupRecommendedFlowsOptions,
  ): Promise<RecommendedFlowSetupResult>
}

const YCLOUD_PHONE_NUMBERS_URL =
  'https://api.ycloud.com/v2/whatsapp/phoneNumbers'
const PROVIDER_TIMEOUT_MS = 15_000
const YCLOUD_PHONE_NUMBER_PAGE_LIMIT = 100
const YCLOUD_PHONE_NUMBER_MAX_PAGES = 100
const DATA_EXCHANGE_PING_TIMEOUT_MS = 3_000
const REMOTE_VERIFY_DELAYS_MS = [250, 500, 1_000, 2_000] as const
// Cada llamada al proveedor vence a los 15 s y la verificación tiene reintentos
// acotados. El lease se renueva antes de crear, publicar, activar y habilitar;
// 15 minutos dejan margen amplio sin mantener un lock indefinido tras un crash.
const PROVISIONING_LEASE_SECONDS = 900

interface YCloudPhoneNumbersPage {
  items?: YCloudPhoneNumber[]
  data?: YCloudPhoneNumber[]
}

export async function listYCloudPhoneNumbersPaginated(
  apiKey: string,
): Promise<YCloudPhoneNumber[]> {
  const numbers: YCloudPhoneNumber[] = []
  for (
    let page = 1;
    page <= YCLOUD_PHONE_NUMBER_MAX_PAGES;
    page += 1
  ) {
    const response = await axios.get<YCloudPhoneNumbersPage>(
      YCLOUD_PHONE_NUMBERS_URL,
      {
        headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        params: {
          page,
          limit: YCLOUD_PHONE_NUMBER_PAGE_LIMIT,
        },
        timeout: PROVIDER_TIMEOUT_MS,
      },
    )
    const pageItems = response.data.items || response.data.data || []
    numbers.push(...pageItems)
    if (pageItems.length < YCLOUD_PHONE_NUMBER_PAGE_LIMIT) return numbers
  }
  throw new Error(
    'YCloud alcanzó su límite documentado de 10.000 números; filtra la cuenta por WABA',
  )
}

export async function pingFlowDataExchangeEndpoint(
  endpointUri: string,
): Promise<unknown> {
  const response = await axios.post(
    endpointUri,
    { action: 'ping' },
    {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: DATA_EXCHANGE_PING_TIMEOUT_MS,
    },
  )
  return response.data
}

class RemoteFlowValidationError extends Error {
  constructor(
    message: string,
    readonly validationErrors: unknown[],
  ) {
    super(message)
    this.name = 'RemoteFlowValidationError'
  }
}

class RemoteFlowStateError extends Error {
  constructor(readonly remoteStatus: 'BLOCKED' | 'DEPRECATED') {
    super(`YCloud devolvió el estado ${remoteStatus}`)
    this.name = 'RemoteFlowStateError'
  }
}

class ProvisioningLeaseLostError extends Error {
  constructor() {
    super(
      'Se perdió el lease de aprovisionamiento antes de completar la operación.',
    )
    this.name = 'ProvisioningLeaseLostError'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function providerOf(business: FlowProvisioningBusiness): string {
  return text(business.whatsapp_provider) || 'ycloud'
}

function versionsOf(
  definition: FlowDefinitionWithVersions,
): FlowVersionRecord[] {
  return Array.isArray(definition.whatsapp_flow_versions)
    ? definition.whatsapp_flow_versions
    : []
}

interface DesiredFlowContract {
  flowJson: JsonObject
  dataApiVersion: string
  dataExchangeEndpointPath: string
  endpointUri: string
  fingerprint: string
}

type FlowVersionPredicate = (version: FlowVersionRecord) => boolean

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => (
      item === undefined ? null : canonicalJsonValue(item)
    ))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => (
          item !== undefined
          && typeof item !== 'function'
          && typeof item !== 'symbol'
        ))
        .sort(([left], [right]) => (
          left < right ? -1 : left > right ? 1 : 0
        ))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalJsonValue(value))
  if (serialized === undefined) {
    throw new Error('El contrato JSON del Flow no es serializable')
  }
  return serialized
}

function flowContractFingerprint(input: {
  flowJson: JsonObject
  dataApiVersion: string
  endpointUri: string
}): string {
  return crypto.createHash('sha256')
    .update(canonicalJson({
      data_api_version: input.dataApiVersion,
      endpoint_uri: input.endpointUri,
      flow_json: input.flowJson,
    }))
    .digest('hex')
}

function versionMatchesContract(
  version: FlowVersionRecord,
  contract: DesiredFlowContract,
): boolean {
  return canonicalJson(version.flow_json) === canonicalJson(contract.flowJson)
    && text(version.data_api_version) === contract.dataApiVersion
    && text(version.data_exchange_endpoint_path)
      === contract.dataExchangeEndpointPath
    && text(version.provider_version) === contract.fingerprint
}

function newestVersion(
  definition: FlowDefinitionWithVersions,
  predicate: FlowVersionPredicate = () => true,
): FlowVersionRecord | null {
  return versionsOf(definition).filter(predicate).sort(
    (left, right) => Number(right.version || 0) - Number(left.version || 0),
  )[0] || null
}

function activePublishedVersion(
  definition: FlowDefinitionWithVersions,
  predicate: FlowVersionPredicate = () => true,
): FlowVersionRecord | null {
  return versionsOf(definition).find(version => (
    version.status === 'published'
    && version.is_active === true
    && Boolean(text(version.provider_flow_id))
    && predicate(version)
  )) || null
}

function publishedVersion(
  definition: FlowDefinitionWithVersions,
  predicate: FlowVersionPredicate = () => true,
): FlowVersionRecord | null {
  return [...versionsOf(definition)]
    .filter(version => (
      version.status === 'published'
      && Boolean(text(version.provider_flow_id))
      && predicate(version)
    ))
    .sort(
      (left, right) => Number(right.version || 0) - Number(left.version || 0),
    )[0] || null
}

function validationErrorsOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error('El proveedor devolvió errores de validación inválidos')
  }
  return value
}

function validationMessage(errors: unknown[]): string {
  const first = errors[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const record = first as Record<string, unknown>
    return text(record.message)
      || text(record.error)
      || 'YCloud rechazó el Flow'
  }
  return 'YCloud rechazó el Flow'
}

function flowJsonFor(templateKey: string): JsonObject {
  if (templateKey === 'order_standard') return buildOrderFlowJson()
  if (templateKey === 'appointment_standard') return buildAppointmentFlowJson()
  if (templateKey === 'lodging_standard') return buildLodgingFlowJson()
  if (templateKey === 'lead_standard') return buildLeadFlowJson()
  throw new Error('La plantilla todavía no tiene una implementación publicable')
}

function providerFlowName(
  business: FlowProvisioningBusiness,
  templateKey: string,
  version: number,
): string {
  const stableBusiness = text(business.slug)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || business.id.replace(/-/g, '').slice(0, 12)
  return `vezzper_${stableBusiness}_${templateKey}_v${version}`.slice(0, 120)
}

function publicDataExchangeUrl(baseValue: unknown): string {
  const base = text(baseValue)
  if (!base) {
    throw new Error('Configura BASE_URL antes de provisionar un WhatsApp Flow')
  }
  let url: URL
  try {
    url = new URL('/webhook/ycloud/flows/data-exchange', base)
  } catch {
    throw new Error('BASE_URL no es una URL válida')
  }
  if (url.protocol !== 'https:') {
    throw new Error('BASE_URL debe usar HTTPS para provisionar un WhatsApp Flow')
  }
  return url.toString()
}

function providerWabaId(number: YCloudPhoneNumber): string {
  return text(number.wabaId)
    || text(number.whatsappBusinessAccountId)
    || text(number.businessAccountId)
}

function providerErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error
      ? error.message
      : 'No se pudo administrar el Flow'
  }
  const body = error.response?.data as {
    message?: unknown
    description?: unknown
    error?: { message?: unknown } | unknown
  } | undefined
  const nested = body?.error && typeof body.error === 'object'
    ? text((body.error as { message?: unknown }).message)
    : ''
  const detail = nested
    || text(body?.message)
    || text(body?.description)
    || text(error.message)
    || 'No se pudo completar la operación con YCloud'
  return `${error.response?.status
    ? `YCloud respondió HTTP ${error.response.status}. `
    : ''}${detail}`.slice(0, 500)
}

function redactSecrets(
  value: string,
  business: FlowProvisioningBusiness | null,
  fallbackApiKey: string,
): string {
  let safe = value
  const secrets = [
    text(business?.ycloud_api_key),
    text(business?.ycloud_webhook_secret),
    fallbackApiKey,
  ].filter(secret => secret.length >= 4)
  for (const secret of secrets) {
    for (const representation of new Set([
      secret,
      encodeURIComponent(secret),
    ])) {
      safe = safe.split(representation).join('••••••')
    }
  }
  return safe.slice(0, 500)
}

function result(input: Partial<FlowProvisionResult> & {
  businessId: string
  templateKey: string
  capability: string | null
  status: FlowProvisionStatus
  stage: string
}): FlowProvisionResult {
  return {
    ok: input.status === 'draft' || input.status === 'published',
    businessId: input.businessId,
    templateKey: input.templateKey,
    capability: input.capability,
    status: input.status,
    stage: input.stage,
    idempotent: input.idempotent === true,
    definitionId: input.definitionId || null,
    versionId: input.versionId || null,
    providerFlowId: input.providerFlowId || null,
    enabled: input.enabled === true,
    validationErrors: input.validationErrors || [],
    ...(input.error ? { error: input.error } : {}),
  }
}

function definitionResult(
  businessId: string,
  template: FlowTemplateDescriptor,
  definition: FlowDefinitionWithVersions,
  version: FlowVersionRecord,
  status: 'draft' | 'published',
  idempotent: boolean,
): FlowProvisionResult {
  return result({
    businessId,
    templateKey: template.key,
    capability: template.capability,
    status,
    stage: status === 'published' ? 'published' : 'draft',
    idempotent,
    definitionId: definition.id,
    versionId: version.id,
    providerFlowId: text(version.provider_flow_id) || null,
    enabled: definition.enabled === true,
  })
}

function remoteStatus(flow: ycloud.YCloudFlowListItem): string {
  return text(flow.status).toUpperCase()
}

function remoteFlowId(flow: ycloud.YCloudFlowListItem): string {
  return text(flow.id)
}

function defaultProviderNotFound(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export function createWhatsAppFlowProvisioner(
  dependencies: WhatsAppFlowProvisionerDependencies,
): WhatsAppFlowProvisioner {
  const sleep = dependencies.wait || wait
  const isProviderNotFound =
    dependencies.isProviderNotFound || defaultProviderNotFound

  function fallbackApiKey(): string {
    return text(dependencies.getFallbackYCloudApiKey())
  }

  function safeError(
    error: unknown,
    business: FlowProvisioningBusiness | null,
  ): string {
    return redactSecrets(
      providerErrorMessage(error),
      business,
      fallbackApiKey(),
    )
  }

  function apiKeyOf(business: FlowProvisioningBusiness): string {
    const apiKey = text(business.ycloud_api_key) || fallbackApiKey()
    if (!apiKey) {
      throw new Error('El negocio no tiene una API Key de YCloud configurada')
    }
    return apiKey
  }

  async function verifyDataExchangeEndpoint(
    endpointUri: string,
  ): Promise<void> {
    let response: unknown
    try {
      response = await dependencies.pingDataExchangeEndpoint(endpointUri)
    } catch {
      throw new Error(
        'No se pudo conectar al endpoint data_exchange mediante el ping',
      )
    }
    const payload = response
      && typeof response === 'object'
      && !Array.isArray(response)
      ? response as Record<string, unknown>
      : {}
    const data = payload.data
      && typeof payload.data === 'object'
      && !Array.isArray(payload.data)
      ? payload.data as Record<string, unknown>
      : {}
    if (data.status !== 'active') {
      throw new Error(
        'El endpoint data_exchange no respondió con data.status=active',
      )
    }
  }

  async function withProvisioningLease(
    businessId: string,
    template: FlowTemplateDescriptor,
    operation: (
      assertLease: () => Promise<void>,
    ) => Promise<FlowProvisionResult>,
  ): Promise<FlowProvisionResult> {
    const ownerToken = crypto.randomUUID()
    let acquired = false
    try {
      acquired = await dependencies.acquireFlowProvisioningLease({
        businessId,
        templateKey: template.key,
        ownerToken,
        leaseSeconds: PROVISIONING_LEASE_SECONDS,
      })
    } catch (error) {
      return result({
        businessId,
        templateKey: template.key,
        capability: template.capability,
        status: 'failed',
        stage: 'lease',
        error: safeError(error, null),
      })
    }
    if (!acquired) {
      return result({
        businessId,
        templateKey: template.key,
        capability: template.capability,
        status: 'failed',
        stage: 'lease',
        idempotent: true,
        error: 'Otro proceso está preparando este Flow. Reintenta en unos minutos.',
      })
    }

    let outcome: FlowProvisionResult
    const assertLease = async (): Promise<void> => {
      let renewed = false
      try {
        renewed = await dependencies.renewFlowProvisioningLease({
          businessId,
          templateKey: template.key,
          ownerToken,
          leaseSeconds: PROVISIONING_LEASE_SECONDS,
        })
      } catch {
        // No se ejecuta ningún efecto remoto si no se puede confirmar que
        // este proceso sigue siendo el dueño vigente.
      }
      if (!renewed) throw new ProvisioningLeaseLostError()
    }
    try {
      outcome = await operation(assertLease)
    } catch (error) {
      outcome = result({
        businessId,
        templateKey: template.key,
        capability: template.capability,
        status: 'failed',
        stage: 'lease_operation',
        error: safeError(error, null),
      })
    }

    try {
      await dependencies.releaseFlowProvisioningLease({
        businessId,
        templateKey: template.key,
        ownerToken,
      })
    } catch {
      // La liberación usa owner fencing y es best-effort. Todos los efectos
      // fueron precedidos por una renovación válida; un fallo posterior al
      // resultado no debe convertir una operación terminada en un falso fallo.
    }
    return outcome
  }

  async function discoverYCloudAccount(
    business: FlowProvisioningBusiness,
  ): Promise<{ apiKey: string; wabaId: string }> {
    const apiKey = apiKeyOf(business)
    const configuredNumber = text(business.ycloud_number)
      || text(business.whatsapp_number)
    const canonical = normalizeChannelIdentifier('phone', configuredNumber)
    if (!canonical) {
      throw new Error(
        'Configura el número YCloud del negocio en formato internacional',
      )
    }
    const numbers = await dependencies.listYCloudPhoneNumbers(apiKey)
    const match = numbers.find(number => (
      normalizeChannelIdentifier('phone', number.phoneNumber) === canonical
    ))
    if (!match) {
      throw new Error(
        'El número del negocio no aparece dentro de la cuenta YCloud configurada',
      )
    }
    const wabaId = providerWabaId(match)
    if (!wabaId) {
      throw new Error('YCloud no devolvió el WABA ID del número configurado')
    }
    return { apiKey, wabaId }
  }

  async function retrieveRemote(
    apiKey: string,
    providerFlowId: string,
    expectedStatus: 'DRAFT' | 'PUBLISHED',
    allowPublishedRecovery = false,
  ): Promise<ycloud.YCloudFlowListItem> {
    for (
      let attempt = 0;
      attempt <= REMOTE_VERIFY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        const remote = await dependencies.retrieveProviderFlow(
          apiKey,
          providerFlowId,
        )
        if (remoteFlowId(remote) !== providerFlowId) {
          throw new Error(
            'YCloud devolvió un Flow distinto al verificar el estado remoto',
          )
        }
        const errors = validationErrorsOf(remote.validationErrors)
        if (errors.length) {
          throw new RemoteFlowValidationError(
            validationMessage(errors),
            errors,
          )
        }
        const status = remoteStatus(remote)
        if (status === expectedStatus
          || (allowPublishedRecovery && status === 'PUBLISHED')) {
          return remote
        }
        if (status === 'BLOCKED' || status === 'DEPRECATED') {
          throw new RemoteFlowStateError(status)
        }
        const delay = REMOTE_VERIFY_DELAYS_MS[attempt]
        if (delay === undefined) {
          throw new Error(
            `YCloud no confirmó el estado ${expectedStatus} del Flow`,
          )
        }
        await sleep(delay)
      } catch (error) {
        if (error instanceof RemoteFlowValidationError
          || error instanceof RemoteFlowStateError) {
          throw error
        }
        const delay = REMOTE_VERIFY_DELAYS_MS[attempt]
        if (!isProviderNotFound(error) || delay === undefined) throw error
        await sleep(delay)
      }
    }
    throw new Error(`YCloud no confirmó el estado ${expectedStatus} del Flow`)
  }

  async function markBlocked(
    businessId: string,
    version: FlowVersionRecord,
    errors: unknown[],
  ): Promise<void> {
    await dependencies.updateFlowVersionState({
      businessId,
      flowVersionId: version.id,
      status: 'blocked',
      providerFlowId: text(version.provider_flow_id) || null,
      validationErrors: errors,
    })
  }

  async function recoverExistingVersion(
    business: FlowProvisioningBusiness,
    template: FlowTemplateDescriptor,
    definition: FlowDefinitionWithVersions,
    version: FlowVersionRecord,
    apiKey: string,
    allowReplacement = false,
  ): Promise<FlowProvisionResult | null> {
    const providerFlowId = text(version.provider_flow_id)
    if (!providerFlowId) {
      throw new Error('La versión todavía no tiene identificador remoto')
    }
    try {
      const remote = await retrieveRemote(
        apiKey,
        providerFlowId,
        version.status === 'published' ? 'PUBLISHED' : 'DRAFT',
        true,
      )
      const status = remoteStatus(remote)
      const saved = version.status === status.toLowerCase()
        ? version
        : await dependencies.updateFlowVersionState({
          businessId: business.id,
          flowVersionId: version.id,
          status: status === 'PUBLISHED' ? 'published' : 'draft',
          providerFlowId,
          validationErrors: [],
        })
      return definitionResult(
        business.id,
        template,
        definition,
        saved,
        status === 'PUBLISHED' ? 'published' : 'draft',
        true,
      )
    } catch (error) {
      if (error instanceof RemoteFlowValidationError) {
        // Una versión activa no puede dejar de estar `published` por la
        // restricción de integridad local. El reemplazo se crea sin alterar
        // esa fila; la activación de la nueva versión la desactivará después.
        if (version.is_active !== true) {
          await markBlocked(business.id, version, error.validationErrors)
        }
        if (allowReplacement) return null
        return result({
          businessId: business.id,
          templateKey: template.key,
          capability: template.capability,
          status: 'blocked',
          stage: 'verify_draft',
          idempotent: true,
          definitionId: definition.id,
          versionId: version.id,
          providerFlowId,
          validationErrors: error.validationErrors,
          error: safeError(error, business),
        })
      }
      if (error instanceof RemoteFlowStateError) {
        if (error.remoteStatus === 'BLOCKED') {
          if (version.is_active !== true) {
            await markBlocked(business.id, version, [])
          }
          if (allowReplacement) return null
          return result({
            businessId: business.id,
            templateKey: template.key,
            capability: template.capability,
            status: 'blocked',
            stage: 'verify_draft',
            idempotent: true,
            definitionId: definition.id,
            versionId: version.id,
            providerFlowId,
            error: safeError(error, business),
          })
        }
        if (version.is_active !== true) {
          await dependencies.updateFlowVersionState({
            businessId: business.id,
            flowVersionId: version.id,
            status: 'deprecated',
            providerFlowId,
            validationErrors: [],
          })
        }
        if (allowReplacement) return null
      }
      if (allowReplacement && isProviderNotFound(error)) {
        if (version.is_active !== true) {
          await dependencies.updateFlowVersionState({
            businessId: business.id,
            flowVersionId: version.id,
            status: 'failed',
            providerFlowId,
            validationErrors: [{
              message:
                'El Flow remoto ya no existe; se creará una versión nueva',
            }],
          })
        }
        return null
      }
      return result({
        businessId: business.id,
        templateKey: template.key,
        capability: template.capability,
        status: 'failed',
        stage: version.status === 'published'
          ? 'verify_published'
          : 'verify_draft',
        idempotent: true,
        definitionId: definition.id,
        versionId: version.id,
        providerFlowId,
        error: safeError(error, business),
      })
    }
  }

  async function provisionFlowDraftInternal(
    businessId: string,
    templateKey: string,
    options: ProvisionFlowDraftOptions = {},
    assertLease: () => Promise<void> = async () => {},
  ): Promise<FlowProvisionResult> {
    let business: FlowProvisioningBusiness | null = null
    let template: FlowTemplateDescriptor | null = null
    let definition: FlowDefinitionWithVersions | null = null
    let version: FlowVersionRecord | null = null
    let providerFlowId: string | null = null
    let recoverRemoteByName = false
    let stage = 'validate'
    try {
      business = await dependencies.getBusinessById(businessId)
      if (!business) throw new Error('Negocio no encontrado')
      template = flowTemplateByKey(templateKey)
      if (!template) throw new Error('Plantilla desconocida')
      if (template.implementation !== 'ready') {
        throw new Error('La plantilla todavía no es publicable')
      }
      if (business.active === false || business.suspended === true) {
        throw new Error('El negocio debe estar activo y sin suspensión')
      }
      if (!recommendedFlowTemplates(business).some(candidate => (
        candidate.key === template?.key
      ))) {
        throw new Error(
          'El negocio no tiene habilitada la capacidad requerida',
        )
      }
      if (providerOf(business) !== 'ycloud') {
        return result({
          businessId,
          templateKey,
          capability: template.capability,
          status: 'unsupported',
          stage: 'provider',
          idempotent: true,
          error: providerOf(business) === 'meta'
            ? 'La publicación automática por Meta directo aún no está disponible'
            : 'WhatsApp Flows requiere un negocio conectado por YCloud',
        })
      }

      stage = 'credentials'
      const { apiKey, wabaId } = await discoverYCloudAccount(business)
      const endpointUri = publicDataExchangeUrl(dependencies.getBaseUrl())
      const flowJson = flowJsonFor(template.key)
      const dataApiVersion = '3.0'
      const desiredContract: DesiredFlowContract = {
        flowJson,
        dataApiVersion,
        dataExchangeEndpointPath: new URL(endpointUri).pathname,
        endpointUri,
        fingerprint: flowContractFingerprint({
          flowJson,
          dataApiVersion,
          endpointUri,
        }),
      }
      const matchesDesiredContract = (
        candidate: FlowVersionRecord,
      ): boolean => versionMatchesContract(candidate, desiredContract)
      const definitions = await dependencies.listFlowDefinitions(business.id)
      definition = definitions.find(item => (
        item.provider === 'ycloud'
        && item.waba_id === wabaId
        && item.flow_key === template?.key
      )) || null

      if (definition && options.forceNewVersion === true) {
        const interrupted = newestVersion(definition)
        if (interrupted
          && interrupted.status === 'provisioning'
          && !text(interrupted.provider_flow_id)
          && matchesDesiredContract(interrupted)) {
          version = interrupted
          recoverRemoteByName = true
        }
      }

      if (definition && options.forceNewVersion !== true) {
        let attemptedVersionId: string | null = null
        const active = activePublishedVersion(
          definition,
          matchesDesiredContract,
        )
        const published = active || publishedVersion(
          definition,
          matchesDesiredContract,
        )
        if (published) {
          attemptedVersionId = published.id
          const recovered = await recoverExistingVersion(
            business,
            template,
            definition,
            published,
            apiKey,
            true,
          )
          if (recovered) return recovered
        }
        const candidate = newestVersion(
          definition,
          matchesDesiredContract,
        )
        if (candidate
          && candidate.id !== attemptedVersionId
          && text(candidate.provider_flow_id)) {
          attemptedVersionId = candidate.id
          const recovered = await recoverExistingVersion(
            business,
            template,
            definition,
            candidate,
            apiKey,
            true,
          )
          if (recovered) return recovered
        }
        if (candidate
          && candidate.id !== attemptedVersionId
          && (candidate.status === 'draft'
            || candidate.status === 'provisioning')) {
          version = candidate
          recoverRemoteByName = candidate.status === 'provisioning'
        }
      }

      stage = 'definition'
      if (!definition) {
        definition = await dependencies.upsertFlowDefinition({
          businessId: business.id,
          provider: 'ycloud',
          wabaId,
          flowKey: template.key,
          capabilityKey: template.capability,
          displayName: template.title,
          description: template.description,
          configuration: {
            registry_version: template.version,
            first_screen: template.firstScreen,
          },
          enabled: false,
        }) as FlowDefinitionWithVersions
      }
      if (!version) {
        version = await dependencies.createFlowVersion({
          businessId: business.id,
          flowId: definition.id,
          flowJson: desiredContract.flowJson,
          providerVersion: desiredContract.fingerprint,
          dataApiVersion: desiredContract.dataApiVersion,
          dataExchangeEndpointPath:
            desiredContract.dataExchangeEndpointPath,
        })
      }

      stage = 'create_remote'
      await dependencies.updateFlowVersionState({
        businessId: business.id,
        flowVersionId: version.id,
        status: 'provisioning',
      })
      const remoteName = providerFlowName(
        business,
        template.key,
        Number(version.version),
      )
      if (recoverRemoteByName) {
        await assertLease()
        const matches = (await dependencies.listProviderFlows(apiKey, wabaId))
          .filter(item => text(item.name) === remoteName)
        if (matches.length > 1) {
          throw new Error(
            'YCloud devolvió más de un Flow con el nombre correctivo esperado',
          )
        }
        providerFlowId = text(matches[0]?.id) || null
      }
      if (!providerFlowId) {
        stage = 'endpoint_ping'
        await verifyDataExchangeEndpoint(endpointUri)
        stage = 'create_remote'
        await assertLease()
        const created = await dependencies.createProviderFlow(apiKey, {
          wabaId,
          name: remoteName,
          categories: template.categories,
          flowJson: version.flow_json,
          publish: false,
          endpointUri,
        })
        providerFlowId = text(created.id)
        if (created.success === false || !providerFlowId) {
          throw new Error('YCloud no confirmó la creación del Flow')
        }
      }
      version = await dependencies.updateFlowVersionState({
        businessId: business.id,
        flowVersionId: version.id,
        status: 'provisioning',
        providerFlowId,
      })

      stage = 'verify_draft'
      const remote = await retrieveRemote(
        apiKey,
        providerFlowId,
        'DRAFT',
      )
      if (remoteStatus(remote) !== 'DRAFT') {
        throw new Error('YCloud no confirmó el borrador remoto')
      }
      version = await dependencies.updateFlowVersionState({
        businessId: business.id,
        flowVersionId: version.id,
        status: 'draft',
        providerFlowId,
        validationErrors: [],
      })
      return definitionResult(
        business.id,
        template,
        definition,
        version,
        'draft',
        false,
      )
    } catch (error) {
      const errors = error instanceof RemoteFlowValidationError
        ? error.validationErrors
        : []
      const blocked = error instanceof RemoteFlowValidationError
        || (
          error instanceof RemoteFlowStateError
          && error.remoteStatus === 'BLOCKED'
        )
      if (version) {
        try {
          const ambiguousRemoteCreation = stage === 'create_remote'
            && !providerFlowId
          await dependencies.updateFlowVersionState({
            businessId,
            flowVersionId: version.id,
            status: blocked
              ? 'blocked'
              : ambiguousRemoteCreation
                ? 'provisioning'
                : 'failed',
            providerFlowId: providerFlowId
              || text(version.provider_flow_id)
              || null,
            validationErrors: blocked
              ? errors
              : [{ message: safeError(error, business) }],
          })
        } catch {
          // El resultado conserva el error original aunque falle su persistencia.
        }
      }
      return result({
        businessId,
        templateKey,
        capability: template?.capability || null,
        status: blocked ? 'blocked' : 'failed',
        stage: error instanceof ProvisioningLeaseLostError
          ? 'lease_lost'
          : stage,
        definitionId: definition?.id || null,
        versionId: version?.id || null,
        providerFlowId: providerFlowId
          || text(version?.provider_flow_id)
          || null,
        validationErrors: errors,
        error: safeError(error, business),
      })
    }
  }

  async function publishActivateEnable(
    draft: FlowProvisionResult,
    assertLease: () => Promise<void> = async () => {},
  ): Promise<FlowProvisionResult> {
    let business: FlowProvisioningBusiness | null = null
    let stage = 'schema_readiness'
    try {
      const schemaReady =
        await dependencies.isWhatsAppFlowCapabilitiesSchemaReady()
      if (!schemaReady) {
        throw new Error(
          'Ejecuta migration-whatsapp-flows-capacidades.sql antes de publicar WhatsApp Flows',
        )
      }
      stage = 'publish'
      business = await dependencies.getBusinessById(draft.businessId)
      if (!business) throw new Error('Negocio no encontrado')
      if (providerOf(business) !== 'ycloud') {
        return {
          ...draft,
          ok: false,
          status: 'unsupported',
          stage: 'provider',
          error: 'La publicación automática actual requiere YCloud',
        }
      }
      const apiKey = apiKeyOf(business)
      const definitions = await dependencies.listFlowDefinitions(
        business.id,
      )
      const definition = definitions.find(item => (
        item.id === draft.definitionId
      ))
      if (!definition) throw new Error('Definición del Flow no encontrada')
      const version = versionsOf(definition).find(item => (
        item.id === draft.versionId
      ))
      if (!version) throw new Error('Versión del Flow no encontrada')
      const providerFlowId = text(version.provider_flow_id)
        || text(draft.providerFlowId)
      if (!providerFlowId) {
        throw new Error('El Flow no tiene identificador del proveedor')
      }

      stage = 'endpoint_ping'
      const endpointUri = publicDataExchangeUrl(dependencies.getBaseUrl())
      await verifyDataExchangeEndpoint(endpointUri)
      stage = 'publish'
      const beforePublish = await retrieveRemote(
        apiKey,
        providerFlowId,
        version.status === 'published' ? 'PUBLISHED' : 'DRAFT',
        true,
      )
      if (remoteStatus(beforePublish) !== 'PUBLISHED') {
        await assertLease()
        const published = await dependencies.publishProviderFlow(
          apiKey,
          providerFlowId,
        )
        if (published.success === false) {
          throw new Error('YCloud no confirmó la publicación del Flow')
        }
      }

      stage = 'verify_published'
      await retrieveRemote(apiKey, providerFlowId, 'PUBLISHED')
      const savedVersion = version.status === 'published'
        ? version
        : await dependencies.updateFlowVersionState({
          businessId: business.id,
          flowVersionId: version.id,
          status: 'published',
          providerFlowId,
          validationErrors: [],
        })

      stage = 'activate'
      if (savedVersion.is_active !== true) {
        await assertLease()
        await dependencies.activateFlowVersion(
          business.id,
          savedVersion.id,
        )
      }

      stage = 'enable'
      if (definition.enabled !== true) {
        await assertLease()
        await dependencies.upsertFlowDefinition({
          id: definition.id,
          businessId: business.id,
          provider: definition.provider,
          wabaId: definition.waba_id,
          flowKey: definition.flow_key,
          capabilityKey: definition.capability_key,
          displayName: definition.display_name,
          description: definition.description,
          configuration: definition.configuration || {},
          enabled: true,
        })
      }
      return {
        ...draft,
        ok: true,
        status: 'published',
        stage: 'complete',
        idempotent: draft.status === 'published'
          && savedVersion.is_active === true
          && definition.enabled === true,
        providerFlowId,
        enabled: true,
        validationErrors: [],
        error: undefined,
      }
    } catch (error) {
      const errors = error instanceof RemoteFlowValidationError
        ? error.validationErrors
        : []
      const blocked = error instanceof RemoteFlowValidationError
        || (
          error instanceof RemoteFlowStateError
          && error.remoteStatus === 'BLOCKED'
        )
      if (blocked && draft.versionId) {
        try {
          await dependencies.updateFlowVersionState({
            businessId: draft.businessId,
            flowVersionId: draft.versionId,
            status: 'blocked',
            providerFlowId: draft.providerFlowId,
            validationErrors: errors,
          })
        } catch {
          // Se devuelve el fallo original y el panel conserva el reintento.
        }
      }
      return {
        ...draft,
        ok: false,
        status: blocked ? 'blocked' : 'failed',
        stage: error instanceof ProvisioningLeaseLostError
          ? 'lease_lost'
          : stage,
        enabled: false,
        validationErrors: errors,
        error: safeError(error, business),
      }
    }
  }

  async function provisionFlowDraft(
    businessId: string,
    templateKey: string,
    options: ProvisionFlowDraftOptions = {},
  ): Promise<FlowProvisionResult> {
    const normalizedBusinessId = text(businessId)
    const normalizedTemplateKey = text(templateKey)
    const template = flowTemplateByKey(normalizedTemplateKey)
    if (!template) {
      return provisionFlowDraftInternal(
        normalizedBusinessId,
        normalizedTemplateKey,
        options,
      )
    }
    return withProvisioningLease(
      normalizedBusinessId,
      template,
      assertLease => provisionFlowDraftInternal(
        normalizedBusinessId,
        normalizedTemplateKey,
        options,
        assertLease,
      ),
    )
  }

  async function setupRecommendedFlowsForBusiness(
    businessId: string,
    options: SetupRecommendedFlowsOptions,
  ): Promise<RecommendedFlowSetupResult> {
    const normalizedBusinessId = text(businessId)
    let business: FlowProvisioningBusiness | null = null
    try {
      business = await dependencies.getBusinessById(normalizedBusinessId)
      if (!business) throw new Error('Negocio no encontrado')
      const templates = recommendedFlowTemplates(business)
      if (options.publishAndEnable) {
        const schemaReady =
          await dependencies.isWhatsAppFlowCapabilitiesSchemaReady()
        if (!schemaReady) {
          const results = templates.map(template => result({
            businessId: normalizedBusinessId,
            templateKey: template.key,
            capability: template.capability,
            status: 'failed',
            stage: 'schema_readiness',
            error:
              'Ejecuta migration-whatsapp-flows-capacidades.sql antes de publicar WhatsApp Flows',
          }))
          return {
            ok: false,
            businessId: normalizedBusinessId,
            status: 'failed',
            publishAndEnable: true,
            results,
            error: results[0]?.error,
          }
        }
      }
      const results: FlowProvisionResult[] = []
      for (const template of templates) {
        const prepared = await withProvisioningLease(
          normalizedBusinessId,
          template,
          async (assertLease) => {
            const draft = await provisionFlowDraftInternal(
              normalizedBusinessId,
              template.key,
              {},
              assertLease,
            )
            return options.publishAndEnable
              && (draft.status === 'draft' || draft.status === 'published')
              ? publishActivateEnable(draft, assertLease)
              : draft
          },
        )
        results.push(prepared)
      }

      const successful = results.filter(item => (
        options.publishAndEnable
          ? item.status === 'published' && item.enabled
          : item.status === 'draft' || item.status === 'published'
      ))
      const unsupported = results.filter(item => item.status === 'unsupported')
      const status: RecommendedFlowSetupStatus = successful.length === results.length
        ? 'ready'
        : unsupported.length === results.length
          ? 'unsupported'
          : successful.length
            ? 'partial'
            : 'failed'
      return {
        ok: status === 'ready',
        businessId: normalizedBusinessId,
        status,
        publishAndEnable: options.publishAndEnable,
        results,
        ...(status === 'ready'
          ? {}
          : {
              error: results.find(item => !item.ok)?.error
                || 'No se pudieron preparar todos los WhatsApp Flows',
            }),
      }
    } catch (error) {
      return {
        ok: false,
        businessId: normalizedBusinessId,
        status: 'failed',
        publishAndEnable: options.publishAndEnable,
        results: [],
        error: safeError(error, business),
      }
    }
  }

  return {
    provisionFlowDraft,
    setupRecommendedFlowsForBusiness,
  }
}

const db = require('../db') as Pick<
  WhatsAppFlowProvisionerDependencies,
  | 'getBusinessById'
  | 'listFlowDefinitions'
  | 'upsertFlowDefinition'
  | 'createFlowVersion'
  | 'updateFlowVersionState'
  | 'activateFlowVersion'
  | 'isWhatsAppFlowCapabilitiesSchemaReady'
  | 'acquireFlowProvisioningLease'
  | 'renewFlowProvisioningLease'
  | 'releaseFlowProvisioningLease'
>

const defaultProvisioner = createWhatsAppFlowProvisioner({
  ...db,
  listYCloudPhoneNumbers: listYCloudPhoneNumbersPaginated,
  createProviderFlow: ycloud.createFlow,
  async listProviderFlows(apiKey, wabaId) {
    const listed = await ycloud.listFlows(apiKey, wabaId)
    return listed.items || []
  },
  pingDataExchangeEndpoint: pingFlowDataExchangeEndpoint,
  retrieveProviderFlow: ycloud.retrieveFlow,
  publishProviderFlow: ycloud.publishFlow,
  getBaseUrl: () => process.env.BASE_URL,
  getFallbackYCloudApiKey: () => process.env.YCLOUD_API_KEY,
})

export const provisionFlowDraft = defaultProvisioner.provisionFlowDraft
export const setupRecommendedFlowsForBusiness =
  defaultProvisioner.setupRecommendedFlowsForBusiness
