import type { SupabaseClient } from '@supabase/supabase-js'
import type { FlowProvider, JsonObject } from './whatsapp-flows'

const db = require('../client') as SupabaseClient

export type FulfillmentType = 'delivery' | 'pickup' | 'onsite'

export interface SetOrderFulfillmentInput {
  businessId: string
  orderId: string
  fulfillmentType: FulfillmentType
  deliveryAddress?: string | null
  deliveryReference?: string | null
  paymentMethod?: string | null
  requestedFulfillmentAt?: string | null
  customerNotes?: string | null
  deliveryFee?: number
}

export interface DispatchRecipientInput {
  id?: string
  businessId: string
  recipientKey: string
  displayName: string
  provider: FlowProvider
  phoneE164: string
  priority?: number
  active?: boolean
}

export interface DispatchRecipientRecord extends JsonObject {
  id: string
  business_id: string
  recipient_key: string
  display_name: string
  provider: FlowProvider
  phone_e164: string
  priority: number
  active: boolean
}

export interface DispatchRecord extends JsonObject {
  id: string
  business_id: string
  order_id: string
  recipient_id?: string | null
  provider?: FlowProvider | null
  event_type: string
  status: 'held' | 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled'
  payload: JsonObject
}

export type HeldDispatchRecord = DispatchRecord & { status: 'held' }

interface DbError {
  message: string
}

interface DbResponse<T> {
  data: T | null
  error: DbError | null
}

function unwrap<T>(response: DbResponse<T>, operation: string): T {
  if (response.error) {
    throw new Error(`${operation}: ${response.error.message}`)
  }
  if (response.data === null) {
    throw new Error(`${operation}: la base no devolvió datos`)
  }
  return response.data
}

export function createDeliveryDispatchRepository(client: SupabaseClient) {
  const setOrderFulfillment = async (
    input: SetOrderFulfillmentInput,
  ): Promise<JsonObject> => {
    const response = await client.rpc('set_order_fulfillment', {
      p_business_id: input.businessId,
      p_order_id: input.orderId,
      p_fulfillment_type: input.fulfillmentType,
      p_delivery_address: input.deliveryAddress || null,
      p_delivery_reference: input.deliveryReference || null,
      p_payment_method: input.paymentMethod || null,
      p_requested_fulfillment_at: input.requestedFulfillmentAt || null,
      p_customer_notes: input.customerNotes || null,
      p_delivery_fee: input.deliveryFee || 0,
    })
    return unwrap(
      response as DbResponse<JsonObject>,
      'No se pudo guardar el método de entrega',
    )
  }

  const upsertDispatchRecipient = async (
    input: DispatchRecipientInput,
  ): Promise<DispatchRecipientRecord> => {
    const payload = {
      ...(input.id ? { id: input.id } : {}),
      business_id: input.businessId,
      recipient_key: input.recipientKey.trim(),
      display_name: input.displayName.trim(),
      provider: input.provider,
      phone_e164: input.phoneE164.replace(/\D/g, ''),
      priority: input.priority ?? 100,
      active: input.active ?? true,
      updated_at: new Date().toISOString(),
    }
    const response = await client
      .from('delivery_dispatch_recipients')
      .upsert(payload, { onConflict: 'business_id,recipient_key' })
      .select('*')
      .single()
    return unwrap(
      response as DbResponse<DispatchRecipientRecord>,
      'No se pudo guardar el destinatario del despacho',
    )
  }

  const listDispatchRecipients = async (
    businessId: string,
  ): Promise<DispatchRecipientRecord[]> => {
    const response = await client
      .from('delivery_dispatch_recipients')
      .select('*')
      .eq('business_id', businessId)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
    if (response.error) {
      throw new Error(`No se pudieron listar los destinatarios: ${response.error.message}`)
    }
    return (response.data || []) as DispatchRecipientRecord[]
  }

  const ensureHeldOrderDispatch = async (
    businessId: string,
    orderId: string,
  ): Promise<JsonObject> => {
    const response = await client.rpc('ensure_order_delivery_dispatch', {
      p_business_id: businessId,
      p_order_id: orderId,
    })
    return unwrap(
      response as DbResponse<JsonObject>,
      'No se pudo guardar el despacho',
    )
  }

  const assignDispatchRecipient = async (
    businessId: string,
    dispatchId: string,
    recipientId: string,
  ): Promise<HeldDispatchRecord | null> => {
    const response = await client.rpc(
      'assign_delivery_dispatch_recipient',
      {
        p_business_id: businessId,
        p_dispatch_id: dispatchId,
        p_recipient_id: recipientId,
      },
    )
    if (response.error) {
      throw new Error(`No se pudo asignar el despacho: ${response.error.message}`)
    }
    return response.data as HeldDispatchRecord | null
  }

  const listHeldDispatches = async (
    businessId: string,
    limit = 100,
  ): Promise<HeldDispatchRecord[]> => {
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const response = await client
      .from('delivery_dispatch_outbox')
      .select(
        '*,orders(id,contact_name,total,currency,fulfillment_type,delivery_address,delivery_reference,payment_method,requested_fulfillment_at,customer_notes,delivery_fee),delivery_dispatch_recipients(id,display_name,provider,phone_e164)',
      )
      .eq('business_id', businessId)
      .eq('status', 'held')
      .order('created_at', { ascending: true })
      .limit(safeLimit)
    if (response.error) {
      throw new Error(`No se pudieron listar los despachos: ${response.error.message}`)
    }
    return (response.data || []) as HeldDispatchRecord[]
  }

  const cancelHeldDispatch = async (
    businessId: string,
    dispatchId: string,
  ): Promise<DispatchRecord | null> => {
    const response = await client.rpc(
      'cancel_held_delivery_dispatch',
      {
        p_business_id: businessId,
        p_dispatch_id: dispatchId,
      },
    )
    if (response.error) {
      throw new Error(`No se pudo cancelar el despacho: ${response.error.message}`)
    }
    return response.data as DispatchRecord | null
  }

  return {
    setOrderFulfillment,
    upsertDispatchRecipient,
    listDispatchRecipients,
    ensureHeldOrderDispatch,
    assignDispatchRecipient,
    listHeldDispatches,
    cancelHeldDispatch,
  }
}

const repository = createDeliveryDispatchRepository(db)

export const setOrderFulfillment = repository.setOrderFulfillment
export const upsertDispatchRecipient = repository.upsertDispatchRecipient
export const listDispatchRecipients = repository.listDispatchRecipients
export const ensureHeldOrderDispatch = repository.ensureHeldOrderDispatch
export const assignDispatchRecipient = repository.assignDispatchRecipient
export const listHeldDispatches = repository.listHeldDispatches
export const cancelHeldDispatch = repository.cancelHeldDispatch
