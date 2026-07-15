import { api } from '../../api/client'

export type LodgingPricingModel = 'per_unit' | 'per_person' | 'base_plus_extra' | 'manual'

export type LodgingSettings = {
  currency: string
  check_in_time: string
  check_out_time: string
  quote_expiry_minutes: number
  hold_minutes: number
  tax_rate: number
  service_fee: number
  prices_include_tax: boolean
}

export type LodgingRoomType = {
  id: string
  name: string
  description: string | null
  amenities: string[]
  media_urls: string[]
  total_units: number
  max_guests: number
  pricing_model: LodgingPricingModel
  base_occupancy: number
  base_rate: number | string | null
  weekend_rate: number | string | null
  extra_adult_rate: number | string | null
  child_rate: number | string | null
  active: boolean
}

export type LodgingRoomTypePayload = Omit<LodgingRoomType, 'id'>

export type LodgingRateOverride = {
  id: string
  room_type_id: string
  rate_date: string
  base_rate: number | string | null
  extra_adult_rate: number | string | null
  child_rate: number | string | null
  closed: boolean
}

export type LodgingBlock = {
  id: string
  room_type_id: string
  room_type_name?: string | null
  check_in: string
  check_out: string
  units: number
  kind: 'manual' | 'external' | 'maintenance'
  notes: string | null
}

export type LodgingRequestStatus =
  | 'pending_owner'
  | 'confirmed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

export type LodgingRequest = {
  id: string
  contact_name: string | null
  contact_phone: string
  room_type_id: string
  room_type_name?: string | null
  check_in: string
  check_out: string
  adults: number
  children: number
  units: number
  nights: number
  status: LodgingRequestStatus
  currency: string
  subtotal: number | string | null
  tax: number | string | null
  fees: number | string | null
  total: number | string | null
  expires_at: string | null
  created_at: string
}

export type LodgingStatusResult = {
  request: LodgingRequest
  notificationSent: boolean
  changed: boolean
}

export type AvailabilityOption = {
  roomTypeId: string
  roomTypeName: string
  availableUnits: number
  unitsRequired: number
  maxGuests: number
  pricingModel: LodgingPricingModel
  currency: string
  subtotal: number | null
  tax: number | null
  fees: number | null
  total: number | null
}

export type AvailabilityResult = {
  nights: number
  options: AvailabilityOption[]
}

type LodgingQuoteResponse = {
  nights: number
  options: Array<{
    roomTypeId: string
    name: string
    availableUnits: number
    unitsRequired: number
    maxGuests: number
    pricingModel: LodgingPricingModel
    currency: string
    subtotal: number | null
    tax: number | null
    fees: number | null
    total: number | null
  }>
}

const normalizeSettings = (settings: LodgingSettings): LodgingSettings => ({
  ...settings,
  check_in_time: String(settings.check_in_time || '').slice(0, 5),
  check_out_time: String(settings.check_out_time || '').slice(0, 5),
})

export const getLodgingSettings = async () =>
  normalizeSettings(await api<LodgingSettings>('/api/client/lodging/settings'))

export const saveLodgingSettings = async (settings: LodgingSettings) =>
  normalizeSettings(await api<LodgingSettings>('/api/client/lodging/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }))

export const getRoomTypes = () =>
  api<LodgingRoomType[]>('/api/client/lodging/room-types?includeInactive=true')

export const createRoomType = (payload: LodgingRoomTypePayload) =>
  api<LodgingRoomType>('/api/client/lodging/room-types', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const updateRoomType = (id: string, payload: LodgingRoomTypePayload) =>
  api<LodgingRoomType>(`/api/client/lodging/room-types/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })

export const deleteRoomType = (id: string) =>
  api(`/api/client/lodging/room-types/${id}`, { method: 'DELETE' })

export const getRateOverrides = () =>
  api<LodgingRateOverride[]>('/api/client/lodging/rate-overrides')

export const saveRateOverride = (payload: Omit<LodgingRateOverride, 'id'>) =>
  api<LodgingRateOverride>('/api/client/lodging/rate-overrides', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const deleteRateOverride = (id: string) =>
  api(`/api/client/lodging/rate-overrides/${id}`, { method: 'DELETE' })

export const checkAvailability = async (payload: {
  check_in: string
  check_out: string
  rooms: number
  adults: number
  children: number
}): Promise<AvailabilityResult> => {
  const quote = await api<LodgingQuoteResponse>('/api/client/lodging/availability', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return {
    nights: quote.nights,
    options: quote.options.map(option => ({
      roomTypeId: option.roomTypeId,
      roomTypeName: option.name,
      availableUnits: option.availableUnits,
      unitsRequired: option.unitsRequired,
      maxGuests: option.maxGuests,
      pricingModel: option.pricingModel,
      currency: option.currency,
      subtotal: option.subtotal,
      tax: option.tax,
      fees: option.fees,
      total: option.total,
    })),
  }
}

export const getLodgingRequests = async (): Promise<LodgingRequest[]> => {
  const rows = await api<Array<Record<string, unknown>>>('/api/client/lodging/requests')
  return rows.map(row => ({
    ...row,
    units: Number(row.units_required ?? row.units ?? 0),
  })) as LodgingRequest[]
}

export const setLodgingRequestStatus = (id: string, status: LodgingRequestStatus) =>
  api<LodgingStatusResult>(`/api/client/lodging/requests/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  })

export const getLodgingBlocks = async (): Promise<LodgingBlock[]> => {
  const rows = await api<Array<Record<string, unknown>>>('/api/client/lodging/blocks')
  return rows.map(row => {
    const room = row.lodging_room_types && typeof row.lodging_room_types === 'object'
      ? row.lodging_room_types as Record<string, unknown>
      : null
    return {
      id: String(row.id),
      room_type_id: String(row.room_type_id),
      room_type_name: typeof row.room_type_name === 'string'
        ? row.room_type_name
        : typeof room?.name === 'string' ? room.name : null,
      check_in: String(row.start_date ?? row.check_in ?? ''),
      check_out: String(row.end_date ?? row.check_out ?? ''),
      units: Number(row.quantity ?? row.units ?? 0),
      kind: row.kind as LodgingBlock['kind'],
      notes: typeof row.notes === 'string' ? row.notes : null,
    }
  })
}

export const createLodgingBlock = (payload: Omit<LodgingBlock, 'id' | 'room_type_name'>) =>
  api<LodgingBlock>('/api/client/lodging/blocks', {
    method: 'POST',
    body: JSON.stringify({
      room_type_id: payload.room_type_id,
      start_date: payload.check_in,
      end_date: payload.check_out,
      quantity: payload.units,
      kind: payload.kind,
      notes: payload.notes,
    }),
  })

export const deleteLodgingBlock = (id: string) =>
  api(`/api/client/lodging/blocks/${id}`, { method: 'DELETE' })
