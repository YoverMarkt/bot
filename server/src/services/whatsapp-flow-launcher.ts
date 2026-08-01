import {
  WHATSAPP_FLOW_APPOINTMENT_SERVICE_LIMIT,
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
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
  lead_enabled?: boolean | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
}

interface LauncherDependencies {
  getFlowCatalogProducts(businessId: string): Promise<unknown[]>
  getFlowCatalogModifiers(businessId: string): Promise<unknown[]>
  getFlowAppointmentServices?(businessId: string): Promise<unknown[]>
  getSchedule?(businessId: string): Promise<Array<{
    is_active?: boolean | null
  }>>
  getFlowAppointmentAvailability?(input: {
    businessId: string
    serviceId: string | null
    durationMinutes: number | null
    daysAhead: number
  }): Promise<Array<{
    booking_date?: string | null
    booking_time?: string | null
  }>>
  getLodgingRoomTypes?(
    businessId: string,
    includeInactive?: boolean,
  ): Promise<Array<{
    id?: string
    name?: string | null
    active?: boolean | null
    pricing_model?: string | null
    base_rate?: number | string | null
    base_occupancy?: number | string | null
    max_guests?: number | string | null
  }>>
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

export interface LaunchCapabilityFlowInput extends LaunchOrderFlowInput {
  preferredRoomTypeId?: string | null
}

const FLOW_SESSION_TTL_MS = 30 * 60 * 1000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN =
  /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,6})?)?$/
const AUTOMATIC_PRICING_MODELS = new Set([
  'per_unit',
  'per_person',
  'base_plus_extra',
])

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function normalizedCategory(value: unknown): string {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function operationalOrderProducts(products: unknown[]): JsonObject[] {
  return [...new Map(products.flatMap(value => {
    const product = record(value)
    const id = String(product.id || '').trim()
    const name = String(product.name || '').trim()
    const price = Number(product.price_sale ?? product.price)
    if (!UUID_PATTERN.test(id)
      || !name
      || !Number.isFinite(price)
      || price <= 0
      || product.active === false
      || product.stock === 'agotado') {
      return []
    }
    return [[id, product] as const]
  })).values()]
}

function orderCategoriesFitFlow(products: JsonObject[]): boolean {
  const categories = new Set<string>()
  let hasUntagged = false
  for (const product of products) {
    const tags = Array.isArray(product.tags) ? product.tags : []
    let hasValidTag = false
    for (const tag of tags) {
      const normalized = normalizedCategory(tag)
      if (!normalized) continue
      categories.add(normalized)
      hasValidTag = true
    }
    if (!hasValidTag) hasUntagged = true
  }
  if (!categories.size) return true
  return categories.size + (hasUntagged ? 1 : 0)
    <= WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT
}

function validAvailabilityDate(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = value.trim().match(DATE_PATTERN)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function validAvailabilityTime(value: unknown): boolean {
  return typeof value === 'string' && TIME_PATTERN.test(value.trim())
}

function operationalAutomaticRoom(room: {
  id?: string
  name?: string | null
  active?: boolean | null
  pricing_model?: string | null
  base_rate?: number | string | null
  base_occupancy?: number | string | null
  max_guests?: number | string | null
}): boolean {
  const baseRate = Number(room.base_rate)
  const baseOccupancy = Number(room.base_occupancy)
  const maxGuests = Number(room.max_guests)
  return room.active === true
    && UUID_PATTERN.test(String(room.id || '').trim())
    && Boolean(String(room.name || '').trim())
    && AUTOMATIC_PRICING_MODELS.has(String(room.pricing_model || ''))
    && Number.isFinite(baseRate)
    && baseRate > 0
    && Number.isInteger(baseOccupancy)
    && baseOccupancy >= 1
    && Number.isInteger(maxGuests)
    && maxGuests >= baseOccupancy
}

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
        || business.takes_orders !== true
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
      const operationalProducts = operationalOrderProducts(products)
      if (!operationalProducts.length
        || products.length > WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT
        || modifiers.length > WHATSAPP_FLOW_CATALOG_MODIFIER_LIMIT
        || !orderCategoriesFitFlow(operationalProducts)) {
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

    async launchAppointmentFlow(
      input: LaunchCapabilityFlowInput,
    ): Promise<boolean> {
      const { business } = input
      const phone = String(input.phone || '').trim()
      const provider = providerFor(business)
      const source = input.source === 'ai' ? 'ai' : 'menu'
      if (!phone
        || !provider
        || business.takes_bookings !== true
        || business.active === false
        || business.bot_active === false
        || business.suspended === true
        || !dependencies.getFlowAppointmentServices
        || !dependencies.getSchedule
        || !dependencies.getFlowAppointmentAvailability) {
        return false
      }
      const schedule = await dependencies.getSchedule(business.id)
      if (!schedule.some(day => day.is_active === true)) return false
      const [services, availability] = await Promise.all([
        dependencies.getFlowAppointmentServices(business.id),
        dependencies.getFlowAppointmentAvailability({
          businessId: business.id,
          serviceId: null,
          durationMinutes: null,
          daysAhead: 30,
        }),
      ])
      if (services.length > WHATSAPP_FLOW_APPOINTMENT_SERVICE_LIMIT) {
        return false
      }
      if (!availability.some(slot => (
        validAvailabilityDate(slot.booking_date)
        && validAvailabilityTime(slot.booking_time)
      ))) {
        // No enviar un formulario que ya sabemos que terminará sin horarios.
        // El recorrido conversacional conserva así su fallback normal.
        return false
      }

      const version = await dependencies.getActiveFlowVersion(
        business.id,
        'appointment',
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

      const createdAt = now()
      const { flowToken, session } = await dependencies.createFlowSession({
        businessId: business.id,
        provider,
        flowVersionId: version.id,
        contact: phone,
        expiresAt: new Date(createdAt + FLOW_SESSION_TTL_MS),
        context: {
          capability: 'appointment',
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
          body: `Elige un servicio y un horario disponible de ${String(business.name || 'nuestro negocio').trim()}.`,
          cta: 'Solicitar cita',
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
          metadata: { source, capability: 'appointment' },
        })
      } catch {
        // El formulario ya fue enviado.
      }
      return true
    },

    async launchLodgingFlow(
      input: LaunchCapabilityFlowInput,
    ): Promise<boolean> {
      const { business } = input
      const phone = String(input.phone || '').trim()
      const provider = providerFor(business)
      const source = input.source === 'ai' ? 'ai' : 'menu'
      if (!phone
        || !provider
        || business.lodging_enabled !== true
        || business.active === false
        || business.bot_active === false
        || business.suspended === true
        || !dependencies.getLodgingRoomTypes) {
        return false
      }
      const roomTypes = await dependencies.getLodgingRoomTypes(
        business.id,
        false,
      )
      const automaticRooms = roomTypes.filter(operationalAutomaticRoom)
      if (!automaticRooms.length) {
        return false
      }

      const preferredRoomTypeId = String(
        input.preferredRoomTypeId || '',
      ).trim()
      const selectedRoom = preferredRoomTypeId
        ? roomTypes.find(room => room.id === preferredRoomTypeId)
        : null
      if (preferredRoomTypeId
        && (!selectedRoom
          || !operationalAutomaticRoom(selectedRoom))) {
        // El cliente ya eligió esta habitación. Si requiere precio manual, no
        // debemos sustituirla silenciosamente por otra dentro del Flow.
        return false
      }

      const version = await dependencies.getActiveFlowVersion(
        business.id,
        'lodging',
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

      const createdAt = now()
      const { flowToken, session } = await dependencies.createFlowSession({
        businessId: business.id,
        provider,
        flowVersionId: version.id,
        contact: phone,
        expiresAt: new Date(createdAt + FLOW_SESSION_TTL_MS),
        context: {
          capability: 'lodging',
          source,
          schema_version: 1,
          ...(selectedRoom?.id
            ? { preferred_room_type_id: selectedRoom.id }
            : {}),
        },
      })
      await dependencies.sendSessionFlow(
        business,
        phone,
        {
          flowId,
          flowToken,
          action: 'data_exchange',
          body: `Consulta fechas, disponibilidad y precio oficial de ${String(business.name || 'nuestro alojamiento').trim()}.`,
          cta: 'Cotizar estadía',
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
          metadata: { source, capability: 'lodging' },
        })
      } catch {
        // El formulario ya fue enviado.
      }
      return true
    },

    async launchLeadFlow(
      input: LaunchCapabilityFlowInput,
    ): Promise<boolean> {
      const { business } = input
      const phone = String(input.phone || '').trim()
      const provider = providerFor(business)
      const source = input.source === 'ai' ? 'ai' : 'menu'
      if (!phone
        || !provider
        || business.lead_enabled === false
        || business.active === false
        || business.bot_active === false
        || business.suspended === true) {
        return false
      }

      const version = await dependencies.getActiveFlowVersion(
        business.id,
        'lead',
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

      const createdAt = now()
      const { flowToken, session } = await dependencies.createFlowSession({
        businessId: business.id,
        provider,
        flowVersionId: version.id,
        contact: phone,
        expiresAt: new Date(createdAt + FLOW_SESSION_TTL_MS),
        context: {
          capability: 'lead',
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
          body: `Déjanos tu solicitud para que el equipo de ${String(business.name || 'nuestro negocio').trim()} pueda ayudarte.`,
          cta: 'Enviar solicitud',
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
          metadata: { source, capability: 'lead' },
        })
      } catch {
        // El formulario ya fue enviado.
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
