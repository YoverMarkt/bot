import axios from 'axios'
import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import {
  buildOrderFlowJson,
} from '../services/whatsapp-flow-json'
import {
  flowTemplateByKey,
  listFlowTemplates,
  recommendedFlowCapabilities,
} from '../services/whatsapp-flow-templates'
import {
  normalizeChannelIdentifier,
} from '../types/channels'
import * as ycloud from '../integrations/ycloud'
import type {
  FlowDefinitionRecord,
  FlowVersionRecord,
} from '../db/repositories/whatsapp-flows'

type JsonRecord = Record<string, unknown>

interface BusinessRecord extends JsonRecord {
  id: string
  name?: string | null
  type?: string | null
  slug?: string | null
  whatsapp_provider?: string | null
  whatsapp_number?: string | null
  ycloud_number?: string | null
  ycloud_api_key?: string | null
  takes_orders?: boolean | null
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
  active?: boolean | null
  suspended?: boolean | null
}

interface FlowDefinitionWithVersions extends FlowDefinitionRecord {
  whatsapp_flow_versions?: FlowVersionRecord[] | null
}

interface YCloudPhoneNumber {
  phoneNumber?: string | null
  wabaId?: string | null
  whatsappBusinessAccountId?: string | null
  businessAccountId?: string | null
}

interface YCloudPhoneNumbersResponse {
  items?: YCloudPhoneNumber[]
  data?: YCloudPhoneNumber[]
}

const db = require('../db') as {
  getAllBusinesses(): Promise<Array<{ id?: string }>>
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
  listFlowDefinitions(businessId: string): Promise<FlowDefinitionWithVersions[]>
  upsertFlowDefinition(input: {
    id?: string
    businessId: string
    provider: 'ycloud' | 'meta'
    wabaId: string
    flowKey: string
    capabilityKey: string
    displayName: string
    description?: string | null
    configuration?: JsonRecord
    enabled?: boolean
  }): Promise<FlowDefinitionRecord>
  createFlowVersion(input: {
    businessId: string
    flowId: string
    flowJson: JsonRecord
    dataApiVersion?: string | null
    dataExchangeEndpointPath?: string | null
  }): Promise<FlowVersionRecord>
  updateFlowVersionState(input: {
    businessId: string
    flowVersionId: string
    status: 'draft' | 'provisioning' | 'published' | 'blocked' | 'failed'
    providerFlowId?: string | null
    providerVersion?: string | null
    validationErrors?: unknown[]
    publishedAt?: string | null
  }): Promise<FlowVersionRecord>
  activateFlowVersion(
    businessId: string,
    flowVersionId: string,
  ): Promise<FlowVersionRecord>
}

const auth = require('../middleware/auth') as {
  authAdmin: RequestHandler
}

const router = createRouter()
const YCLOUD_PHONE_NUMBERS_URL = 'https://api.ycloud.com/v2/whatsapp/phoneNumbers'
const PROVIDER_TIMEOUT_MS = 15_000
const FLOW_RETRIEVE_DELAYS_MS = [250, 500, 1_000, 2_000] as const

class FlowVerificationError extends Error {
  status = 409

  constructor(message: string) {
    super(message)
    this.name = 'FlowVerificationError'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function providerOf(business: BusinessRecord): string {
  return text(business.whatsapp_provider) || 'ycloud'
}

function ycloudApiKey(business: BusinessRecord): string {
  const key = text(business.ycloud_api_key) || text(process.env.YCLOUD_API_KEY)
  if (!key) throw new Error('El negocio no tiene una API Key de YCloud configurada')
  return key
}

function publicDataExchangeUrl(): string {
  const base = text(process.env.BASE_URL)
  if (!base) {
    throw new Error('Configura BASE_URL antes de provisionar un WhatsApp Flow')
  }
  let url: URL
  try {
    url = new URL(
      '/webhook/ycloud/flows/data-exchange',
      base,
    )
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

async function discoverYCloudWabaId(
  business: BusinessRecord,
): Promise<string> {
  const apiKey = ycloudApiKey(business)
  const configuredNumber = text(business.ycloud_number)
    || text(business.whatsapp_number)
  const canonical = normalizeChannelIdentifier('phone', configuredNumber)
  if (!canonical) {
    throw new Error('Configura el número YCloud del negocio en formato internacional')
  }

  const response = await axios.get<YCloudPhoneNumbersResponse>(
    YCLOUD_PHONE_NUMBERS_URL,
    {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      params: { page: 1, limit: 100 },
      timeout: PROVIDER_TIMEOUT_MS,
    },
  )
  const numbers = response.data.items || response.data.data || []
  const match = numbers.find(number => (
    normalizeChannelIdentifier('phone', number.phoneNumber) === canonical
  ))
  if (!match) {
    throw new Error('El número del negocio no aparece dentro de la cuenta YCloud configurada')
  }
  const wabaId = providerWabaId(match)
  if (!wabaId) {
    throw new Error('YCloud no devolvió el WABA ID del número configurado')
  }
  return wabaId
}

async function retrieveCreatedFlow(
  apiKey: string,
  providerFlowId: string,
): Promise<ycloud.YCloudFlowListItem> {
  for (
    let attempt = 0;
    attempt <= FLOW_RETRIEVE_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return await ycloud.retrieveFlow(apiKey, providerFlowId)
    } catch (error) {
      const notFound = axios.isAxiosError(error)
        && error.response?.status === 404
      if (!notFound) throw error
      const delay = FLOW_RETRIEVE_DELAYS_MS[attempt]
      if (delay === undefined) {
        throw new FlowVerificationError(
          'YCloud creó el Flow, pero todavía no permite verificar el borrador remoto.',
        )
      }
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new FlowVerificationError('No se pudo verificar el borrador remoto en YCloud.')
}

function remoteValidationErrors(
  flow: ycloud.YCloudFlowListItem,
): unknown[] {
  const value = (flow as JsonRecord).validationErrors
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new FlowVerificationError(
      'YCloud devolvió una validación inesperada para el borrador remoto.',
    )
  }
  return value
}

function versionsOf(
  definition: FlowDefinitionWithVersions,
): FlowVersionRecord[] {
  return Array.isArray(definition.whatsapp_flow_versions)
    ? definition.whatsapp_flow_versions
    : []
}

function newestVersion(
  definition: FlowDefinitionWithVersions,
): FlowVersionRecord | null {
  return [...versionsOf(definition)].sort(
    (left, right) => Number(right.version || 0) - Number(left.version || 0),
  )[0] || null
}

function activePublishedVersion(
  definition: FlowDefinitionWithVersions,
): FlowVersionRecord | null {
  return versionsOf(definition).find(version => (
    version.is_active === true && version.status === 'published'
  )) || null
}

async function selectFirstPublishedVersion(
  businessId: string,
  definition: FlowDefinitionWithVersions,
  version: FlowVersionRecord,
): Promise<{
  isActive: boolean
  activationRequired: boolean
}> {
  const activeVersion = activePublishedVersion(definition)
  if (activeVersion?.id === version.id) {
    return { isActive: true, activationRequired: false }
  }
  if (activeVersion) {
    return { isActive: false, activationRequired: true }
  }
  await db.activateFlowVersion(businessId, version.id)
  return { isActive: true, activationRequired: false }
}

function validationMessage(errors: unknown): string | null {
  if (!Array.isArray(errors) || !errors.length) return null
  const first = errors[0]
  if (first && typeof first === 'object') {
    const record = first as Record<string, unknown>
    return text(record.message) || text(record.error) || 'El proveedor rechazó el Flow'
  }
  return 'El proveedor rechazó el Flow'
}

function validationErrorsOf(version: FlowVersionRecord): unknown[] {
  return Array.isArray(version.validation_errors)
    ? version.validation_errors
    : []
}

function httpStatus(error: unknown): number {
  if (error instanceof FlowVerificationError) return error.status
  if (!axios.isAxiosError(error)) return 500
  if (error.response?.status === 401 || error.response?.status === 403) return 409
  if (error.response?.status === 400 || error.response?.status === 404) return 409
  return 502
}

function redactSecrets(value: string, business?: BusinessRecord): string {
  let safe = value
  const secrets = [
    text(business?.ycloud_api_key),
    text(process.env.YCLOUD_API_KEY),
  ].filter(secret => secret.length >= 4)
  for (const secret of secrets) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      safe = safe.split(form).join('••••••')
    }
  }
  return safe
}

function safeProviderError(
  error: unknown,
  business?: BusinessRecord,
): string {
  if (!axios.isAxiosError(error)) {
    return redactSecrets(
      error instanceof Error ? error.message : 'No se pudo administrar el Flow',
      business,
    )
  }
  const status = error.response?.status
  const body = error.response?.data as {
    message?: unknown
    error?: { message?: unknown } | unknown
  } | undefined
  const nested = body?.error && typeof body.error === 'object'
    ? text((body.error as { message?: unknown }).message)
    : ''
  const message = nested || text(body?.message)
  return redactSecrets(`${status ? `YCloud respondió HTTP ${status}. ` : ''}${
    message || 'No se pudo completar la operación con YCloud'
  }`.slice(0, 300), business)
}

function flowJsonFor(templateKey: string): JsonRecord {
  if (templateKey === 'order_standard') return buildOrderFlowJson()
  throw new Error('La plantilla todavía no tiene una implementación publicable')
}

function providerFlowName(
  business: BusinessRecord,
  templateKey: string,
  version: number,
): string {
  const stableBusiness = text(business.slug)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || business.id.replace(/-/g, '').slice(0, 12)
  const base = `vezzper_${stableBusiness}_${templateKey}_v${version}`
  return base.slice(0, 120)
}

async function allFlowBusinesses(): Promise<BusinessRecord[]> {
  const rows = await db.getAllBusinesses()
  const businesses = await Promise.all(rows.flatMap(row => (
    row.id ? [db.getBusinessById(row.id)] : []
  )))
  return businesses.filter((business): business is BusinessRecord => Boolean(business))
}

router.get('/api/admin/flows', auth.authAdmin, async (_req, res) => {
  const businesses = await allFlowBusinesses()
  const payload = await Promise.all(businesses.map(async (business) => {
    const definitions = await db.listFlowDefinitions(business.id)
    const wabaId = definitions.map(definition => text(definition.waba_id))
      .find(Boolean) || null
    return {
      id: business.id,
      name: text(business.name) || 'Negocio',
      type: text(business.type) || null,
      provider: providerOf(business),
      wabaId,
      recommendedCapabilities: recommendedFlowCapabilities(business),
      definitions: definitions.map((definition) => {
        const version = newestVersion(definition)
        const activeVersion = activePublishedVersion(definition)
        return {
          id: definition.id,
          templateKey: definition.flow_key,
          capability: definition.capability_key,
          name: definition.display_name,
          enabled: definition.enabled,
          versionId: version?.id || null,
          providerFlowId: version?.provider_flow_id || null,
          status: version?.status || 'draft',
          version: Number(version?.version || 0),
          isActive: version?.id === activeVersion?.id,
          activeVersion: activeVersion
            ? Number(activeVersion.version || 0)
            : null,
          lastError: validationMessage(version?.validation_errors),
          updatedAt: text(version?.updated_at)
            || text(definition.updated_at)
            || null,
        }
      }),
    }
  }))
  res.json({ templates: listFlowTemplates(), businesses: payload })
})

router.post(
  '/api/admin/flows/:businessId/provision',
  auth.authAdmin,
  async (req, res) => {
    const business = await db.getBusinessById(req.params.businessId)
    if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })
    const template = flowTemplateByKey(text(req.body?.templateKey))
    if (!template) return res.status(400).json({ error: 'Plantilla desconocida' })
    if (template.implementation !== 'ready') {
      return res.status(409).json({
        error: 'La arquitectura de esa plantilla está preparada, pero todavía no es publicable',
      })
    }
    if (business.active === false || business.suspended === true) {
      return res.status(409).json({
        error: 'El negocio debe estar activo y sin suspensión para crear este Flow',
      })
    }
    if (!recommendedFlowCapabilities(business).includes(template.capability)) {
      return res.status(409).json({
        error: 'El negocio no tiene habilitada la capacidad requerida por esta plantilla',
      })
    }
    const provider = providerOf(business)
    if (provider !== 'ycloud') {
      return res.status(409).json({
        error: provider === 'meta'
          ? 'El adaptador de publicación Meta directa está preparado para una siguiente versión'
          : 'WhatsApp Flows requiere un negocio conectado por YCloud',
      })
    }

    let definition: FlowDefinitionRecord | null = null
    let version: FlowVersionRecord | null = null
    let providerFlowId: string | null = null
    try {
      const wabaId = await discoverYCloudWabaId(business)
      const endpointUri = publicDataExchangeUrl()
      const currentDefinitions = await db.listFlowDefinitions(business.id)
      const currentDefinition = currentDefinitions.find(item => (
        item.provider === 'ycloud'
        && item.waba_id === wabaId
        && item.flow_key === template.key
      ))
      definition = await db.upsertFlowDefinition({
        ...(currentDefinition ? { id: currentDefinition.id } : {}),
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
        // Una versión correctiva no apaga el Flow publicado que ya sirve a
        // clientes. La primera definición sí nace deshabilitada.
        enabled: currentDefinition?.enabled ?? false,
      })
      version = await db.createFlowVersion({
        businessId: business.id,
        flowId: definition.id,
        flowJson: flowJsonFor(template.key),
        dataApiVersion: '3.0',
        dataExchangeEndpointPath: new URL(endpointUri).pathname,
      })
      await db.updateFlowVersionState({
        businessId: business.id,
        flowVersionId: version.id,
        status: 'provisioning',
      })

      const created = await ycloud.createFlow(ycloudApiKey(business), {
        wabaId,
        name: providerFlowName(business, template.key, Number(version.version)),
        categories: template.categories,
        flowJson: version.flow_json,
        publish: false,
        endpointUri,
      })
      providerFlowId = text(created.id)
      if (created.success === false || !providerFlowId) {
        throw new Error('YCloud no confirmó la creación del Flow')
      }

      // Guardar el identificador remoto antes de cualquier consulta adicional.
      // Si el proceso falla luego, el borrador no queda huérfano en YCloud.
      await db.updateFlowVersionState({
        businessId: business.id,
        flowVersionId: version.id,
        status: 'provisioning',
        providerFlowId,
      })
      const remoteFlow = await retrieveCreatedFlow(
        ycloudApiKey(business),
        providerFlowId,
      )
      if (text(remoteFlow.id) !== providerFlowId) {
        throw new FlowVerificationError(
          'YCloud devolvió un Flow distinto al verificar el borrador remoto.',
        )
      }
      const errors = remoteValidationErrors(remoteFlow)
      if (errors.length) {
        await db.updateFlowVersionState({
          businessId: business.id,
          flowVersionId: version.id,
          status: 'blocked',
          providerFlowId,
          validationErrors: errors,
        })
        return res.status(409).json({
          error: validationMessage(errors)
            || 'YCloud encontró errores de validación en el borrador',
          ok: false,
          definitionId: definition.id,
          versionId: version.id,
          providerFlowId,
          status: 'blocked',
          validationErrors: errors,
        })
      }
      if (text(remoteFlow.status).toUpperCase() !== 'DRAFT') {
        throw new FlowVerificationError(
          'YCloud devolvió un estado inesperado al verificar el borrador remoto.',
        )
      }
      const saved = await db.updateFlowVersionState({
        businessId: business.id,
        flowVersionId: version.id,
        status: 'draft',
        providerFlowId,
        validationErrors: [],
      })
      return res.status(201).json({
        ok: true,
        definitionId: definition.id,
        versionId: saved.id,
        providerFlowId,
        status: 'draft',
        validationErrors: [],
      })
    } catch (error) {
      if (version) {
        try {
          await db.updateFlowVersionState({
            businessId: business.id,
            flowVersionId: version.id,
            status: 'failed',
            providerFlowId,
            validationErrors: [{ message: safeProviderError(error, business) }],
          })
        } catch {
          // Conservar el error original: el panel puede reintentar creando versión.
        }
      }
      return res.status(httpStatus(error)).json({
        error: safeProviderError(error, business),
      })
    }
  },
)

router.post(
  '/api/admin/flows/:businessId/:definitionId/publish',
  auth.authAdmin,
  async (req, res) => {
    const business = await db.getBusinessById(req.params.businessId)
    if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })
    if (providerOf(business) !== 'ycloud') {
      return res.status(409).json({ error: 'La publicación automática actual usa YCloud' })
    }
    const definitions = await db.listFlowDefinitions(business.id)
    const definition = definitions.find(item => item.id === req.params.definitionId)
    if (!definition) return res.status(404).json({ error: 'Flow no encontrado' })
    const version = newestVersion(definition)
    if (!version?.provider_flow_id) {
      return res.status(409).json({ error: 'El Flow todavía no fue creado en YCloud' })
    }
    const validationErrors = validationErrorsOf(version)
    if (version.status === 'blocked' || validationErrors.length) {
      return res.status(409).json({
        error: 'Corrige los errores de validación antes de publicar el Flow',
        validationErrors,
      })
    }
    if (version.status === 'published') {
      // Si es la primera versión, también repara el caso en que el proceso
      // guardó "published" pero se interrumpió antes de seleccionarla. Una
      // versión correctiva nunca desplaza implícitamente a la activa.
      const activation = await selectFirstPublishedVersion(
        business.id,
        definition,
        version,
      )
      return res.json({
        ok: true,
        status: 'published',
        idempotent: true,
        ...activation,
      })
    }

    try {
      const apiKey = ycloudApiKey(business)
      // Consultar primero hace recuperable el caso en que YCloud publicó, pero
      // el servidor cayó antes de guardar el estado local.
      const remote = await ycloud.listFlows(apiKey, definition.waba_id)
      const remoteFlow = (remote.items || []).find(item => (
        item.id === version.provider_flow_id
      ))
      const remoteErrors = remoteFlow?.validationErrors || []
      if (remoteErrors.length) {
        await db.updateFlowVersionState({
          businessId: business.id,
          flowVersionId: version.id,
          status: 'blocked',
          providerFlowId: version.provider_flow_id,
          validationErrors: remoteErrors,
        })
        return res.status(409).json({
          error: 'YCloud encontró errores de validación en el Flow',
          validationErrors: remoteErrors,
        })
      }
      if (remoteFlow?.status === 'DEPRECATED') {
        return res.status(409).json({
          error: 'Ese Flow fue retirado en YCloud; crea una versión nueva',
        })
      }
      if (remoteFlow?.status !== 'PUBLISHED') {
        const published = await ycloud.publishFlow(
          apiKey,
          version.provider_flow_id,
        )
        if (published.success === false) {
          throw new Error('YCloud no confirmó la publicación del Flow')
        }
      }
      await db.updateFlowVersionState({
        businessId: business.id,
        flowVersionId: version.id,
        status: 'published',
        providerFlowId: version.provider_flow_id,
      })
      const activation = await selectFirstPublishedVersion(
        business.id,
        definition,
        version,
      )
      return res.json({
        ok: true,
        status: 'published',
        ...activation,
      })
    } catch (error) {
      return res.status(httpStatus(error)).json({
        error: safeProviderError(error, business),
      })
    }
  },
)

router.post(
  '/api/admin/flows/:businessId/:definitionId/activate',
  auth.authAdmin,
  async (req, res) => {
    const versionId = text(req.body?.versionId)
    if (!versionId) {
      return res.status(400).json({ error: 'versionId es obligatorio' })
    }
    const business = await db.getBusinessById(req.params.businessId)
    if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })
    const definitions = await db.listFlowDefinitions(business.id)
    const definition = definitions.find(item => item.id === req.params.definitionId)
    if (!definition) return res.status(404).json({ error: 'Flow no encontrado' })
    const version = versionsOf(definition).find(item => item.id === versionId)
    if (!version) {
      return res.status(404).json({ error: 'Versión del Flow no encontrada' })
    }
    if (version.status !== 'published' || !version.provider_flow_id) {
      return res.status(409).json({
        error: 'Solo puedes activar una versión publicada por el proveedor',
      })
    }
    const current = activePublishedVersion(definition)
    if (current?.id === version.id) {
      return res.json({
        ok: true,
        status: 'published',
        isActive: true,
        activeVersion: Number(version.version || 0),
        idempotent: true,
      })
    }
    try {
      const active = await db.activateFlowVersion(business.id, version.id)
      return res.json({
        ok: true,
        status: 'published',
        isActive: true,
        activeVersion: Number(active.version || version.version || 0),
      })
    } catch (error) {
      return res.status(500).json({
        error: safeProviderError(error, business),
      })
    }
  },
)

router.patch(
  '/api/admin/flows/:businessId/:definitionId',
  auth.authAdmin,
  async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled debe ser booleano' })
    }
    const business = await db.getBusinessById(req.params.businessId)
    if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })
    const definitions = await db.listFlowDefinitions(business.id)
    const definition = definitions.find(item => item.id === req.params.definitionId)
    if (!definition) return res.status(404).json({ error: 'Flow no encontrado' })
    if (req.body.enabled) {
      const version = versionsOf(definition).find(item => (
        item.is_active && item.status === 'published'
      ))
      if (!version) {
        return res.status(409).json({
          error: 'Solo puedes habilitar una versión publicada y activa; reintenta la publicación',
        })
      }
    }
    const saved = await db.upsertFlowDefinition({
      id: definition.id,
      businessId: business.id,
      provider: definition.provider,
      wabaId: definition.waba_id,
      flowKey: definition.flow_key,
      capabilityKey: definition.capability_key,
      displayName: definition.display_name,
      description: definition.description,
      configuration: definition.configuration || {},
      enabled: req.body.enabled,
    })
    return res.json({ ok: true, enabled: saved.enabled })
  },
)

export = router
