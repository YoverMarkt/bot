const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

// Backend usa la SECRET key (service_role) para bypassear RLS.
// Fallback a SUPABASE_KEY si aún no se configuró la secret.
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY)

const getBusinessById    = async id    => (await sb.from('businesses').select('*').eq('id', id).single()).data
const getBusinessBySlug  = async slug  => (await sb.from('businesses').select('*').eq('slug', slug).single()).data
const getBusinessByPhone = async phone => {
  // Intenta con el número exacto primero, luego normalizando el prefijo +
  const clean = phone?.replace(/^\+/, '') || phone
  const { data: d1 } = await sb.from('businesses').select('*').eq('whatsapp_number', phone).single()
  if (d1) return d1
  const { data: d2 } = await sb.from('businesses').select('*').eq('whatsapp_number', '+' + clean).single()
  if (d2) return d2
  // Coincidencia flexible: compara por los últimos 9 dígitos (sirve aunque el dueño
  // haya guardado el número sin código de país, ej: Ecuador 10 dígitos vs 593...)
  const incomingDigits = (phone || '').replace(/\D/g, '')
  const tail = incomingDigits.slice(-9)
  if (tail.length >= 8) {
    const { data: all } = await sb.from('businesses').select('*')
    const match = (all || []).find(b => {
      const bd = (b.whatsapp_number || '').replace(/\D/g, '')
      const yd = (b.ycloud_number || '').replace(/\D/g, '')
      return (bd && bd.slice(-9) === tail) || (yd && yd.slice(-9) === tail)
    })
    if (match) return match
  }
  return null
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
const getClientUserByBusiness = async bizId => (await sb.from('client_users').select('email').eq('business_id', bizId).single()).data
const createClientUser  = async data  => sb.from('client_users').insert(data).select().single()

const getProducts    = async bizId => (await sb.from('products').select('*').eq('business_id', bizId).eq('active', true).order('name')).data || []
const getProductById = async id    => (await sb.from('products').select('*').eq('id', id).single()).data
const createProduct  = async data  => sb.from('products').insert(data).select().single()
const updateProduct  = async (id, data) => sb.from('products').update({ ...data, updated_at: new Date().toISOString() }).eq('id', id)
const deleteProduct  = async id    => sb.from('products').update({ active: false }).eq('id', id)
const countProducts  = async bizId => (await sb.from('products').select('*', { count: 'exact', head: true }).eq('business_id', bizId).eq('active', true)).count || 0

// ── RAG VECTORIAL ──
const setProductEmbedding = async (id, embedding) => sb.from('products').update({ embedding }).eq('id', id)
// Productos sin embedding (para reindexar)
const getProductsWithoutEmbedding = async bizId => (await sb.from('products').select('*').eq('business_id', bizId).eq('active', true).is('embedding', null)).data || []
// Búsqueda por significado (usa la función SQL match_products)
const searchProductsByVector = async (bizId, queryEmbedding, limit = 12) => {
  const { data, error } = await sb.rpc('match_products', { query_embedding: queryEmbedding, biz_id: bizId, match_count: limit })
  if (error) { console.error('❌ match_products:', error.message); return null }
  return data || []
}

const getPolicies    = async bizId => (await sb.from('bot_policies').select('*').eq('business_id', bizId).single()).data
const upsertPolicies = async (bizId, data) => sb.from('bot_policies').upsert({ ...data, business_id: bizId, updated_at: new Date().toISOString() }, { onConflict: 'business_id' })

const getConversations  = async (bizId, limit = 100) => (await sb.from('conversation_history').select('*').eq('business_id', bizId).order('created_at', { ascending: false }).limit(limit)).data || []
const getContactHistory = async (bizId, phone, limit = 24) => { const { data } = await sb.from('conversation_history').select('role,content,created_at').eq('business_id', bizId).eq('contact_phone', phone).order('created_at', { ascending: false }).limit(limit); return (data || []).reverse() }
const saveMessage       = async (bizId, phone, role, content) => {
  const res = await sb.from('conversation_history').insert({ business_id: bizId, contact_phone: phone, role, content })
  // Si la restricción aún no permite 'owner', guardar como 'assistant' para no perder el mensaje
  if (res.error && role === 'owner') {
    return sb.from('conversation_history').insert({ business_id: bizId, contact_phone: phone, role: 'assistant', content })
  }
  return res
}

const clearSimHistory     = async bizId => sb.from('conversation_history').delete().eq('business_id', bizId).eq('contact_phone', 'sim_admin')

// ── SESSIONS (modo manual / bot) ──────────────────────────
const getSession   = async (bizId, phone) =>
  (await sb.from('conversation_sessions').select('*').eq('business_id', bizId).eq('contact_phone', phone).single()).data

const getSessions  = async bizId =>
  (await sb.from('conversation_sessions').select('*').eq('business_id', bizId).order('last_message_at', { ascending: false })).data || []

const upsertSession = async (bizId, phone, data) =>
  sb.from('conversation_sessions').upsert(
    { business_id: bizId, contact_phone: phone, ...data },
    { onConflict: 'business_id,contact_phone' }
  )

const getBilling          = async ()    => (await sb.from('billing').select('*,businesses(name)').order('period_start', { ascending: false })).data || []
const createBilling       = async data  => sb.from('billing').insert(data).select().single()
const createBillingBatch  = async rows  => sb.from('billing').insert(rows)
const updateBillingStatus = async (id, status, paidAt = null) => sb.from('billing').update({ status, paid_at: paidAt }).eq('id', id)
const countBilling        = async bizId => (await sb.from('billing').select('*', { count: 'exact', head: true }).eq('business_id', bizId)).count || 0
// Actualiza el monto de los meses NO pagados (pendientes) al nuevo valor
const updatePendingBilling = async (bizId, amount) => sb.from('billing').update({ amount }).eq('business_id', bizId).eq('status', 'pending')

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

// ── HORARIOS Y RESERVAS ───────────────────────────────────
const DAYS_ES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']

const getSchedule = async bizId =>
  (await sb.from('business_schedule').select('*').eq('business_id', bizId).order('day_of_week')).data || []

const upsertSchedule = async (bizId, days) => {
  // days = [{ day_of_week, open_time, close_time, slot_duration, is_active }]
  const rows = days.map(d => ({ ...d, business_id: bizId }))
  return sb.from('business_schedule').upsert(rows, { onConflict: 'business_id,day_of_week' })
}

const getBookings = async (bizId, from, to) => {
  let q = sb.from('bookings').select('*').eq('business_id', bizId).order('booking_date').order('booking_time')
  if (from) q = q.gte('booking_date', from)
  if (to)   q = q.lte('booking_date', to)
  return (await q).data || []
}

const createBooking = async data => sb.from('bookings').insert(data).select().single()

const getBookingById = async id => (await sb.from('bookings').select('*').eq('id', id).single()).data

const updateBookingStatus = async (id, status) => sb.from('bookings').update({ status }).eq('id', id)

const getAvailableSlots = async (bizId, daysAhead = 7) => {
  const schedule = await getSchedule(bizId)
  if (!schedule.length) return null

  const activeSchedule = schedule.filter(s => s.is_active)
  if (!activeSchedule.length) return null

  const today = new Date()
  const slots = {}

  for (let d = 0; d <= daysAhead; d++) {
    const date = new Date(today)
    date.setDate(today.getDate() + d)
    const dow = date.getDay()
    const dayConfig = activeSchedule.find(s => s.day_of_week === dow)
    if (!dayConfig) continue

    const dateStr = date.toISOString().split('T')[0]
    const [oh, om] = dayConfig.open_time.split(':').map(Number)
    const [ch, cm] = dayConfig.close_time.split(':').map(Number)
    const dur = dayConfig.slot_duration || 60
    const openMin  = oh * 60 + om
    const closeMin = ch * 60 + cm

    // Obtener citas ya reservadas ese día (con su duración real)
    const booked = (await sb.from('bookings').select('booking_time, duration_minutes')
      .eq('business_id', bizId).eq('booking_date', dateStr)
      .neq('status', 'cancelled')).data || []
    // Rangos ocupados [inicioMin, finMin) según la duración de cada cita
    const occupied = booked.map(b => {
      const [bh, bm] = b.booking_time.split(':').map(Number)
      const start = bh * 60 + bm
      return [start, start + (b.duration_minutes || dur)]
    })
    const isFree = min => !occupied.some(([s, e]) => min >= s && min < e)

    const daySlots = []
    for (let min = openMin; min + dur <= closeMin; min += dur) {
      const hh = String(Math.floor(min / 60)).padStart(2, '0')
      const mm = String(min % 60).padStart(2, '0')
      const time = `${hh}:${mm}`
      if (isFree(min)) {
        // Skip slots en el pasado para hoy
        if (d === 0 && min <= today.getHours() * 60 + today.getMinutes()) continue
        daySlots.push(time)
      }
    }
    if (daySlots.length) {
      const label = d === 0 ? 'Hoy' : d === 1 ? 'Mañana' : `${DAYS_ES[dow]} ${date.getDate()}/${date.getMonth()+1}`
      slots[dateStr] = { label, slots: daySlots }
    }
  }
  return Object.keys(slots).length ? slots : null
}

const updateClientUser = async (bizId, email, passwordHash) => {
  // El usuario DUEÑO del negocio (el que gestiona el admin). Un negocio puede tener
  // varios usuarios; el dueño es el de role='owner'.
  const { data: existing } = await sb.from('client_users').select('id').eq('business_id', bizId).eq('role', 'owner').single()
  if (existing) {
    const upd = { email }
    if (passwordHash) upd.password_hash = passwordHash
    await sb.from('client_users').update(upd).eq('id', existing.id)
  } else {
    await sb.from('client_users').insert({ business_id: bizId, email, password_hash: passwordHash, role: 'owner' })
  }
}

// ── SUB-USUARIOS (empleados) — todo filtrado por business_id ──
const getClientUsers = async bizId =>
  (await sb.from('client_users').select('id,email,name,role,permissions,created_at').eq('business_id', bizId).order('created_at')).data || []
const getClientUserById = async (bizId, id) =>
  (await sb.from('client_users').select('*').eq('business_id', bizId).eq('id', id).single()).data
// Solo se editan/borran EMPLEADOS por esta vía (protege al dueño)
const updateClientUserById = async (bizId, id, fields) =>
  sb.from('client_users').update(fields).eq('business_id', bizId).eq('id', id).eq('role', 'employee')
const deleteClientUserById = async (bizId, id) =>
  sb.from('client_users').delete().eq('business_id', bizId).eq('id', id).eq('role', 'employee')

// ── VENTAS Y REPORTES ─────────────────────────────────────
// Toda función filtra por business_id (aislamiento multi-tenant).
const createSale   = async data  => sb.from('sales').insert(data).select().single()
const addSaleItems = async items => sb.from('sale_items').insert(items)
const getSaleById  = async (bizId, id) =>
  (await sb.from('sales').select('*, sale_items(*)').eq('business_id', bizId).eq('id', id).single()).data
const getSalesByContact = async (bizId, phone) =>
  (await sb.from('sales').select('*, sale_items(*)').eq('business_id', bizId).eq('contact_phone', phone)
    .order('sold_at', { ascending: false }).limit(10)).data || []
// Todas las ventas completadas (solo cliente + fecha) — para clientes nuevos/recurrentes
const getSaleCustomers = async bizId =>
  (await sb.from('sales').select('contact_phone, sold_at').eq('business_id', bizId).eq('status', 'completada')).data || []
// Ventas completadas con nombre/monto — para el directorio de clientes
const getCustomerSales = async bizId =>
  (await sb.from('sales').select('contact_phone, contact_name, total, sold_at').eq('business_id', bizId).eq('status', 'completada')).data || []
// Registrar consultas de productos (un evento por producto mencionado por el cliente)
const recordConsultations = async (bizId, productIds) => {
  if (!Array.isArray(productIds) || !productIds.length) return
  const rows = productIds.map(pid => ({ business_id: bizId, product_id: pid }))
  return sb.from('product_consultations').insert(rows)
}
// Consultas en un rango, con el nombre del producto (para "más consultados"/"abandonados")
const getConsultationsInRange = async (bizId, from, to) => {
  let q = sb.from('product_consultations').select('product_id, products(name)').eq('business_id', bizId)
  if (from) q = q.gte('created_at', from)
  if (to)   q = q.lte('created_at', to)
  return (await q).data || []
}
// Nº de clientes distintos que escribieron (rol 'user') en un rango — denominador de conversión
const getWritersInRange = async (bizId, from, to) => {
  let q = sb.from('conversation_history').select('contact_phone').eq('business_id', bizId).eq('role', 'user')
  if (from) q = q.gte('created_at', from)
  if (to)   q = q.lte('created_at', to)
  const { data } = await q
  return new Set((data || []).map(r => r.contact_phone).filter(Boolean)).size
}
const voidSale     = async (bizId, id) =>
  sb.from('sales').update({ status: 'anulada' }).eq('business_id', bizId).eq('id', id).eq('status', 'completada')

// Ventas completadas en un rango, con su detalle de ítems (base de casi todos los reportes)
const getSalesWithItems = async (bizId, from, to) => {
  let q = sb.from('sales').select('*, sale_items(*)').eq('business_id', bizId).eq('status', 'completada')
  if (from) q = q.gte('sold_at', from)
  if (to)   q = q.lte('sold_at', to)
  return (await q.order('sold_at', { ascending: false })).data || []
}

// Productos con stock bajo o agotado (en este proyecto 'stock' es un estado de texto)
const getLowStockProducts = async bizId =>
  (await sb.from('products').select('name, stock, price').eq('business_id', bizId).eq('active', true)
    .in('stock', ['agotado', 'últimas unidades']).order('stock')).data || []

// Pedidos pendientes: conversaciones que entraron en venta (modo manual) sin venta registrada
const getPendingOrders = async bizId => {
  const [sessions, sold] = await Promise.all([
    sb.from('conversation_sessions').select('contact_phone, contact_name, last_message, last_message_at')
      .eq('business_id', bizId).eq('manual_mode', true),
    sb.from('sales').select('contact_phone').eq('business_id', bizId).eq('status', 'completada')
  ])
  const soldPhones = new Set((sold.data || []).map(s => s.contact_phone))
  return (sessions.data || [])
    .filter(s => !soldPhones.has(s.contact_phone))
    .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))
}

module.exports = {
  getBusinessById, getBusinessBySlug, getBusinessByPhone, getAllBusinesses, createBusiness, updateBusiness, suspendBusiness, reactivateBusiness, deleteBusiness, getExpiredBusinesses,
  createSale, addSaleItems, getSaleById, getSalesByContact, voidSale, getSalesWithItems, getLowStockProducts, getPendingOrders,
  getSaleCustomers, getCustomerSales, getWritersInRange,
  recordConsultations, getConsultationsInRange,
  getClientByEmail, getClientUserByBusiness, createClientUser, updateClientUser,
  getClientUsers, getClientUserById, updateClientUserById, deleteClientUserById,
  getProducts, getProductById, createProduct, updateProduct, deleteProduct,
  countProducts, setProductEmbedding, getProductsWithoutEmbedding, searchProductsByVector,
  getPolicies, upsertPolicies,
  getConversations, getContactHistory, saveMessage,
  clearSimHistory,
  getSession, getSessions, upsertSession,
  getBilling, createBilling, createBillingBatch, updateBillingStatus, generateYearBilling, countBilling, updatePendingBilling,
  getAdminStats, getClientStats,
  getSchedule, upsertSchedule, getBookings, createBooking, getBookingById, updateBookingStatus, getAvailableSlots
}
