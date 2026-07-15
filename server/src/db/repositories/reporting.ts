import type { SupabaseClient } from '@supabase/supabase-js'

interface PendingSession {
  contact_phone?: string | null
  last_message_at?: string | null
}

const db = require('../client') as SupabaseClient

const recordConsultations = async (businessId: string, productIds: unknown[]) => {
  if (!Array.isArray(productIds) || !productIds.length) return undefined
  return db.from('product_consultations').insert(
    productIds.map(productId => ({ business_id: businessId, product_id: productId })),
  )
}

const getConsultationsInRange = async (businessId: string, from?: unknown, to?: unknown) => {
  let query = db.from('product_consultations').select('product_id, products(name)')
    .eq('business_id', businessId)
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data || []
}

const getWritersInRange = async (businessId: string, from?: unknown, to?: unknown) => {
  let query = db.from('conversation_history').select('contact_phone')
    .eq('business_id', businessId).eq('role', 'user')
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return new Set((data || [])
    .map(row => String(row.contact_phone || '').replace(/\D/g, '').slice(-9))
    .filter(Boolean)).size
}

const getUserMessagesInRange = async (businessId: string, from?: unknown, to?: unknown) => {
  let query = db.from('conversation_history').select('content, contact_phone, created_at')
    .eq('business_id', businessId).eq('role', 'user')
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data || []
}

const getHistoryInRange = async (businessId: string, from?: unknown, to?: unknown) => {
  let query = db.from('conversation_history').select('contact_phone, role, created_at')
    .eq('business_id', businessId)
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data || []
}

const recordAiGap = async (
  businessId: string,
  phone: string,
  question: unknown,
  reason = 'uncertain',
) => {
  const normalizedQuestion = String(question || '').trim().slice(0, 500)
  if (!normalizedQuestion) return undefined
  return db.from('ai_gaps').insert({
    business_id: businessId,
    contact_phone: phone,
    question: normalizedQuestion,
    reason,
  })
}

const getAiGaps = async (businessId: string, from?: unknown, to?: unknown) => {
  let query = db.from('ai_gaps').select('question, contact_phone, created_at')
    .eq('business_id', businessId)
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)
  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

const getLowStockProducts = async (businessId: string) => {
  const { data, error } = await db.from('products').select('name, stock, price')
    .eq('business_id', businessId).eq('active', true)
    .in('stock', ['agotado', 'últimas unidades']).order('stock')
  if (error) throw new Error(error.message)
  return data || []
}

const getPendingOrders = async (businessId: string) => {
  const [sessionsResult, soldResult] = await Promise.all([
    db.from('conversation_sessions')
      .select('contact_phone, contact_name, last_message, last_message_at')
      .eq('business_id', businessId).eq('manual_mode', true),
    db.from('sales').select('contact_phone')
      .eq('business_id', businessId).eq('status', 'completada'),
  ])
  if (sessionsResult.error) throw new Error(sessionsResult.error.message)
  if (soldResult.error) throw new Error(soldResult.error.message)
  const soldPhones = new Set((soldResult.data || []).map(sale => sale.contact_phone))
  return ((sessionsResult.data || []) as PendingSession[])
    .filter(session => !soldPhones.has(session.contact_phone))
    .sort((left, right) => (
      new Date(right.last_message_at || 0).getTime()
      - new Date(left.last_message_at || 0).getTime()
    ))
}

export = {
  recordConsultations,
  getConsultationsInRange,
  getWritersInRange,
  getUserMessagesInRange,
  getHistoryInRange,
  recordAiGap,
  getAiGaps,
  getLowStockProducts,
  getPendingOrders,
}
