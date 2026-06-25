const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const getBusinessById    = async id    => (await sb.from('businesses').select('*').eq('id', id).single()).data
const getBusinessBySlug  = async slug  => (await sb.from('businesses').select('*').eq('slug', slug).single()).data
const getBusinessByPhone = async phone => {
  // Intenta con el número exacto primero, luego normalizando el prefijo +
  const clean = phone?.replace(/^\+/, '') || phone
  const { data: d1 } = await sb.from('businesses').select('*').eq('whatsapp_number', phone).single()
  if (d1) return d1
  const { data: d2 } = await sb.from('businesses').select('*').eq('whatsapp_number', '+' + clean).single()
  return d2 || null
}
const getAllBusinesses    = async ()    => (await sb.from('businesses').select('id,slug,name,type,whatsapp_number,active,bot_active,suspended,plan,plan_expires_at,created_at,notes').order('created_at', { ascending: false })).data || []
const createBusiness     = async data  => sb.from('businesses').insert(data).select().single()
const updateBusiness     = async (id, data) => sb.from('businesses').update(data).eq('id', id)
const suspendBusiness    = async (id, reason) => sb.from('businesses').update({ suspended: true, bot_active: false, suspension_reason: reason }).eq('id', id)
const reactivateBusiness = async id   => {
  const expires = new Date()
  expires.setFullYear(expires.getFullYear() + 1)
  return sb.from('businesses').update({ suspended: false, bot_active: true, suspension_reason: null, plan_expires_at: expires.toISOString() }).eq('id', id)
}

const getExpiredBusinesses = async () => (await sb.from('businesses')
  .select('id, name')
  .eq('suspended', false)
  .eq('active', true)
  .not('plan_expires_at', 'is', null)
  .lt('plan_expires_at', new Date().toISOString())
).data || []

const deleteBusiness    = async id    => {
  await sb.from('billing').delete().eq('business_id', id)
  await sb.from('conversation_history').delete().eq('business_id', id)
  await sb.from('products').delete().eq('business_id', id)
  await sb.from('bot_policies').delete().eq('business_id', id)
  await sb.from('client_users').delete().eq('business_id', id)
  return sb.from('businesses').delete().eq('id', id)
}

const getClientByEmail  = async email => (await sb.from('client_users').select('*').eq('email', email).single()).data
const createClientUser  = async data  => sb.from('client_users').insert(data).select().single()

const getProducts    = async bizId => (await sb.from('products').select('*').eq('business_id', bizId).eq('active', true).order('name')).data || []
const createProduct  = async data  => sb.from('products').insert(data).select().single()
const updateProduct  = async (id, data) => sb.from('products').update({ ...data, updated_at: new Date().toISOString() }).eq('id', id)
const deleteProduct  = async id    => sb.from('products').update({ active: false }).eq('id', id)

const getPolicies    = async bizId => (await sb.from('bot_policies').select('*').eq('business_id', bizId).single()).data
const upsertPolicies = async (bizId, data) => sb.from('bot_policies').upsert({ ...data, business_id: bizId, updated_at: new Date().toISOString() }, { onConflict: 'business_id' })

const getConversations  = async (bizId, limit = 100) => (await sb.from('conversation_history').select('*').eq('business_id', bizId).order('created_at', { ascending: false }).limit(limit)).data || []
const getContactHistory = async (bizId, phone, limit = 8) => { const { data } = await sb.from('conversation_history').select('role,content').eq('business_id', bizId).eq('contact_phone', phone).order('created_at', { ascending: false }).limit(limit); return (data || []).reverse() }
const saveMessage       = async (bizId, phone, role, content) => sb.from('conversation_history').insert({ business_id: bizId, contact_phone: phone, role, content })

const clearSimHistory     = async bizId => sb.from('conversation_history').delete().eq('business_id', bizId).eq('contact_phone', 'sim_admin')

const getBilling          = async ()    => (await sb.from('billing').select('*,businesses(name)').order('period_start', { ascending: false })).data || []
const createBilling       = async data  => sb.from('billing').insert(data).select().single()
const createBillingBatch  = async rows  => sb.from('billing').insert(rows)
const updateBillingStatus = async (id, status, paidAt = null) => sb.from('billing').update({ status, paid_at: paidAt }).eq('id', id)

function generateYearBilling(bizId, amount) {
  const rows = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const year  = now.getFullYear() + Math.floor((now.getMonth() + i) / 12)
    const month = (now.getMonth() + i) % 12
    const start = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const lastDay = new Date(year, month + 1, 0).getDate()
    const end   = `${year}-${String(month + 1).padStart(2, '0')}-${lastDay}`
    rows.push({ business_id: bizId, amount, status: 'pending', period_start: start, period_end: end })
  }
  return rows
}

const getAdminStats = async () => {
  const [a, b, c, d] = await Promise.all([
    sb.from('businesses').select('*', { count: 'exact', head: true }),
    sb.from('businesses').select('*', { count: 'exact', head: true }).eq('bot_active', true),
    sb.from('businesses').select('*', { count: 'exact', head: true }).eq('suspended', true),
    sb.from('conversation_history').select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 86400000).toISOString())
  ])
  return { totalClients: a.count || 0, activeClients: b.count || 0, suspendedClients: c.count || 0, messagesToday: d.count || 0 }
}

const getClientStats = async bizId => {
  const [a, b, c, d] = await Promise.all([
    sb.from('products').select('*', { count: 'exact', head: true }).eq('business_id', bizId).eq('active', true),
    sb.from('products').select('*', { count: 'exact', head: true }).eq('business_id', bizId).eq('stock', 'disponible').eq('active', true),
    sb.from('conversation_history').select('*', { count: 'exact', head: true }).eq('business_id', bizId).gte('created_at', new Date(Date.now() - 86400000).toISOString()),
    sb.from('conversation_history').select('contact_phone').eq('business_id', bizId).eq('role', 'user')
  ])
  return { totalProducts: a.count || 0, availableProducts: b.count || 0, messagesToday: c.count || 0, totalContacts: new Set((d.data || []).map(x => x.contact_phone)).size }
}

module.exports = {
  getBusinessById, getBusinessBySlug, getBusinessByPhone, getAllBusinesses, createBusiness, updateBusiness, suspendBusiness, reactivateBusiness, deleteBusiness, getExpiredBusinesses,
  getClientByEmail, createClientUser,
  getProducts, createProduct, updateProduct, deleteProduct,
  getPolicies, upsertPolicies,
  getConversations, getContactHistory, saveMessage,
  clearSimHistory,
  getBilling, createBilling, createBillingBatch, updateBillingStatus, generateYearBilling,
  getAdminStats, getClientStats
}
