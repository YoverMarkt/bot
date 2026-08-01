import axios from 'axios'
import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import {
  listFlowTemplates,
  recommendedFlowCapabilities,
} from '../services/whatsapp-flow-templates'
import * as ycloud from '../integrations/ycloud'
import type {
  FlowDefinitionRecord,
  FlowVersionRecord,
} from '../db/repositories/whatsapp-flows'
import {
  provisionFlowDraft,
  setupRecommendedFlowsForBusiness,
} from '../services/whatsapp-flow-provisioner'

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
  isWhatsAppFlowCapabilitiesSchemaReady(): Promise<boolean>
}

const auth = require('../middleware/auth') as {
  authAdmin: RequestHandler
}

const router = createRouter()
const FLOW_SCHEMA_NOT_READY_ERROR =
  'Ejecuta migration-whatsapp-flows-capacidades.sql antes de operar WhatsApp Flows'

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
  '/api/admin/flows/:businessId/setup-recommended',
  auth.authAdmin,
  async (req, res) => {
    const setup = await setupRecommendedFlowsForBusiness(
      req.params.businessId,
      { publishAndEnable: true },
    )
    return res.status(setup.ok ? 200 : 409).json(setup)
  },
)

router.post(
  '/api/admin/flows/:businessId/provision',
  auth.authAdmin,
  async (req, res) => {
    const provisioned = await provisionFlowDraft(
      req.params.businessId,
      text(req.body?.templateKey),
      { forceNewVersion: true },
    )
    const status = provisioned.status === 'draft'
      ? 201
      : provisioned.error === 'Negocio no encontrado'
        ? 404
        : provisioned.status === 'blocked'
          || provisioned.status === 'unsupported'
          || provisioned.stage === 'validate'
          || provisioned.stage === 'credentials'
          || provisioned.stage === 'lease'
          || provisioned.stage === 'lease_lost'
          ? 409
          : provisioned.stage === 'create_remote'
            || provisioned.stage === 'verify_draft'
            ? 502
            : 500
    return res.status(status).json(provisioned)
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
    if (!await db.isWhatsAppFlowCapabilitiesSchemaReady()) {
      return res.status(409).json({ error: FLOW_SCHEMA_NOT_READY_ERROR })
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
    if (!await db.isWhatsAppFlowCapabilitiesSchemaReady()) {
      return res.status(409).json({ error: FLOW_SCHEMA_NOT_READY_ERROR })
    }
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
    if (req.body.enabled
      && !await db.isWhatsAppFlowCapabilitiesSchemaReady()) {
      return res.status(409).json({ error: FLOW_SCHEMA_NOT_READY_ERROR })
    }
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
