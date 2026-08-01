import type {
  FlowProvider,
  JsonObject,
  ResolvedFlowSession,
} from '../db/repositories/whatsapp-flows'
import type { InboundFlowResponse } from './inbound-webhook'
import {
  parseOrderFlowSubmission,
  type OrderFlowSubmission,
} from './whatsapp-flow-contracts'

type JsonRecord = Record<string, unknown>

interface RuntimeBusiness extends JsonRecord {
  id?: string
  name?: string | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
  takes_orders?: boolean | null
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
  lead_enabled?: boolean | null
}

interface RuntimeOrder extends JsonRecord {
  id?: string
  total?: number | string | null
  currency?: string | null
}

interface RuntimeDomainResource extends JsonRecord {
  id?: string
}

interface ConversationMessage {
  role?: string | null
  content?: string | null
}

interface MutationResult {
  error?: { message?: string } | null
}

interface RuntimeDependencies {
  getBusinessById(businessId: string): Promise<RuntimeBusiness | null>
  getFlowSessionByToken(
    provider: FlowProvider,
    flowToken: string,
  ): Promise<ResolvedFlowSession | null>
  recordFlowSubmission(input: {
    businessId: string
    provider: FlowProvider
    flowToken: string
    contact: string
    submissionKey: string
    payload: JsonObject
  }): Promise<JsonObject>
  completeFlowSubmission(input: {
    businessId: string
    submissionId: string
    status: 'processed' | 'rejected' | 'failed'
    orderId?: string | null
    errorCode?: string | null
  }): Promise<JsonObject | null>
  createOrderFromFlowSubmission(input: {
    businessId: string
    submissionId: string
    contactPhone: string
    contactName?: string | null
    items: Array<{
      productId: string
      quantity: number
      modifierIds?: string[]
      note?: string | null
    }>
    fulfillmentType: 'delivery' | 'pickup' | 'onsite'
    deliveryAddress?: string | null
    deliveryReference?: string | null
    paymentMethod?: string | null
    requestedFulfillmentAt?: string | null
    customerNotes?: string | null
    deliveryFee?: number
    currency?: string
  }): Promise<JsonObject>
  createBookingFromFlowSubmission(input: {
    businessId: string
    submissionId: string
    contactPhone: string
  }): Promise<JsonObject>
  createLodgingRequestFromFlowSubmission(input: {
    businessId: string
    submissionId: string
    contactPhone: string
  }): Promise<JsonObject>
  createLeadFromFlowSubmission(input: {
    businessId: string
    submissionId: string
    contactPhone: string
  }): Promise<JsonObject>
  getContactHistory(
    businessId: string,
    phone: string,
    limit?: number,
    sinceTimestamp?: string | null,
  ): Promise<ConversationMessage[]>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'user' | 'assistant' | 'owner',
    content: string,
  ): Promise<MutationResult | unknown>
  upsertSession?(
    businessId: string,
    phone: string,
    data: JsonRecord,
  ): Promise<unknown>
  recordFlowMetric(input: {
    businessId: string
    provider: FlowProvider
    flowVersionId: string
    sessionId?: string | null
    eventType: string
    sourceKey: string
    metadata?: JsonObject
  }): Promise<boolean>
  sendText(
    business: RuntimeBusiness,
    to: string,
    text: string,
  ): Promise<void>
}

const MAX_TOKEN_LENGTH = 512
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

type RuntimeCapability = 'order' | 'appointment' | 'lodging' | 'lead'

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function flowTokenFrom(response: JsonRecord): string | null {
  const token = text(response.flow_token)
  if (!token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return null
  }
  return token
}

function resumableSession(session: ResolvedFlowSession): boolean {
  return (
    session.status === 'open'
    && Date.parse(session.expires_at) > Date.now()
  ) || session.status === 'submitted'
}

function runtimeCapability(
  session: ResolvedFlowSession,
): RuntimeCapability | null {
  const capability = text(session.flow?.capability_key)
  return ['order', 'appointment', 'lodging', 'lead'].includes(capability)
    ? capability as RuntimeCapability
    : null
}

function hasCanonicalDraft(
  session: ResolvedFlowSession,
  capability: RuntimeCapability,
): boolean {
  if (!resumableSession(session)) return false
  const context = record(session.context)
  if (!context) return false
  if (capability === 'order') {
    return Boolean(record(context.order_draft))
  }
  if (capability === 'appointment') {
    const draft = record(context.appointment_draft)
    const serviceId = text(context.service_id)
    return Boolean(
      draft
      && text(draft.contact_name).length >= 2
      && (serviceId === 'general' || UUID_PATTERN.test(serviceId))
      && DATE_PATTERN.test(text(context.booking_date))
      && TIME_PATTERN.test(text(context.booking_time)),
    )
  }
  if (capability === 'lodging') {
    const draft = record(context.lodging_draft)
    return Boolean(
      draft
      && UUID_PATTERN.test(text(draft.quote_id))
      && UUID_PATTERN.test(text(draft.room_type_id))
      && text(draft.contact_name).length >= 2,
    )
  }
  const draft = record(context.lead_draft)
  return Boolean(
    draft
    && text(draft.contact_name).length >= 2
    && text(draft.topic_label)
    && text(draft.details).length >= 2,
  )
}

function capabilityEnabled(
  business: RuntimeBusiness,
  capability: RuntimeCapability,
): boolean {
  if (capability === 'order') return business.takes_orders === true
  if (capability === 'appointment') return business.takes_bookings === true
  if (capability === 'lodging') return business.lodging_enabled === true
  return business.lead_enabled !== false
}

function sessionOrderPayload(
  session: ResolvedFlowSession,
  flowToken: string,
): OrderFlowSubmission | null {
  // `record_whatsapp_flow_submission` cambia la sesión a `submitted` antes de
  // crear el pedido. Esa sesión debe seguir siendo reanudable por el inbox
  // durable si el proceso cae o el proveedor falla después de registrarla.
  if (!resumableSession(session)
    || session.flow?.capability_key !== 'order') {
    return null
  }
  const context = record(session.context)
  const draft = record(context?.order_draft)
  if (!draft) return null
  try {
    // El payload terminal del teléfono NO es la fuente de verdad. Se reconstruye
    // desde el borrador que data_exchange validó y guardó en el servidor.
    return parseOrderFlowSubmission({
      ...draft,
      flow_token: flowToken,
    })
  } catch {
    return null
  }
}

function submissionRecord(result: JsonObject): JsonRecord | null {
  return record(result.submission)
}

function customerNotes(submission: OrderFlowSubmission): string | null {
  const notes = [
    submission.requestedFor
      ? `Hora solicitada por el cliente: ${submission.requestedFor}`
      : '',
    submission.notes || '',
  ].filter(Boolean)
  return notes.length ? notes.join('\n') : null
}

function orderResult(value: JsonObject): {
  created: boolean
  order: RuntimeOrder | null
} {
  return {
    created: value.created === true,
    order: record(value.order) as RuntimeOrder | null,
  }
}

function money(value: unknown, currency: unknown): string {
  const amount = Number(value)
  const safeAmount = Number.isFinite(amount) ? amount : 0
  const code = text(currency) || 'USD'
  try {
    return new Intl.NumberFormat('es-EC', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
    }).format(safeAmount)
  } catch {
    return `$${safeAmount.toFixed(2)} ${code}`
  }
}

function fulfillmentLabel(value: OrderFlowSubmission['fulfillment']): string {
  if (value === 'delivery') return 'Entrega a domicilio'
  if (value === 'pickup') return 'Retiro en el local'
  return 'Consumo en el local'
}

function confirmationMessage(
  business: RuntimeBusiness,
  order: RuntimeOrder,
  submission: OrderFlowSubmission,
): string {
  const orderId = text(order.id)
  const shortId = orderId ? orderId.slice(0, 8).toUpperCase() : ''
  const lines = [
    '✅ *Pedido recibido*',
    shortId ? `Código: *${shortId}*` : '',
    `Negocio: *${text(business.name) || 'Nuestro negocio'}*`,
    `Productos: ${submission.items.reduce((sum, item) => sum + item.quantity, 0)}`,
    `Modalidad: ${fulfillmentLabel(submission.fulfillment)}`,
    submission.paymentMethod ? `Pago: ${submission.paymentMethod}` : '',
    `Total oficial: *${money(order.total, order.currency)}*`,
    '',
    'El negocio revisará el pedido y te confirmará por este chat.',
  ]
  return lines.filter((line, index) => line || index === lines.length - 2).join('\n')
}

function resourceId(
  result: JsonObject,
  key: 'booking' | 'request' | 'lead',
): { created: boolean; resource: RuntimeDomainResource | null } {
  return {
    created: result.created === true,
    resource: record(result[key]) as RuntimeDomainResource | null,
  }
}

function appointmentConfirmation(
  business: RuntimeBusiness,
  session: ResolvedFlowSession,
  booking: RuntimeDomainResource,
): string {
  const context = record(session.context)
  const id = text(booking.id)
  const service = text(booking.service)
    || text(context?.service_name)
    || 'Cita'
  const date = text(booking.booking_date) || text(context?.booking_date)
  const time = (text(booking.booking_time) || text(context?.booking_time)).slice(0, 5)
  return [
    '✅ *Solicitud de cita registrada*',
    id ? `Código: *${id.slice(0, 8).toUpperCase()}*` : '',
    `Negocio: *${text(business.name) || 'Nuestro negocio'}*`,
    `Servicio: ${service}`,
    `Fecha: ${date} a las ${time}`,
    '',
    'La cita está pendiente. El negocio te confirmará por este chat.',
  ].filter((line, index) => line || index === 5).join('\n')
}

function lodgingConfirmation(
  business: RuntimeBusiness,
  request: RuntimeDomainResource,
): string {
  const id = text(request.id)
  const total = request.total === undefined
    ? ''
    : money(request.total, request.currency)
  return [
    '✅ *Solicitud de hospedaje registrada*',
    id ? `Código: *${id.slice(0, 8).toUpperCase()}*` : '',
    `Alojamiento: *${text(business.name) || 'Nuestro negocio'}*`,
    `Opción: ${text(request.room_type_name) || 'Habitación seleccionada'}`,
    `Entrada: ${text(request.check_in)} · Salida: ${text(request.check_out)}`,
    total ? `Total oficial: *${total}*` : '',
    '',
    'La solicitud está pendiente. El equipo revisará y confirmará la estadía por este chat.',
  ].filter((line, index) => line || index === 6).join('\n')
}

function leadConfirmation(
  business: RuntimeBusiness,
  session: ResolvedFlowSession,
  lead: RuntimeDomainResource,
): string {
  const draft = record(record(session.context)?.lead_draft)
  const id = text(lead.id)
  return [
    '✅ *Solicitud recibida*',
    id ? `Código: *${id.slice(0, 8).toUpperCase()}*` : '',
    `Negocio: *${text(business.name) || 'Nuestro negocio'}*`,
    `Tema: ${text(lead.topic) || text(draft?.topic_label) || 'Información'}`,
    '',
    'El equipo revisará tu mensaje y continuará contigo por este chat.',
  ].filter((line, index) => line || index === 4).join('\n')
}

function domainRejection(
  capability: Exclude<RuntimeCapability, 'order'>,
  result: string,
): { code: string; message: string } {
  if (capability === 'appointment') {
    return {
      code: result === 'service_changed' ? 'service_changed' : 'slot_unavailable',
      message: result === 'service_changed'
        ? '⚠️ Ese servicio cambió mientras completabas el formulario. Vuelve al menú y solicita la cita nuevamente.'
        : '⚠️ Ese horario acaba de ocuparse. Vuelve al menú y elige una hora disponible.',
    }
  }
  if (capability === 'lodging') {
    const expired = ['quote_expired', 'expired', 'quote_not_found'].includes(result)
    return {
      code: expired ? 'lodging_quote_expired' : 'lodging_unavailable',
      message: expired
        ? '⚠️ La cotización venció antes de completar la solicitud. Vuelve a consultar las fechas para obtener disponibilidad y precio actuales.'
        : '⚠️ La habitación elegida ya no está disponible para todo el periodo. Vuelve a cotizar o habla con el equipo.',
    }
  }
  return {
    code: 'lead_invalid',
    message: '⚠️ No pudimos registrar la solicitud. Vuelve al chat e inténtalo nuevamente.',
  }
}

async function confirmationWasSaved(
  dependencies: RuntimeDependencies,
  businessId: string,
  phone: string,
  orderId: string,
): Promise<boolean> {
  const marker = orderId.slice(0, 8).toUpperCase()
  if (!marker) return false
  try {
    const history = await dependencies.getContactHistory(
      businessId,
      phone,
      50,
      null,
    )
    return history.some(message => (
      message.role === 'assistant'
      && text(message.content).includes(`Código: *${marker}*`)
    ))
  } catch {
    // El historial ayuda a evitar una confirmación repetida durante un retry,
    // pero una caída temporal de lectura no invalida el pedido ya creado.
    return false
  }
}

async function bestEffortMetric(
  dependencies: RuntimeDependencies,
  input: InboundFlowResponse,
  session: ResolvedFlowSession,
  eventType: string,
  metadata: JsonObject,
): Promise<void> {
  try {
    await dependencies.recordFlowMetric({
      businessId: input.businessId,
      provider: input.provider,
      flowVersionId: session.flow_version_id,
      sessionId: session.id,
      eventType,
      sourceKey: `${input.inboundId}:${eventType}`,
      metadata,
    })
  } catch {
    // Métricas nunca deben provocar otro pedido ni otra respuesta al cliente.
  }
}

async function processDomainSubmission(
  dependencies: RuntimeDependencies,
  input: InboundFlowResponse,
  session: ResolvedFlowSession,
  business: RuntimeBusiness,
  submissionId: string,
  capability: Exclude<RuntimeCapability, 'order'>,
): Promise<void> {
  let result: JsonObject
  let key: 'booking' | 'request' | 'lead'
  if (capability === 'appointment') {
    key = 'booking'
    result = await dependencies.createBookingFromFlowSubmission({
      businessId: input.businessId,
      submissionId,
      contactPhone: input.from,
    })
  } else if (capability === 'lodging') {
    key = 'request'
    result = await dependencies.createLodgingRequestFromFlowSubmission({
      businessId: input.businessId,
      submissionId,
      contactPhone: input.from,
    })
  } else {
    key = 'lead'
    result = await dependencies.createLeadFromFlowSubmission({
      businessId: input.businessId,
      submissionId,
      contactPhone: input.from,
    })
  }

  const outcome = text(result.result)
  const successful = ['created', 'duplicate'].includes(outcome)
  if (!successful) {
    const rejection = domainRejection(capability, outcome)
    await dependencies.sendText(business, input.from, rejection.message)
    try {
      await dependencies.saveMessage(
        input.businessId,
        input.from,
        'assistant',
        rejection.message,
      )
    } catch {
      // El aviso ya fue aceptado por WhatsApp.
    }
    await dependencies.completeFlowSubmission({
      businessId: input.businessId,
      submissionId,
      status: 'rejected',
      errorCode: rejection.code,
    })
    await bestEffortMetric(
      dependencies,
      input,
      session,
      'submission_rejected',
      { capability, reason: rejection.code },
    )
    return
  }

  const domain = resourceId(result, key)
  const id = text(domain.resource?.id)
  if (!domain.resource || !id) {
    throw new Error(`La base no devolvió el recurso ${capability} creado por el Flow`)
  }

  const alreadyConfirmed = !domain.created && await confirmationWasSaved(
    dependencies,
    input.businessId,
    input.from,
    id,
  )
  if (!alreadyConfirmed) {
    if (capability === 'lead' && domain.created) {
      const draft = record(record(session.context)?.lead_draft)
      const ownerSummary = [
        `📝 Nueva solicitud ${id.slice(0, 8).toUpperCase()}`,
        `Nombre: ${text(draft?.contact_name)}`,
        `Tema: ${text(draft?.topic_label)}`,
        `Detalle: ${text(draft?.details)}`,
        text(draft?.email) ? `Correo: ${text(draft?.email)}` : '',
        text(draft?.preferred_time)
          ? `Horario preferido: ${text(draft?.preferred_time)}`
          : '',
      ].filter(Boolean).join('\n')
      try {
        await dependencies.saveMessage(
          input.businessId,
          input.from,
          'user',
          ownerSummary,
        )
      } catch {
        // La solicitud estructurada ya quedó guardada en PostgreSQL.
      }
    }

    const message = capability === 'appointment'
      ? appointmentConfirmation(business, session, domain.resource)
      : capability === 'lodging'
        ? lodgingConfirmation(business, domain.resource)
        : leadConfirmation(business, session, domain.resource)
    await dependencies.sendText(business, input.from, message)
    try {
      await dependencies.saveMessage(
        input.businessId,
        input.from,
        'assistant',
        message,
      )
    } catch {
      // El proveedor ya aceptó el mensaje.
    }
  }

  if (domain.created && dependencies.upsertSession) {
    try {
      const sessionUpdate: JsonObject = {
        unread_owner: true,
        last_message: capability === 'lead'
          ? 'Nueva solicitud recibida mediante WhatsApp Flow'
          : `Nueva solicitud de ${capability === 'lodging' ? 'hospedaje' : 'cita'}`,
        last_message_at: new Date().toISOString(),
      }
      // Un lead sí requiere atención humana. Citas y hospedaje no deben
      // escribir `false`: el dueño pudo haber tomado manualmente el chat
      // mientras el cliente completaba un Flow que ya estaba abierto.
      if (capability === 'lead') sessionUpdate.manual_mode = true
      await dependencies.upsertSession(
        input.businessId,
        input.from,
        sessionUpdate,
      )
    } catch {
      // La entidad y su confirmación no dependen del badge del panel.
    }
  }

  await bestEffortMetric(
    dependencies,
    input,
    session,
    `${capability}_created`,
    { created: domain.created, resource_id: id },
  )
}

function knownBusinessRuleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /producto|cantidad|agotado|modificador|pedido|entrega|fulfillment|catálogo/i
    .test(error.message)
}

export function createWhatsAppFlowResponseProcessor(
  dependencies: RuntimeDependencies,
) {
  return {
    async handleResponse(input: InboundFlowResponse): Promise<void> {
      const flowToken = flowTokenFrom(input.response)
      if (!flowToken) return

      const session = await dependencies.getFlowSessionByToken(
        input.provider,
        flowToken,
      )
      if (!session
        || session.business_id !== input.businessId
        || session.provider !== input.provider) {
        return
      }
      const capability = runtimeCapability(session)
      if (!capability || !hasCanonicalDraft(session, capability)) return
      const orderSubmission = capability === 'order'
        ? sessionOrderPayload(session, flowToken)
        : null
      if (capability === 'order' && !orderSubmission) return

      const business = await dependencies.getBusinessById(input.businessId)
      if (!business
        || business.id !== input.businessId
        || business.active === false
        || business.bot_active === false
        || business.suspended === true
        || !capabilityEnabled(business, capability)) {
        return
      }

      const recorded = await dependencies.recordFlowSubmission({
        businessId: input.businessId,
        provider: input.provider,
        flowToken,
        contact: input.from,
        submissionKey: input.inboundId,
        payload: input.response,
      })
      const submission = submissionRecord(recorded)
      if (!submission) return
      const submissionId = text(submission.id)
      if (!submissionId) return
      if (submission.processing_status === 'rejected'
        || submission.processing_status === 'failed') {
        return
      }

      if (capability !== 'order') {
        await processDomainSubmission(
          dependencies,
          input,
          session,
          business,
          submissionId,
          capability,
        )
        return
      }
      if (!orderSubmission) return

      let result: { created: boolean; order: RuntimeOrder | null }
      try {
        result = orderResult(await dependencies.createOrderFromFlowSubmission({
          businessId: input.businessId,
          submissionId,
          contactPhone: input.from,
          contactName: orderSubmission.contactName,
          items: orderSubmission.items,
          fulfillmentType: orderSubmission.fulfillment,
          deliveryAddress: orderSubmission.address,
          deliveryReference: orderSubmission.addressReference,
          paymentMethod: orderSubmission.paymentMethod,
          // El campo actual es texto libre. Se conserva como nota hasta que una
          // versión futura use DatePicker/TimePicker y produzca un ISO confiable.
          requestedFulfillmentAt: null,
          customerNotes: customerNotes(orderSubmission),
          deliveryFee: 0,
          currency: 'USD',
        }))
      } catch (error) {
        if (!knownBusinessRuleError(error)) throw error
        const message = '⚠️ No pudimos confirmar el pedido porque un producto u opción cambió. Vuelve al menú y arma el pedido nuevamente.'
        await dependencies.sendText(business, input.from, message)
        try {
          await dependencies.saveMessage(
            input.businessId,
            input.from,
            'assistant',
            message,
          )
        } catch {
          // El proveedor ya aceptó el aviso; el estado del submission evita
          // repetirlo aunque el historial esté temporalmente indisponible.
        }
        // Solo cerrar después de que el proveedor aceptó el aviso. Si falla el
        // envío, el inbox durable reintentará y el cliente no quedará sin saber
        // que debe reconstruir el pedido.
        await dependencies.completeFlowSubmission({
          businessId: input.businessId,
          submissionId,
          status: 'rejected',
          errorCode: 'catalog_changed',
        })
        await bestEffortMetric(
          dependencies,
          input,
          session,
          'submission_rejected',
          { reason: 'catalog_changed' },
        )
        return
      }

      const order = result.order
      const orderId = text(order?.id)
      if (!order || !orderId) {
        throw new Error('La base no devolvió el pedido creado por el Flow')
      }

      const alreadyConfirmed = !result.created && await confirmationWasSaved(
        dependencies,
        input.businessId,
        input.from,
        orderId,
      )
      if (!alreadyConfirmed) {
        const message = confirmationMessage(business, order, orderSubmission)
        // Si el proveedor falla, el inbox durable reintenta. La creación
        // atómica devolverá el mismo pedido y no duplicará dinero ni stock.
        await dependencies.sendText(business, input.from, message)
        try {
          await dependencies.saveMessage(
            input.businessId,
            input.from,
            'assistant',
            message,
          )
        } catch {
          // El mensaje ya fue aceptado por el proveedor: no relanzar el webhook.
        }
      }

      await bestEffortMetric(
        dependencies,
        input,
        session,
        'order_created',
        { created: result.created, order_id: orderId },
      )
    },
  }
}

const db = require('../db') as RuntimeDependencies
const whatsapp = require('../integrations/whatsapp') as {
  sendText(
    business: RuntimeBusiness,
    to: string,
    text: string,
  ): Promise<void>
}

export const whatsappFlowResponseProcessor =
  createWhatsAppFlowResponseProcessor({
    ...db,
    sendText: whatsapp.sendText,
  })
