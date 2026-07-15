import type { SupabaseClient } from '@supabase/supabase-js'

type DataRecord = Record<string, unknown>

const db = require('../client') as SupabaseClient

function tenantPayload(data: DataRecord): DataRecord {
  const safe = { ...data }
  delete safe.id
  delete safe.business_id
  delete safe.created_at
  delete safe.updated_at
  delete safe.released_at
  return safe
}

const getLodgingSettings = async (businessId: string) => {
  const { data, error } = await db
    .from('lodging_settings')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as DataRecord | null
}

const upsertLodgingSettings = async (businessId: string, data: DataRecord) => db
  .from('lodging_settings')
  .upsert({ ...tenantPayload(data), business_id: businessId }, {
    onConflict: 'business_id',
  })
  .select()
  .single()

const getLodgingRoomTypes = async (
  businessId: string,
  includeInactive = false,
) => {
  let query = db
    .from('lodging_room_types')
    .select('*')
    .eq('business_id', businessId)
    .order('name')
  if (!includeInactive) query = query.eq('active', true)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data || []) as DataRecord[]
}

const getLodgingRoomTypeById = async (businessId: string, id: string) => {
  const { data, error } = await db
    .from('lodging_room_types')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as DataRecord | null
}

const createLodgingRoomType = async (businessId: string, data: DataRecord) => db
  .from('lodging_room_types')
  .insert({ ...tenantPayload(data), business_id: businessId })
  .select()
  .single()

const updateLodgingRoomType = async (
  businessId: string,
  id: string,
  data: DataRecord,
) => db
  .from('lodging_room_types')
  .update({ ...tenantPayload(data), updated_at: new Date().toISOString() })
  .eq('business_id', businessId)
  .eq('id', id)
  .select()
  .maybeSingle()

const archiveLodgingRoomType = async (businessId: string, id: string) => db
  .from('lodging_room_types')
  .update({ active: false, updated_at: new Date().toISOString() })
  .eq('business_id', businessId)
  .eq('id', id)
  .select()
  .maybeSingle()

const getLodgingRateOverrides = async (
  businessId: string,
  roomTypeId?: string | null,
  from?: string | null,
  to?: string | null,
) => {
  let query = db
    .from('lodging_rate_overrides')
    .select('*')
    .eq('business_id', businessId)
    .order('rate_date')
  if (roomTypeId) query = query.eq('room_type_id', roomTypeId)
  if (from) query = query.gte('rate_date', from)
  if (to) query = query.lte('rate_date', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data || []) as DataRecord[]
}

const createLodgingRateOverride = async (
  businessId: string,
  data: DataRecord,
) => db
  .from('lodging_rate_overrides')
  .upsert({ ...tenantPayload(data), business_id: businessId }, {
    onConflict: 'business_id,room_type_id,rate_date',
  })
  .select()
  .single()

const updateLodgingRateOverride = async (
  businessId: string,
  id: string,
  data: DataRecord,
) => db
  .from('lodging_rate_overrides')
  .update({ ...tenantPayload(data), updated_at: new Date().toISOString() })
  .eq('business_id', businessId)
  .eq('id', id)
  .select()
  .maybeSingle()

const deleteLodgingRateOverride = async (businessId: string, id: string) => db
  .from('lodging_rate_overrides')
  .delete()
  .eq('business_id', businessId)
  .eq('id', id)
  .select('id')
  .maybeSingle()

const createLodgingQuote = async (input: DataRecord) => db.rpc(
  'quote_lodging_options',
  {
    p_business_id: input.business_id,
    p_contact_phone: input.contact_phone,
    p_contact_name: input.contact_name || null,
    p_check_in: input.check_in,
    p_check_out: input.check_out,
    p_adults: input.adults,
    p_children: input.children,
    p_rooms_count: input.rooms_count || 1,
    p_idempotency_key: input.idempotency_key || null,
  },
)

const getLatestLodgingQuote = async (
  businessId: string,
  contactPhone: string,
) => {
  const { data, error } = await db
    .from('lodging_quotes')
    .select('*')
    .eq('business_id', businessId)
    .eq('contact_phone', contactPhone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as DataRecord | null
}

const createLodgingRequest = async (input: DataRecord) => db.rpc(
  'create_lodging_request_if_available',
  {
    p_business_id: input.business_id,
    p_quote_id: input.quote_id,
    p_room_type_id: input.room_type_id,
    p_contact_phone: input.contact_phone,
    p_contact_name: input.contact_name || null,
    p_idempotency_key: input.idempotency_key,
    p_notes: input.notes || null,
  },
)

const getLodgingRequests = async (
  businessId: string,
  status?: string | null,
  from?: string | null,
  to?: string | null,
) => {
  let query = db
    .from('lodging_requests')
    .select(`
      id, quote_id, room_type_id, room_type_name,
      contact_phone, contact_name,
      check_in, check_out, check_in_time, check_out_time,
      adults, children, units_required, nights, pricing_model,
      subtotal, tax, fees, total, currency, nightly_breakdown,
      status, expires_at, confirmed_at, released_at, notes,
      created_at, updated_at
    `)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)
  if (from) query = query.gte('check_in', from)
  if (to) query = query.lte('check_out', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data || []) as DataRecord[]
}

const expireLodgingHolds = async (businessId: string) => db.rpc(
  'expire_lodging_holds',
  { p_business_id: businessId },
)

const getLodgingRequestById = async (businessId: string, requestId: string) => {
  const { data, error } = await db
    .from('lodging_requests')
    .select(`
      id, quote_id, room_type_id, room_type_name,
      contact_phone, contact_name,
      check_in, check_out, check_in_time, check_out_time,
      adults, children, units_required, nights, pricing_model,
      subtotal, tax, fees, total, currency, nightly_breakdown,
      status, expires_at, confirmed_at, released_at, notes,
      created_at, updated_at
    `)
    .eq('business_id', businessId)
    .eq('id', requestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as DataRecord | null
}

const setLodgingRequestStatus = async (
  businessId: string,
  requestId: string,
  status: string,
) => db.rpc('set_lodging_request_status', {
  p_business_id: businessId,
  p_request_id: requestId,
  p_status: status,
})

const getLodgingBlocks = async (
  businessId: string,
  from?: string | null,
  to?: string | null,
  includeReleased = false,
) => {
  let query = db
    .from('lodging_blocks')
    .select('*, lodging_room_types(name)')
    .eq('business_id', businessId)
    .in('kind', ['manual', 'external', 'maintenance'])
    .is('request_id', null)
    .order('start_date')
  if (!includeReleased) query = query.is('released_at', null)
  if (from) query = query.gt('end_date', from)
  if (to) query = query.lt('start_date', to)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return ((data || []) as DataRecord[]).map((row) => {
    const { lodging_room_types: nested, ...rest } = row
    const roomType = nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested as DataRecord
      : {}
    return { ...rest, room_type_name: roomType.name || null }
  })
}

const upsertLodgingBlock = async (
  businessId: string,
  blockId: string | null,
  data: DataRecord,
) => db.rpc('upsert_lodging_block_if_available', {
  p_business_id: businessId,
  p_block_id: blockId,
  p_room_type_id: data.room_type_id,
  p_kind: data.kind,
  p_start_date: data.start_date,
  p_end_date: data.end_date,
  p_quantity: data.quantity,
  p_notes: data.notes || null,
})

const releaseLodgingBlock = async (businessId: string, blockId: string) => db.rpc(
  'release_lodging_block',
  { p_business_id: businessId, p_block_id: blockId },
)

export = {
  getLodgingSettings,
  upsertLodgingSettings,
  getLodgingRoomTypes,
  getLodgingRoomTypeById,
  createLodgingRoomType,
  updateLodgingRoomType,
  archiveLodgingRoomType,
  getLodgingRateOverrides,
  createLodgingRateOverride,
  updateLodgingRateOverride,
  deleteLodgingRateOverride,
  createLodgingQuote,
  getLatestLodgingQuote,
  createLodgingRequest,
  expireLodgingHolds,
  getLodgingRequests,
  getLodgingRequestById,
  setLodgingRequestStatus,
  getLodgingBlocks,
  upsertLodgingBlock,
  releaseLodgingBlock,
}
