import type { SupabaseClient } from '@supabase/supabase-js'

type BusinessData = Record<string, unknown>

interface BusinessRecord extends BusinessData {
  id?: string
  whatsapp_number?: string | null
  ycloud_number?: string | null
}

const db = require('../client') as SupabaseClient

const getBusinessById = async (id: string) => {
  const { data } = await db.from('businesses').select('*').eq('id', id).single()
  return data as BusinessRecord | null
}

const getBusinessBySlug = async (slug: string) => {
  const { data } = await db.from('businesses').select('*').eq('slug', slug).single()
  return data as BusinessRecord | null
}

const getBusinessByPhone = async (phone?: string | null) => {
  if (!phone) return null

  const clean = phone.replace(/^\+/, '')
  const { data: exact } = await db
    .from('businesses')
    .select('*')
    .eq('whatsapp_number', phone)
    .single()
  if (exact) return exact as BusinessRecord

  const { data: normalized } = await db
    .from('businesses')
    .select('*')
    .eq('whatsapp_number', `+${clean}`)
    .single()
  if (normalized) return normalized as BusinessRecord

  const incomingDigits = phone.replace(/\D/g, '')
  const tail = incomingDigits.slice(-9)
  if (tail.length < 8) return null

  const { data } = await db.from('businesses').select('*')
  const businesses = (data || []) as BusinessRecord[]
  return businesses.find((business) => {
    const whatsappDigits = String(business.whatsapp_number || '').replace(/\D/g, '')
    const ycloudDigits = String(business.ycloud_number || '').replace(/\D/g, '')
    return (whatsappDigits && whatsappDigits.slice(-9) === tail)
      || (ycloudDigits && ycloudDigits.slice(-9) === tail)
  }) || null
}

const businessListFields = 'id,slug,name,type,whatsapp_number,active,bot_active,suspended,plan,plan_expires_at,created_at,notes'

const getAllBusinesses = async () => {
  const current = await db
    .from('businesses')
    .select(`${businessListFields},lodging_enabled`)
    .order('created_at', { ascending: false })
  if (!current.error) return current.data || []

  // Permite desplegar el servidor antes de ejecutar migration-hospedaje.sql.
  // Una base antigua no puede habilitar el módulo y conserva el listado normal.
  if (current.error.message?.includes('lodging_enabled')) {
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

const reactivateBusiness = async (id: string) => {
  const expires = new Date()
  expires.setFullYear(expires.getFullYear() + 1)
  return db.from('businesses').update({
    suspended: false,
    bot_active: true,
    suspension_reason: null,
    plan_expires_at: expires.toISOString(),
  }).eq('id', id)
}

const getExpiredBusinesses = async () => {
  const { data } = await db
    .from('businesses')
    .select('id, name')
    .eq('suspended', false)
    .eq('active', true)
    .not('plan_expires_at', 'is', null)
    .lt('plan_expires_at', new Date().toISOString())
  return data || []
}

// Todas las FK usan ON DELETE CASCADE; PostgreSQL elimina el agregado completo.
const deleteBusiness = async (id: string) => (
  db.from('businesses').delete().eq('id', id)
)

export = {
  getBusinessById,
  getBusinessBySlug,
  getBusinessByPhone,
  getAllBusinesses,
  createBusiness,
  createBusinessOnboarding,
  updateBusiness,
  suspendBusiness,
  reactivateBusiness,
  getExpiredBusinesses,
  deleteBusiness,
}
