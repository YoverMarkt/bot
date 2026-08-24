import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessRecord, BusinessTemplate } from '../types'
import {
  normalizeChannelIdentifier,
  type ChannelAddress,
} from '../../types/channels'

// Para ESCRITURAS: crear y actualizar reciben un subconjunto de columnas, y la
// lista blanca de la ruta ya filtra cuáles se aceptan. Aquí flexible es lo
// correcto; lo que importa es que las LECTURAS estén tipadas.
type BusinessData = Record<string, unknown>


interface ChannelRouteRecord {
  business_id?: string | null
  businesses?: BusinessRecord | BusinessRecord[] | null
}

const db: SupabaseClient = require('../client') as typeof import('../client')

const getBusinessById = async (id: string) => {
  const { data } = await db.from('businesses').select('*').eq('id', id).single()
  return data as BusinessRecord | null
}

const getBusinessBySlug = async (slug: string) => {
  const { data } = await db.from('businesses').select('*').eq('slug', slug).single()
  return data as BusinessRecord | null
}

function routedBusiness(route?: ChannelRouteRecord | null): BusinessRecord | null {
  const related = route?.businesses
  if (Array.isArray(related)) return related[0] || null
  return related || null
}

const getBusinessByChannel = async (address: ChannelAddress) => {
  const canonical = normalizeChannelIdentifier(
    address.identifierType,
    address.identifier,
  )
  if (!canonical) return null

  const route = await db
    .from('business_channel_identifiers')
    .select('business_id,businesses(*)')
    .eq('provider', address.provider)
    .eq('identifier_type', address.identifierType)
    .eq('canonical_identifier', canonical)
    .maybeSingle()
  if (route.error) {
    throw new Error(`No se pudo resolver el canal: ${route.error.message}`)
  }
  return routedBusiness(route.data as ChannelRouteRecord | null)
}

// Compatibilidad interna temporal. Nunca elige un tenant si el mismo teléfono
// aparece en más de un namespace; los flujos productivos usan proveedor + tipo.
const getBusinessByPhone = async (phone?: string | null) => {
  const canonical = normalizeChannelIdentifier('phone', phone)
  if (!canonical) return null

  const route = await db
    .from('business_channel_identifiers')
    .select('business_id,businesses(*)')
    .eq('identifier_type', 'phone')
    .eq('canonical_identifier', canonical)
    .maybeSingle()
  if (route.error) {
    throw new Error(`No se pudo resolver el teléfono: ${route.error.message}`)
  }
  return routedBusiness(route.data as ChannelRouteRecord | null)
}

// Las columnas del LISTADO del superadmin. Ninguna es un secreto: lo que se
// pide por la ficha pasa antes por `sanitizeBusinessForAdmin`.
//
// ⚠️ `whatsapp_provider`, `takes_orders` y `storefront_enabled` se añadieron el
// 2026-08-23. Las tres responden la única pregunta que la lista tenía que
// contestar y no podía: **¿este local aparece en el marketplace?** Sin ellas la
// tabla enseñaba el número de WhatsApp (vacío en todos), el estado del bot
// (una columna que ya no decide nada) y un semáforo de canal por local (que
// ningún local del marketplace tiene).
const businessListFields = [
  'id',
  'slug',
  'name',
  'type',
  'whatsapp_number',
  'whatsapp_provider',
  'active',
  'bot_active',
  'suspended',
  'takes_orders',
  'storefront_enabled',
  'plan',
  'monthly_contact_limit',
  'monthly_outbound_message_limit',
  'created_at',
  'notes',
].join(',')

// Se anota a mano porque las columnas van en una cadena unida: el SDK no puede
// leerlas y devuelve un tipo de error en vez de la fila. La conversión vive
// AQUÍ, en el borde con el driver, y no repartida por quien consume.
type BusinessWithSecrets = Pick<
  BusinessRecord,
  'id' | 'name' | 'active' | 'suspended' | 'whatsapp_provider' | 'whatsapp_number'
  | 'ycloud_number' | 'ycloud_api_key' | 'ycloud_webhook_endpoint_id' | 'telegram_bot_token'
>

// Solo para la vigilancia interna de credenciales (`services/credential-monitor.ts`).
// Trae los secretos porque hay que preguntarle al proveedor si siguen sirviendo.
// ⚠️ NO exponer por ninguna ruta: lo que va al panel pasa antes por
// `sanitizeBusinessForAdmin`.
const getAllBusinessesWithSecrets = async (): Promise<BusinessWithSecrets[]> => {
  const { data, error } = await db
    .from('businesses')
    .select([
      'id', 'name', 'active', 'suspended',
      'whatsapp_provider', 'whatsapp_number', 'ycloud_number',
      'ycloud_api_key', 'ycloud_webhook_endpoint_id', 'telegram_bot_token',
    ].join(','))
  if (error) throw new Error(error.message)
  return (data || []) as unknown as BusinessWithSecrets[]
}

const getAllBusinesses = async () => {
  const current = await db
    .from('businesses')
    .select(`${businessListFields},chat_mode`)
    .order('created_at', { ascending: false })
  if (!current.error) return current.data || []

  // Permite desplegar el servidor antes de ejecutar migration-modo-menu.sql.
  // Una base antigua conserva el listado normal.
  if (/chat_mode/.test(current.error.message || '')) {
    const legacy = await db
      .from('businesses')
      .select(businessListFields)
      .order('created_at', { ascending: false })
    if (legacy.error) throw new Error(legacy.error.message)
    return legacy.data || []
  }
  throw new Error(current.error.message)
}

const createBusiness = async (data: BusinessData) => (
  db.from('businesses').insert(data).select().single()
)

const createBusinessOnboarding = async (
  business: BusinessData,
  clientEmail: string | null,
  passwordHash: string | null,
  monthlyRate: number | null,
) => db.rpc('create_business_onboarding', {
  p_business: business,
  p_client_email: clientEmail,
  p_password_hash: passwordHash,
  p_monthly_rate: monthlyRate,
})

const updateBusiness = async (id: string, data: BusinessData) => (
  db.from('businesses').update(data).eq('id', id)
)

const suspendBusiness = async (id: string, reason: string) => (
  db.from('businesses').update({
    suspended: true,
    bot_active: false,
    suspension_reason: reason,
  }).eq('id', id)
)

// Enciende o apaga el bot sin tocar el estado de la cuenta. Suspender también
// lo apaga, pero no al revés: reanudar el bot de un negocio suspendido no lo
// devuelve al aire, y por eso el panel no ofrece esa combinación.
const setBotActive = async (id: string, active: boolean) => (
  db.from('businesses').update({ bot_active: active }).eq('id', id)
)

const reactivateBusiness = async (id: string) => (
  db.rpc('reactivate_business_with_billing', { p_business_id: id })
)

const updateBusinessPlanBilling = async (
  id: string,
  plan: string,
  monthlyRate: number,
  monthlyContactLimit: number,
  monthlyOutboundMessageLimit: number,
) => db.rpc('update_business_plan_billing', {
  p_business_id: id,
  p_plan: plan,
  p_monthly_rate: monthlyRate,
  p_monthly_contact_limit: monthlyContactLimit,
  p_monthly_outbound_message_limit: monthlyOutboundMessageLimit,
})

// Todas las FK usan ON DELETE CASCADE; PostgreSQL elimina el agregado completo.
const deleteBusiness = async (id: string) => (
  db.from('businesses').delete().eq('id', id)
)

/**
 * Deja cargadas las categorías y los grupos de opciones típicos del tipo de
 * negocio recién creado. La RPC la aplica entera o no la aplica.
 *
 * Devuelve `aplicada: false` sin tocar nada si el negocio ya tiene catálogo, y
 * eso NO es un error: el tipo solo recomienda al crear y jamás pisa decisiones
 * ya tomadas, así que quien llame debe tratarlo como un resultado normal.
 */
const applyBusinessTemplate = async (businessId: string, template: BusinessTemplate) => (
  db.rpc('apply_business_template', {
    p_business_id: businessId,
    p_template: template,
  })
)


/**
 * Los métodos de pago de un negocio, encendidos y apagados, para su panel.
 *
 * Devuelve TODOS los disponibles en la plataforma —no solo los activos— para
 * que el dueño vea los interruptores que puede tocar. Los que la plataforma
 * todavía no procesa (tarjeta, pasarela) no salen: no tiene sentido enseñar
 * un interruptor que la base va a rechazar.
 */
const getBusinessPaymentMethods = async (businessId: string) => {
  const { data, error } = await db
    .from('business_payment_methods')
    .select('method_code, enabled, sort, payment_methods!inner(label, help_text, is_prepaid, requires_proof, available)')
    .eq('business_id', businessId)
    .eq('payment_methods.available', true)
    .order('sort')
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * Enciende o apaga uno.
 *
 * ⚠️ El `business_id` sale del JWT del dueño, nunca de la petición. Y la base
 * vuelve a comprobar que el método esté disponible en la plataforma: apagar
 * aquí es una preferencia, activar algo que no existe es imposible.
 */
const setBusinessPaymentMethod = async (
  businessId: string,
  methodCode: string,
  enabled: boolean,
) => db
  .from('business_payment_methods')
  .update({ enabled, updated_at: new Date().toISOString() })
  .eq('business_id', businessId)
  .eq('method_code', methodCode)

export = {
  getBusinessPaymentMethods,
  setBusinessPaymentMethod,
  getBusinessById,
  getBusinessBySlug,
  getBusinessByChannel,
  getBusinessByPhone,
  getAllBusinesses,
  getAllBusinessesWithSecrets,
  createBusiness,
  createBusinessOnboarding,
  updateBusiness,
  suspendBusiness,
  setBotActive,
  reactivateBusiness,
  updateBusinessPlanBilling,
  deleteBusiness,
  applyBusinessTemplate,
}
