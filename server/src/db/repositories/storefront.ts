import type { SupabaseClient } from '@supabase/supabase-js'

// Datos de la mini app: clientes, sus direcciones y las sesiones del enlace.
// Todo filtra por business_id salvo `customers`, que es identidad global (una
// persona, un teléfono) y a la que solo se llega por teléfono, nunca listando.

const db = require('../client') as SupabaseClient

const fail = (error: { message?: string } | null, context: string): void => {
  if (error) throw new Error(`${context}: ${error.message || 'sin detalle'}`)
}

// ── Clientes ────────────────────────────────────────────────────────────────

/**
 * El teléfono ES la identidad del cliente. Se resuelve o se crea, y de paso se
 * asegura su relación con el negocio: el negocio solo verá esa relación, nunca
 * que la persona también compra en otro sitio.
 */
const resolveCustomer = async (input: {
  businessId: string
  phone: string
  name?: string | null
}) => {
  const phone = String(input.phone || '').replace(/\D/g, '')
  if (!phone) throw new Error('El teléfono del cliente es obligatorio')

  const existing = await db
    .from('customers')
    .select('id,phone,name')
    .eq('phone', phone)
    .maybeSingle()
  fail(existing.error, 'No se pudo buscar el cliente')

  let customer = existing.data as { id: string; phone: string; name: string | null } | null
  if (!customer) {
    const created = await db
      .from('customers')
      .insert({ phone, name: input.name || null })
      .select('id,phone,name')
      .single()
    fail(created.error, 'No se pudo crear el cliente')
    customer = created.data as { id: string; phone: string; name: string | null }
  } else if (input.name && !customer.name) {
    // Solo se completa lo que falta: nunca se pisa un nombre ya guardado.
    await db.from('customers').update({ name: input.name }).eq('id', customer.id)
  }

  const link = await db
    .from('business_customers')
    .upsert(
      {
        business_id: input.businessId,
        customer_id: customer.id,
        display_name: input.name || null,
      },
      { onConflict: 'business_id,customer_id', ignoreDuplicates: true },
    )
  fail(link.error, 'No se pudo vincular el cliente con el negocio')
  return customer
}

const getBusinessCustomer = async (businessId: string, customerId: string) => {
  const { data, error } = await db
    .from('business_customers')
    .select('display_name,total_orders,total_spent,last_order_at,marketing_consent')
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .maybeSingle()
  fail(error, 'No se pudo leer el cliente del negocio')
  return data
}

// ── Direcciones ─────────────────────────────────────────────────────────────
// Guardadas por negocio a propósito: que un local vea a dónde pidió ese cliente
// en otro sería filtrar datos entre negocios.

const getCustomerAddresses = async (businessId: string, customerId: string) => {
  const { data, error } = await db
    .from('customer_addresses')
    .select('id,label,address,reference,latitude,longitude,is_default')
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .eq('active', true)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
  fail(error, 'No se pudieron leer las direcciones')
  return data || []
}

const createCustomerAddress = async (input: {
  businessId: string
  customerId: string
  label?: string
  address: string
  reference?: string | null
  latitude?: number | null
  longitude?: number | null
  isDefault?: boolean
}) => {
  const { data, error } = await db
    .from('customer_addresses')
    .insert({
      business_id: input.businessId,
      customer_id: input.customerId,
      label: input.label || 'Casa',
      address: input.address,
      reference: input.reference || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      is_default: Boolean(input.isDefault),
    })
    .select('id,label,address,reference,is_default')
    .single()
  fail(error, 'No se pudo guardar la dirección')
  return data
}

// ── Sesiones del enlace ─────────────────────────────────────────────────────

const createStorefrontSession = async (input: {
  businessId: string
  customerId: string
  tokenHash: string
  contactPhone: string
  expiresAt: string
}) => {
  const { data, error } = await db
    .from('storefront_sessions')
    .insert({
      business_id: input.businessId,
      customer_id: input.customerId,
      token_hash: input.tokenHash,
      contact_phone: String(input.contactPhone || '').replace(/\D/g, ''),
      expires_at: input.expiresAt,
    })
    .select('id,expires_at')
    .single()
  fail(error, 'No se pudo crear la sesión de la tienda')
  return data
}

/** Se busca SIEMPRE por hash: el token en claro no vive en la base. */
const getStorefrontSessionByHash = async (tokenHash: string) => {
  const { data, error } = await db
    .from('storefront_sessions')
    .select('id,business_id,customer_id,contact_phone,device_hash,claimed_at,expires_at,revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  fail(error, 'No se pudo leer la sesión')
  return data
}

/**
 * Ata la sesión al primer dispositivo que la abre. La condición
 * `is('device_hash', null)` hace la operación atómica: si dos dispositivos
 * abren el mismo enlace a la vez, solo uno se la queda.
 */
const claimStorefrontSession = async (sessionId: string, deviceHash: string) => {
  const { data, error } = await db
    .from('storefront_sessions')
    .update({ device_hash: deviceHash, claimed_at: new Date().toISOString() })
    .eq('id', sessionId)
    .is('device_hash', null)
    .select('id')
  fail(error, 'No se pudo reclamar la sesión')
  return (data || []).length === 1
}

const touchStorefrontSession = async (sessionId: string) => {
  await db
    .from('storefront_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', sessionId)
}

/** Al pedir un enlace nuevo, los anteriores de ese cliente dejan de servir. */
const revokeStorefrontSessions = async (businessId: string, customerId: string) => {
  const { error } = await db
    .from('storefront_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .is('revoked_at', null)
  fail(error, 'No se pudieron revocar las sesiones anteriores')
}

const cleanupStorefrontSessions = async (days = 2) => db.rpc(
  'cleanup_storefront_sessions',
  { p_days: days },
)

// El pedido de la tienda: la RPC resuelve cada precio desde la base. Aquí solo
// se traducen los nombres de los parámetros.
const createStorefrontOrder = async (input: {
  businessId: string
  customerId: string | null
  contactPhone: string
  contactName?: string | null
  addressId?: string | null
  fulfillment?: string | null
  items: unknown[]
}) => db.rpc('create_storefront_order', {
  p_business_id: input.businessId,
  p_customer_id: input.customerId,
  p_contact_phone: input.contactPhone,
  p_contact_name: input.contactName || null,
  p_address_id: input.addressId || null,
  p_fulfillment: input.fulfillment || null,
  p_items: input.items,
})

export = {
  resolveCustomer,
  getBusinessCustomer,
  getCustomerAddresses,
  createCustomerAddress,
  createStorefrontSession,
  getStorefrontSessionByHash,
  claimStorefrontSession,
  touchStorefrontSession,
  revokeStorefrontSessions,
  cleanupStorefrontSessions,
  createStorefrontOrder,
}
