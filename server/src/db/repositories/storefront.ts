import type { SupabaseClient } from '@supabase/supabase-js'

// Datos de la mini app: clientes, sus direcciones y las sesiones del enlace.
// Todo filtra por business_id salvo `customers`, que es identidad global (una
// persona, un teléfono) y a la que solo se llega por teléfono, nunca listando.

const db: SupabaseClient = require('../client') as typeof import('../client')

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

/**
 * Guarda el nombre con el que este cliente pide EN ESTE negocio.
 *
 * ⚠️ Existe porque `ensureCustomer` no podía hacerlo: hace un `upsert` con
 * `ignoreDuplicates`, y la fila ya suele existir —la crea el bot al mandar el
 * enlace, sin nombre—, así que no escribía nada. Y aunque no existiera, en ese
 * momento el nombre todavía es nulo: se escribe después, en el checkout.
 * Resultado: 25 pedidos del mismo cliente y `display_name` en nulo, teniendo
 * la mini app la precarga ya construida y sin nada que precargar.
 *
 * Se llama al CREAR el pedido, que es cuando el nombre existe de verdad.
 */
const setCustomerDisplayName = async (
  businessId: string,
  customerId: string,
  name: string,
) => {
  const { error } = await db
    .from('business_customers')
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
  // No se usa `fail`: que no se pueda recordar el nombre jamás puede tumbar un
  // pedido que la base ya aceptó. Quien llama decide, y hoy lo ignora.
  return { error: error || null }
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

/** Todo lo que la mini app y el repartidor necesitan de una dirección. */
const CAMPOS_DE_LA_DIRECCION =
  'id,label,address,reference,latitude,longitude,accuracy_m,building_type,courier_notes,is_default' as const

const getCustomerAddresses = async (businessId: string, customerId: string) => {
  const { data, error } = await db
    .from('customer_addresses')
    .select(CAMPOS_DE_LA_DIRECCION)
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
  accuracyM?: number | null
  buildingType?: string | null
  courierNotes?: string | null
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
      accuracy_m: input.accuracyM ?? null,
      building_type: input.buildingType ?? null,
      courier_notes: input.courierNotes ?? null,
      is_default: Boolean(input.isDefault),
    })
    .select(CAMPOS_DE_LA_DIRECCION)
    .single()
  fail(error, 'No se pudo guardar la dirección')
  return data
}

/**
 * Retira una dirección de la libreta del cliente.
 *
 * Se marca `active = false` en vez de borrarla, y no es prudencia genérica:
 * `orders.address_id` apunta aquí. Borrarla de verdad dejaría ese puntero en
 * nulo y se perdería a qué casa pide más un cliente —lo único para lo que
 * sirve ya ese puntero, porque el destino del pedido va congelado aparte—.
 *
 * El `where` lleva negocio Y cliente: una dirección ajena no se retira ni
 * sabiendo su id. Devuelve `null` si no era suya, y quien llama responde 404.
 */
const deactivateCustomerAddress = async (input: {
  businessId: string
  customerId: string
  addressId: string
}) => {
  const { data, error } = await db
    .from('customer_addresses')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('business_id', input.businessId)
    .eq('customer_id', input.customerId)
    .eq('id', input.addressId)
    .eq('active', true)
    .select('id')
    .maybeSingle()
  fail(error, 'No se pudo eliminar la dirección')
  return data || null
}

/**
 * Le pone el pin a una dirección que ya existe.
 *
 * Hace falta porque las direcciones guardadas antes de esto no tienen
 * coordenadas: sin esta puerta, un cliente con su «7 de agosto» de siempre no
 * podría añadírselas nunca y su repartidor seguiría buscando a ciegas.
 *
 * El `where` lleva negocio Y cliente: una dirección ajena no se mueve ni
 * sabiendo su id. Devuelve `null` si no era suya, y quien llama responde 404.
 */
const setCustomerAddressLocation = async (input: {
  businessId: string
  customerId: string
  addressId: string
  latitude: number
  longitude: number
  accuracyM?: number | null
}) => {
  const { data, error } = await db
    .from('customer_addresses')
    .update({
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy_m: input.accuracyM ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('business_id', input.businessId)
    .eq('customer_id', input.customerId)
    .eq('id', input.addressId)
    .eq('active', true)
    .select(CAMPOS_DE_LA_DIRECCION)
    .maybeSingle()
  fail(error, 'No se pudo guardar la ubicación')
  return data || null
}

// ── Sesiones del enlace ─────────────────────────────────────────────────────

const createStorefrontSession = async (input: {
  businessId: string
  customerId: string
  tokenHash: string
  contactPhone: string
  expiresAt: string | null
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
    .select('id,business_id,customer_id,contact_phone,device_hash,claimed_at,expires_at,revoked_at,verified_at')
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
  paymentMethod?: string | null
  items: unknown[]
  /** Clave del intento de compra: dos envíos con la misma son UN pedido. */
  idempotencyKey?: string | null
  /** Para cuándo lo quiere el cliente. Nulo = lo antes posible. */
  scheduledFor?: string | null
  /** Instrucciones del cliente para ESTE pedido: «llame al llegar». */
  deliveryNotes?: string | null
}) => db.rpc('create_storefront_order', {
  p_business_id: input.businessId,
  p_customer_id: input.customerId,
  p_contact_phone: input.contactPhone,
  p_contact_name: input.contactName || null,
  p_address_id: input.addressId || null,
  p_fulfillment: input.fulfillment || null,
  p_items: input.items,
  p_idempotency_key: input.idempotencyKey || null,
  p_scheduled_for: input.scheduledFor || null,
  p_payment_method: input.paymentMethod || null,
  p_notes: input.deliveryNotes || null,
})

// El comprobante lo sube el cliente desde la mini app, sin JWT: la RPC
// comprueba negocio + pedido + teléfono de la sesión antes de guardarlo.
const attachStorefrontPaymentProof = async (input: {
  businessId: string
  orderId: string
  contactPhone: string
  url: string
  /** Sin él no se puede firmar el acceso temporal al comprobante. */
  publicId?: string | null
}) => db.rpc('attach_storefront_payment_proof', {
  p_business_id: input.businessId,
  p_order_id: input.orderId,
  p_contact_phone: input.contactPhone,
  p_url: input.url,
  p_public_id: input.publicId || null,
})

/**
 * ¿Le toca a este cliente recibir el enlace de la mini app?
 *
 * La decisión y la marca van juntas dentro de PostgreSQL: si el cliente manda
 * tres mensajes seguidos —pasa constantemente— solo uno se lleva el envío.
 * Hacerlo en dos pasos desde aquí dejaría esa carrera abierta.
 */
const claimStorefrontLinkSend = async (
  businessId: string,
  customerId: string,
  cooldownHours = 24,
): Promise<boolean> => {
  const { data, error } = await db.rpc('claim_storefront_link_send', {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_cooldown_hours: cooldownHours,
  })
  fail(error, 'No se pudo comprobar el envío del enlace')
  return data === true
}

/**
 * Ata la sesión a ESTE dispositivo tras confirmar el número.
 *
 * A diferencia de `claimStorefrontSession`, no exige que el dispositivo esté
 * libre: es justo lo que permite que el cliente vuelva a entrar desde un móvil
 * nuevo, o recupere su enlace si alguien lo abrió antes que él. Quien no sepa
 * el número no llega hasta aquí.
 */
const bindStorefrontSession = async (sessionId: string, deviceHash: string) => {
  const ahora = new Date().toISOString()
  const { data, error } = await db
    .from('storefront_sessions')
    .update({ device_hash: deviceHash, claimed_at: ahora, verified_at: ahora })
    .eq('id', sessionId)
    .select('id')
  fail(error, 'No se pudo confirmar la sesión')
  return (data || []).length === 1
}

/**
 * El pedido de un cliente, con su línea de tiempo, para la pantalla de
 * seguimiento.
 *
 * ⚠️ Se filtra por NEGOCIO **y por TELÉFONO de la sesión**, no solo por el id
 * del pedido. Sin el teléfono, cualquiera con una sesión válida de esta tienda
 * podría leer el pedido de otro cliente —con su nombre y su dirección— probando
 * identificadores. Es la misma regla del resto de la tienda: el enlace
 * identifica a UNA persona, y solo ve lo suyo.
 *
 * Devuelve lo justo para pintar el seguimiento: ni la dirección completa ni el
 * comprobante, que no hacen falta para saber por dónde va.
 */
/**
 * Lo que ve el cliente de su propio pedido.
 *
 * `payment_confirmed_at` viaja porque quien transfirió necesita saber si su
 * plata llegó: sin él, el que mandó el comprobante por WhatsApp se queda
 * mirando los datos bancarios como si no hubiera pagado.
 *
 * Las líneas viajan para que el seguimiento diga QUÉ pidió — antes había que
 * volverse a WhatsApp para acordarse. Se nombran una a una en vez de
 * `order_items(*)`: de ahí solo se pintan seis campos, y los demás (ids
 * internos, precio unitario) no tienen por qué salir de la base.
 *
 * ⚠️ Va en una constante `as const` y NO partido con `+`. Concatenar lo
 * convierte en un `string` cualquiera y supabase-js deja de poder inferir la
 * forma de la respuesta: el `data` sale sin tipo y el spread de abajo no
 * compila. La alternativa era un cast, que es justo lo que se quitó de esta
 * capa.
 */
const CAMPOS_DEL_SEGUIMIENTO = 'id,order_number,status,total,currency,fulfillment,created_at,payment_confirmed_at,order_items(product_name,variant_name,extras_names,item_note,quantity,line_total,order_item_options(option_group_name,option_name,quantity,group_sort))' as const

/**
 * Los pedidos de UN cliente en ESTE negocio, para su pestaña de Cuenta.
 *
 * Se filtra por `contact_phone` además de por negocio: es la misma llave con
 * la que se abre un pedido suelto, y la única que la sesión del enlace puede
 * demostrar. Sin ella, quien tuviera una sesión vería la bandeja del local.
 *
 * No trae la línea de tiempo —eso lo pide el seguimiento al abrir uno— pero sí
 * lo suficiente para pintar la lista: qué pidió, cuánto y cómo va.
 */
const getStorefrontOrders = async (input: {
  businessId: string
  contactPhone: string
  limit?: number
}) => {
  const { data, error } = await db
    .from('orders')
    .select(CAMPOS_DEL_SEGUIMIENTO)
    .eq('business_id', input.businessId)
    .eq('contact_phone', input.contactPhone)
    .order('created_at', { ascending: false })
    .limit(Math.min(50, Math.max(1, input.limit || 20)))
  if (error) return { data: null, error }
  return { data: data || [], error: null }
}

const getStorefrontOrder = async (input: {
  businessId: string
  contactPhone: string
  orderId: string
}) => {
  const { data, error } = await db
    .from('orders')
    .select(CAMPOS_DEL_SEGUIMIENTO)
    .eq('business_id', input.businessId)
    .eq('contact_phone', input.contactPhone)
    .eq('id', input.orderId)
    .maybeSingle()
  if (error) return { data: null, error }
  if (!data) return { data: null, error: null }

  // El historial que ya se guardaba en cada cambio de estado. Sin él, «¿cuándo
  // se confirmó?» solo se responde mirando `updated_at`, que se pisa siempre.
  const eventos = await db
    .from('order_events')
    .select('to_status,created_at')
    .eq('business_id', input.businessId)
    .eq('order_id', input.orderId)
    .order('created_at', { ascending: true })

  return { data: { ...data, events: eventos.data || [] }, error: null }
}

export = {
  resolveCustomer,
  claimStorefrontLinkSend,
  bindStorefrontSession,
  getBusinessCustomer,
  setCustomerDisplayName,
  getCustomerAddresses,
  createCustomerAddress,
  setCustomerAddressLocation,
  deactivateCustomerAddress,
  createStorefrontSession,
  getStorefrontSessionByHash,
  claimStorefrontSession,
  touchStorefrontSession,
  cleanupStorefrontSessions,
  createStorefrontOrder,
  getStorefrontOrders,
  getStorefrontOrder,
  attachStorefrontPaymentProof,
}
