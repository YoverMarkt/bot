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

/**
 * Cómo se compara una dirección con otra para saber si son LA MISMA.
 *
 * Sin tildes, sin mayúsculas y sin espacios de más: «Av. Amazonas  N34» y
 * «av. amazonas n34» son la misma casa escrita dos veces, y quien las teclea
 * en el móvil de una tienda no está pensando en eso.
 */
const mismaDireccion = (texto: string): string => texto
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

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
  // ── LA MISMA CASA NO SE GUARDA DOS VECES ─────────────────────────────────
  //
  // ⚠️ Esto no es pulcritud: es la red que faltaba bajo un fallo real. Si la
  // app no consigue leer la libreta del cliente —un 401 al arrancar, la sesión
  // que se estrena, la red— le enseña «no tienes direcciones» y la persona
  // escribe la suya otra vez. El resultado, medido en producción el
  // 2026-08-29: **12 direcciones para un cliente, siete de ellas borradas a
  // mano por él**, y la misma calle repetida cinco veces.
  //
  // La app ya se arregló para recargar quién es al estrenar sesión, pero esa
  // defensa vive en el teléfono. Esta vive DONDE SE ESCRIBE, así que aguanta
  // aunque el frontend falle por un motivo que nadie ha previsto todavía.
  //
  // Reutilizar en vez de rechazar: quien manda esto cree que está guardando su
  // dirección, y devolverle la que ya tenía es exactamente lo que esperaba —
  // con su id, que es lo que el checkout necesita para dejarla elegida.
  //
  // ⚠️ Solo mira las ACTIVAS. Una que el cliente borró y vuelve a escribir es
  // una decisión suya de recuperarla, no un duplicado.
  const existentes = await getCustomerAddresses(input.businessId, input.customerId)
  const repetida = (existentes as { id: string; address?: string | null }[])
    .find(item => mismaDireccion(String(item.address || '')) === mismaDireccion(input.address))

  if (repetida) {
    // Se refresca lo que SÍ puede haber mejorado: el pin, la referencia y cómo
    // la llama. Un cliente que vuelve a escribirla suele estar corrigiendo algo.
    const { data, error } = await db
      .from('customer_addresses')
      .update({
        label: input.label || 'Casa',
        reference: input.reference || null,
        // El pin solo se pisa si viene uno nuevo: perder el que ya estaba
        // porque esta vez el navegador negó el permiso sería un paso atrás.
        ...(input.latitude != null && input.longitude != null
          ? { latitude: input.latitude, longitude: input.longitude, accuracy_m: input.accuracyM ?? null }
          : {}),
        building_type: input.buildingType ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('business_id', input.businessId)
      .eq('customer_id', input.customerId)
      .eq('id', repetida.id)
      .select(CAMPOS_DE_LA_DIRECCION)
      .single()
    fail(error, 'No se pudo guardar la dirección')
    return data
  }

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

/**
 * El dinero OFICIAL del pedido, leído de la fila ya sellada.
 *
 * ⚠️ Existe porque `create_storefront_order` devuelve su propia cuenta
 * —`subtotal + envío`— y esa cuenta se queda CORTA: el disparador
 * `orders_stamp_pricing` corre después (BEFORE UPDATE) y, en modo `on_top`,
 * suma el margen de la plataforma al total. El resultado era que la app
 * enseñaba $12.99 sobre un pedido que la base guardaba en $14.09, y ese es el
 * número que el cliente iba a transferir: pagaba $1.10 de menos en cada
 * pedido, y el descuadre lo comía el negocio.
 *
 * Se lee la fila en vez de recrear la RPC a propósito: la regla del proyecto
 * es no tocar las funciones del dinero por algo que se resuelve fuera, porque
 * copiar la versión equivocada desde `schema.sql` cuesta más de lo que arregla.
 *
 * Sin `contact_phone` en el filtro porque lo llama la ruta que ACABA de crear
 * el pedido con esos datos; el id es de un pedido recién nacido y el negocio
 * ya está comprobado.
 */
const getOrderMoney = async (businessId: string, orderId: string) => {
  const { data, error } = await db
    .from('orders')
    .select('subtotal,shipping,total')
    .eq('business_id', businessId)
    .eq('id', orderId)
    .maybeSingle()
  if (error || !data) return null
  return data as { subtotal: number | string | null; shipping: number | string | null; total: number | string | null }
}

/**
 * Registra la huella del comprobante y avisa si esa imagen ya se usó.
 *
 * ⚠️ La búsqueda de duplicados es GLOBAL —un comprobante reutilizado en otro
 * local es el fraude que más importa cazar—, pero la RPC nunca devuelve datos
 * del otro negocio: solo dice que ya se usó. Por eso vive en una función
 * `security definer` y no en una consulta desde aquí.
 */
const registerPaymentReceipt = async (input: {
  businessId: string
  orderId: string
  fileUrl: string
  filePublicId?: string | null
  sha256: string
  perceptualHash?: string | null
  mimeType?: string | null
  fileSize?: number | null
}) => db.rpc('register_payment_receipt', {
  p_business_id: input.businessId,
  p_order_id: input.orderId,
  p_file_url: input.fileUrl,
  p_file_public_id: input.filePublicId || null,
  p_sha256: input.sha256,
  p_perceptual_hash: input.perceptualHash || null,
  p_mime_type: input.mimeType || null,
  p_file_size: input.fileSize ?? null,
})

/**
 * Guarda lo que la visión leyó del comprobante, sus señales y su score.
 *
 * ⚠️ El score lo calcula la BASE sumando todas las señales del comprobante, no
 * el servidor: `register_payment_receipt` ya dejó escrita la del duplicado
 * ANTES de que el análisis existiera, y un total calculado aquí la perdería.
 *
 * ⚠️ Y no confirma ningún pago: la RPC no escribe una sola columna de `orders`.
 */
const saveReceiptAnalysis = async (input: {
  businessId: string
  receiptId: string
  status: 'analizado' | 'requiere_revision'
  datos?: Record<string, unknown> | null
  flags?: Array<Record<string, unknown>> | null
  analysis?: Record<string, unknown> | null
  /** Los puntos de la señal de referencia repetida, configurables en Ajustes. */
  puntosReferencia?: number
}) => db.rpc('save_receipt_analysis', {
  p_business_id: input.businessId,
  p_receipt_id: input.receiptId,
  p_status: input.status,
  p_datos: input.datos ?? null,
  p_flags: input.flags ?? null,
  p_analysis: input.analysis ?? null,
  p_puntos_referencia: input.puntosReferencia ?? 60,
})

/**
 * El análisis del comprobante más reciente de un pedido, para el panel.
 *
 * El filtro por negocio va DENTRO de la función: el identificador del pedido
 * viaja en la URL, y sin el negocio se estaría enseñando el comprobante de
 * otro local.
 */
const getReceiptAnalysis = async (businessId: string, orderId: string) => {
  const { data, error } = await db.rpc('get_receipt_analysis', {
    p_business_id: businessId,
    p_order_id: orderId,
  })
  fail(error, 'No se pudo leer el análisis del comprobante')
  return (data || null) as Record<string, unknown> | null
}

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

// ── Quien escribe por molestar ─────────────────────────────────────────────

/**
 * ¿Se le contesta a este cliente, y cómo?
 *
 * Todo dentro de PostgreSQL y en una sola operación: contar aquí y escribir
 * después deja una carrera con los mensajes que llegan a la vez, que es justo
 * lo que hace quien escribe rápido para molestar.
 *
 * Nunca lanza hacia arriba con un `permitido: false`: si la base falla se
 * prefiere contestar. Quedarse callado por un fallo nuestro deja sin atender a
 * un cliente de verdad, y eso cuesta más que un mensaje de más.
 */
const claimMiniappReply = async (
  businessId: string,
  customerId: string,
  limites: {
    avisoDesde?: number
    tope?: number
    silencioHoras?: number
    /** El mensaje entrante que provocó la respuesta, para no contarlo dos veces. */
    mensajeId?: string | null
  } = {},
): Promise<{
  /** `false` = no se le contesta: está bloqueado o silenciado. */
  permitido: boolean
  motivo: 'ok' | 'con_telefono' | 'bloqueado' | 'silenciado'
  /** Cuántas van en esta hora, con esta incluida. */
  respuestas: number
}> => {
  const { data, error } = await db.rpc('claim_miniapp_reply', {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_aviso_desde: limites.avisoDesde ?? 5,
    p_tope: limites.tope ?? 10,
    p_silencio_horas: limites.silencioHoras ?? 24,
    p_message_id: limites.mensajeId || null,
  })
  fail(error, 'No se pudo comprobar el ritmo de respuestas')
  const respuesta = (data || {}) as {
    permitido?: boolean
    motivo?: 'ok' | 'con_telefono' | 'bloqueado' | 'silenciado'
    respuestas?: number
  }
  return {
    permitido: respuesta.permitido !== false,
    motivo: respuesta.motivo || 'ok',
    respuestas: Number(respuesta.respuestas) || 0,
  }
}

/**
 * ¿Este teléfono está bloqueado en este negocio?
 *
 * ⚠️ Se normaliza a dígitos porque `customers.phone` se guarda así, y el bot
 * recibe el número con «+» (`+593…`). Buscar sin normalizar no falla: devuelve
 * vacío, que aquí significaría «no está bloqueado» — el peor fallo posible
 * para un bloqueo.
 */
const isContactBlocked = async (businessId: string, phone: string): Promise<boolean> => {
  const digitos = String(phone || '').replace(/\D/g, '')
  if (!businessId || !digitos) return false
  const { data, error } = await db
    .from('business_customers')
    .select('blocked_at,customers!inner(phone)')
    .eq('business_id', businessId)
    .eq('customers.phone', digitos)
    .maybeSingle()
  fail(error, 'No se pudo comprobar el bloqueo')
  return Boolean((data as { blocked_at?: string | null } | null)?.blocked_at)
}

/**
 * La regla de margen vigente para este negocio, o `null` si no hay ninguna.
 *
 * Sale de `business_pricing_view`, que aplica la MISMA jerarquía que usa el
 * cobro (negocio → tipo → global): reimplementarla aquí daría dos respuestas
 * a la misma pregunta, y una de las dos acabaría cobrando distinto.
 *
 * ⚠️ Falla hacia `null` —sin margen— y no hacia un porcentaje inventado: si la
 * consulta revienta, el cliente ve el precio del comercio. Equivocarse hacia
 * NO cobrar de más es el único lado seguro de este error.
 */
const getBusinessPricingRule = async (
  businessId: string,
): Promise<Record<string, unknown> | null> => {
  if (!businessId) return null
  const { data, error } = await db.rpc('business_pricing_view', {
    p_business_id: businessId,
  })
  if (error) return null
  return (data as Record<string, unknown> | null) ?? null
}

/**
 * ¿Toca EXPLICARLE el bloqueo a este cliente? Una sola vez.
 *
 * Devuelve `true` en su primer intento tras ser bloqueado y `false` en todos
 * los siguientes, así el bloqueado nunca cuesta más mensajes que un cliente
 * normal — que es lo que pasaría avisando cada vez, porque quien molesta
 * insiste.
 *
 * ⚠️ Falla hacia el SILENCIO (`false`): ante un fallo de la base se manda el
 * mensaje neutro de siempre, que es la conducta anterior a esto. Al revés
 * —avisar por defecto— un fallo repetido convertiría el bloqueo en una fuente
 * de mensajes pagados.
 */
const claimBlockedNotice = async (
  businessId: string,
  customerId: string,
): Promise<boolean> => {
  if (!businessId || !customerId) return false
  const { data, error } = await db.rpc('claim_blocked_notice', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
  if (error) return false
  return data === true
}

/** Lo mismo cuando ya se sabe QUIÉN es: el camino de la mini app. */
const isCustomerBlocked = async (businessId: string, customerId: string): Promise<boolean> => {
  if (!businessId || !customerId) return false
  const { data, error } = await db
    .from('business_customers')
    .select('blocked_at,blocked_until')
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .maybeSingle()
  fail(error, 'No se pudo comprobar el bloqueo')
  return estaBloqueado(data as { blocked_at?: string | null; blocked_until?: string | null } | null)
}

/**
 * ¿Está bloqueado AHORA?
 *
 * Las dos formas se distinguen por si el bloqueo tiene fin:
 *  · `blocked_at` sin `blocked_until` → **permanente**, el que pone el dueño a
 *    mano. Solo él lo levanta.
 *  · `blocked_until` con fecha → **temporal**: caduca solo, sin que nadie haga
 *    nada, y por eso el aviso al cliente sí puede prometer el plazo.
 *
 * ⚠️ Vive aquí Y en `storefront_customer_blocked` (PostgreSQL), y las dos
 * tienen que contestar lo mismo: esta atiende la ruta y aquella el disparador
 * que cierra la carrera al insertar. Si se toca una, se toca la otra — hay una
 * prueba de esquema que ejecuta la de la base con los cuatro casos.
 */
const estaBloqueado = (
  fila: { blocked_at?: string | null; blocked_until?: string | null } | null,
): boolean => {
  if (!fila) return false
  const hasta = fila.blocked_until
  if (hasta) return new Date(hasta).getTime() > Date.now()
  return Boolean(fila.blocked_at)
}

/**
 * Los teléfonos bloqueados de un negocio, para que el panel los marque.
 *
 * Se consultan aparte y no dentro de la lista de conversaciones a propósito:
 * son POCOS —y en casi todos los negocios, ninguno—, mientras que la lista de
 * chats se pide cada pocos segundos. Un `join` ahí correría sin parar por un
 * dato que casi siempre está vacío; esta consulta usa el índice parcial
 * `idx_business_customers_bloqueados`, que solo indexa las filas bloqueadas.
 */
const getBlockedPhones = async (businessId: string): Promise<string[]> => {
  if (!businessId) return []
  const { data, error } = await db
    .from('business_customers')
    .select('customers!inner(phone)')
    .eq('business_id', businessId)
    .not('blocked_at', 'is', null)
  fail(error, 'No se pudieron leer los números bloqueados')
  const filas = (data || []) as { customers?: { phone?: string | null } | null }[]
  return filas
    .map(fila => String(fila.customers?.phone || '').trim())
    .filter(Boolean)
}

/**
 * El dueño bloquea o desbloquea un número desde su panel.
 *
 * Crea el cliente si no existía: quien escribe por molestar puede no haber
 * pedido nunca, y es justo a ese al que hay que poder bloquear.
 *
 * Desbloquear limpia TAMBIÉN el silencio automático y el contador: si el dueño
 * decide dar otra oportunidad, empieza de cero. Dejarle el silencio puesto
 * haría que el desbloqueo pareciera no funcionar durante horas.
 */
const setContactBlocked = async (
  businessId: string,
  phone: string,
  bloqueado: boolean,
): Promise<{ blocked: boolean }> => {
  const customer = await resolveCustomer({ businessId, phone })
  const ahora = new Date().toISOString()
  const { error } = await db
    .from('business_customers')
    .update(bloqueado
      ? { blocked_at: ahora, updated_at: ahora }
      // Desbloquear limpia también `blocked_notified_at`: si el dueño lo
      // vuelve a bloquear más adelante, esa es una decisión NUEVA y merece su
      // propia explicación.
      : {
        blocked_at: null, blocked_notified_at: null, muted_until: null,
        reply_count: 0, reply_window_start: null, updated_at: ahora,
      })
    .eq('business_id', businessId)
    .eq('customer_id', customer.id)
  fail(error, 'No se pudo actualizar el bloqueo')
  return { blocked: bloqueado }
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
const CAMPOS_DEL_SEGUIMIENTO = 'id,order_number,status,total,shipping,currency,fulfillment,created_at,payment_confirmed_at,order_items(product_name,variant_name,extras_names,item_note,quantity,line_total,order_item_options(option_group_name,option_name,quantity,group_sort))' as const

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


/**
 * Los métodos de pago que ese negocio acepta HOY.
 *
 * Devuelve solo los que el dueño tiene encendidos Y la plataforma sabe
 * procesar. La app pinta lo que reciba: dejó de tenerlos escritos a mano, que
 * es lo que hacía que un dueño creyera que elegía y no eligiera nada.
 */
const getStorefrontPaymentMethods = async (businessId: string) => {
  const { data, error } = await db.rpc('storefront_payment_methods', {
    p_business_id: businessId,
  })
  if (error) throw new Error(error.message)
  return (data || []) as Array<{
    code: string
    label: string
    help_text: string | null
    is_prepaid: boolean
    requires_proof: boolean
  }>
}

export = {
  registerPaymentReceipt,
  saveReceiptAnalysis,
  getReceiptAnalysis,
  getStorefrontPaymentMethods,
  resolveCustomer,
  claimStorefrontLinkSend,
  claimMiniappReply,
  isContactBlocked,
  claimBlockedNotice,
  getBusinessPricingRule,
  isCustomerBlocked,
  estaBloqueado,
  setContactBlocked,
  getBlockedPhones,
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
  getOrderMoney,
  getStorefrontOrders,
  getStorefrontOrder,
  attachStorefrontPaymentProof,
}
