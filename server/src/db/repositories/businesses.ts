import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessRecord } from '../types'
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

const businessListFields = [
  'id',
  'slug',
  'name',
  'type',
  'whatsapp_number',
  'active',
  'bot_active',
  'suspended',
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
    .select(`${businessListFields},lodging_enabled,chat_mode`)
    .order('created_at', { ascending: false })
  if (!current.error) return current.data || []

  // Permite desplegar el servidor antes de ejecutar migration-hospedaje.sql o
  // migration-modo-menu.sql. Una base antigua conserva el listado normal.
  if (/lodging_enabled|chat_mode/.test(current.error.message || '')) {
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

export = {
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
  reactivateBusiness,
  updateBusinessPlanBilling,
  deleteBusiness,
}
