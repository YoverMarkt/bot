import {
  WHATSAPP_FLOW_CATALOG_MODIFIER_LIMIT,
  WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT,
  type FlowProvider,
  type FlowVersionRecord,
  type JsonObject,
} from '../db/repositories/whatsapp-flows'
import type { WhatsAppBusiness } from '../integrations/whatsapp'

interface LaunchBusiness extends WhatsAppBusiness, JsonObject {
  id: string
  name?: string | null
  takes_orders?: boolean | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
}

interface LauncherDependencies {
  getFlowCatalogProducts(businessId: string): Promise<unknown[]>
  getFlowCatalogModifiers(businessId: string): Promise<unknown[]>
  getActiveFlowVersion(
    businessId: string,
    capabilityKey: string,
    provider: FlowProvider,
  ): Promise<FlowVersionRecord | null>
  createFlowSession(input: {
    businessId: string
    provider: FlowProvider
    flowVersionId: string
    contact: string
    expiresAt: Date
    context: JsonObject
  }): Promise<{
    flowToken: string
    session: { id: string }
  }>
  recordFlowMetric(input: {
    businessId: string
    provider: FlowProvider
    flowVersionId: string
    sessionId?: string | null
    eventType: string
    sourceKey: string
    metadata?: JsonObject
  }): Promise<boolean>
  sendSessionFlow(
    business: WhatsAppBusiness,
    to: string,
    launch: {
      flowId: string
      flowToken: string
      body: string
      cta: string
      action: 'data_exchange'
    },
    deliveryMode?: 'queued' | 'direct',
  ): Promise<void>
  now?(): number
}

export interface LaunchOrderFlowInput {
  business: LaunchBusiness
  phone: string
  source?: 'menu' | 'ai'
}

const FLOW_SESSION_TTL_MS = 30 * 60 * 1000

function providerFor(business: LaunchBusiness): FlowProvider | null {
  const provider = String(business.whatsapp_provider || '').trim() || 'ycloud'
  return provider === 'ycloud' || provider === 'meta' ? provider : null
}

function providerFlowId(version: FlowVersionRecord): string {
  return typeof version.provider_flow_id === 'string'
    ? version.provider_flow_id.trim()
    : ''
}

export function createWhatsAppFlowLauncher(
  dependencies: LauncherDependencies,
) {
  const now = dependencies.now || Date.now

  return {
    async launchOrderFlow(input: LaunchOrderFlowInput): Promise<boolean> {
      const { business } = input
      const phone = String(input.phone || '').trim()
      const provider = providerFor(business)
      const source = input.source === 'ai' ? 'ai' : 'menu'
      if (!phone
        || !provider
        || business.takes_orders === false
        || business.active === false
        || business.bot_active === false
        || business.suspended === true) {
        return false
      }

      const version = await dependencies.getActiveFlowVersion(
        business.id,
        'order',
        provider,
      )
      const flowId = version ? providerFlowId(version) : ''
      if (!version
        || version.provider !== provider
        || version.status !== 'published'
        || !version.is_active
        || !flowId) {
        return false
      }

      const [products, modifiers] = await Promise.all([
        dependencies.getFlowCatalogProducts(business.id),
        dependencies.getFlowCatalogModifiers(business.id),
      ])
      if (!products.length
        || products.length > WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT
        || modifiers.length > WHATSAPP_FLOW_CATALOG_MODIFIER_LIMIT) {
        // Fallback transparente al chat. No se abre una sesión que solo podría
        // mostrar un catálogo vacío o incompleto.
        return false
      }

      const createdAt = now()
      const { flowToken, session } = await dependencies.createFlowSession({
        businessId: business.id,
        provider,
        flowVersionId: version.id,
        contact: phone,
        expiresAt: new Date(createdAt + FLOW_SESSION_TTL_MS),
        context: {
          capability: 'order',
          source,
          schema_version: 1,
        },
      })

      await dependencies.sendSessionFlow(
        business,
        phone,
        {
          flowId,
          flowToken,
          action: 'data_exchange',
          body: `Arma tu pedido de ${String(business.name || 'nuestro negocio').trim()} en un solo formulario.`,
          cta: 'Armar pedido',
        },
        'direct',
      )

      try {
        await dependencies.recordFlowMetric({
          businessId: business.id,
          provider,
          flowVersionId: version.id,
          sessionId: session.id,
          eventType: 'launch',
          sourceKey: session.id,
          metadata: { source },
        })
      } catch {
        // El mensaje ya fue aceptado: las métricas no deben repetir el envío.
      }
      return true
    },
  }
}

const db = require('../db') as LauncherDependencies
const whatsapp = require('../integrations/whatsapp') as Pick<
  LauncherDependencies,
  'sendSessionFlow'
>

export const whatsappFlowLauncher = createWhatsAppFlowLauncher({
  ...db,
  sendSessionFlow: whatsapp.sendSessionFlow,
})
