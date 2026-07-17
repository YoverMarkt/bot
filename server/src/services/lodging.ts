import crypto from 'node:crypto'

export type LodgingPricingModel =
  | 'per_unit'
  | 'per_person'
  | 'base_plus_extra'
  | 'manual'

export type LodgingErrorCode =
  | 'invalid_input'
  | 'lodging_disabled'
  | 'quote_not_found'
  | 'quote_expired'
  | 'unavailable'
  | 'manual_quote'
  | 'room_type_not_found'
  | 'database_error'

type DataRecord = Record<string, unknown>

interface DatabaseResponse {
  data?: unknown
  error?: { code?: string; message?: string } | null
}

interface LodgingDatabase {
  createLodgingQuote(input: DataRecord): Promise<DatabaseResponse>
  getLatestLodgingQuote(
    businessId: string,
    contactPhone: string,
  ): Promise<DataRecord | null>
  createLodgingRequest(input: DataRecord): Promise<DatabaseResponse>
}

export interface QuoteLodgingInput {
  businessId: string
  contactPhone: string
  contactName?: string | null
  checkIn: string
  checkOut: string
  adults: number
  children: number
  roomsCount?: number
  idempotencyKey?: string | null
}

export interface LodgingQuoteOption {
  roomTypeId: string
  name: string
  description: string | null
  maxGuests: number
  availableUnits: number
  unitsRequired: number
  pricingModel: LodgingPricingModel
  currency: string
  pricesIncludeTax: boolean
  subtotal: number | null
  tax: number | null
  fees: number | null
  total: number | null
  amenities: string[]
  mediaUrls: string[]
  nightlyRates: unknown[]
  summary: {
    checkIn: string
    checkOut: string
    nights: number
    adults: number
    children: number
    guests: number
    roomsCount: number
    unitsRequired: number
  }
}

export interface LodgingQuote {
  quoteId: string
  checkIn: string
  checkOut: string
  checkInTime: string
  checkOutTime: string
  adults: number
  children: number
  roomsCount: number
  nights: number
  expiresAt: string
  options: LodgingQuoteOption[]
}

export interface RequestLodgingInput {
  businessId: string
  contactPhone: string
  contactName?: string | null
  roomTypeId?: string | null
  roomTypeName?: string | null
  notes?: string | null
}

export interface LodgingRequest {
  requestId: string
  quoteId: string
  status: 'pending_owner'
  roomTypeId: string
  roomTypeName: string
  checkIn: string
  checkOut: string
  checkInTime: string
  checkOutTime: string
  adults: number
  children: number
  nights: number
  unitsRequired: number
  currency: string
  subtotal: number
  tax: number
  fees: number
  total: number
  expiresAt: string
}

export type RequestLodgingResult =
  | { ok: true; request: LodgingRequest }
  | { ok: false; error: { code: LodgingErrorCode; message: string } }

export class LodgingServiceError extends Error {
  readonly code: LodgingErrorCode

  constructor(code: LodgingErrorCode, message: string) {
    super(message)
    this.name = 'LodgingServiceError'
    this.code = code
  }
}

const ERROR_MESSAGES: Record<LodgingErrorCode, string> = {
  invalid_input: 'Los datos de hospedaje son inválidos.',
  lodging_disabled: 'Este negocio no tiene habilitado el módulo de hospedaje.',
  quote_not_found: 'No se encontró una cotización vigente para este contacto.',
  quote_expired: 'La cotización venció. Es necesario consultar disponibilidad otra vez.',
  unavailable: 'La opción elegida ya no tiene disponibilidad para todas las noches.',
  manual_quote: 'Esta opción requiere que el equipo confirme el precio manualmente.',
  room_type_not_found: 'No se pudo identificar el tipo de habitación elegido.',
  database_error: 'No se pudo procesar la solicitud de hospedaje.',
}

function fail(code: LodgingErrorCode): LodgingServiceError {
  return new LodgingServiceError(code, ERROR_MESSAGES[code])
}

function record(value: unknown): DataRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as DataRecord
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function nullableMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function normalizedTime(value: unknown, fallback: string): string {
  const raw = stringValue(value)
  return /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)
    ? raw.slice(0, 5)
    : fallback
}

function daysBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`))
      / 86_400_000,
  )
}

function assertQuoteInput(input: QuoteLodgingInput): number {
  const nights = daysBetween(input.checkIn, input.checkOut)
  if (!input.businessId.trim() || !input.contactPhone.trim()
    || input.contactPhone.length > 120
    || !isIsoDate(input.checkIn) || !isIsoDate(input.checkOut)
    || !Number.isInteger(input.adults) || input.adults < 1 || input.adults > 100
    || !Number.isInteger(input.children) || input.children < 0 || input.children > 100
    || input.adults + input.children > 100
    || nights < 1 || nights > 365
    || (input.roomsCount !== undefined
      && (!Number.isInteger(input.roomsCount) || input.roomsCount < 1 || input.roomsCount > 100))) {
    throw fail('invalid_input')
  }
  return nights
}

function normalizePricingModel(value: unknown): LodgingPricingModel {
  return ['per_unit', 'per_person', 'base_plus_extra', 'manual'].includes(String(value))
    ? value as LodgingPricingModel
    : 'manual'
}

function normalizeOption(
  rawValue: unknown,
  quote: Omit<LodgingQuote, 'options'>,
): LodgingQuoteOption | null {
  const raw = record(rawValue)
  const roomTypeId = stringValue(raw.room_type_id || raw.roomTypeId || raw.id)
  const name = stringValue(raw.name || raw.room_type_name || raw.roomTypeName)
  if (!roomTypeId || !name) return null
  const unitsRequired = finiteNumber(raw.units_required || raw.unitsRequired, 1)
  const amenities = raw.amenities ?? []
  const mediaUrls = raw.media_urls ?? raw.mediaUrls ?? []
  const nightlyRates = raw.nightly_rates ?? raw.nightlyRates ?? raw.nightly_breakdown ?? []
  const normalizedMedia = stringList(mediaUrls)
  const legacyImage = stringValue(raw.image_url)
  if (legacyImage && !normalizedMedia.includes(legacyImage)) normalizedMedia.push(legacyImage)
  return {
    roomTypeId,
    name,
    description: stringValue(raw.description) || null,
    maxGuests: finiteNumber(raw.max_guests || raw.maxGuests),
    availableUnits: raw.available === false || raw.closed === true
      ? 0
      : finiteNumber(raw.available_units || raw.availableUnits),
    unitsRequired,
    pricingModel: normalizePricingModel(raw.pricing_model || raw.pricingModel),
    currency: stringValue(raw.currency) || 'USD',
    pricesIncludeTax: raw.prices_include_tax !== false,
    subtotal: nullableMoney(raw.subtotal),
    tax: nullableMoney(raw.tax),
    fees: nullableMoney(raw.fees),
    total: nullableMoney(raw.total),
    amenities: stringList(amenities),
    mediaUrls: normalizedMedia,
    nightlyRates: arrayValue(nightlyRates),
    summary: {
      checkIn: quote.checkIn,
      checkOut: quote.checkOut,
      nights: quote.nights,
      adults: quote.adults,
      children: quote.children,
      guests: quote.adults + quote.children,
      roomsCount: quote.roomsCount,
      unitsRequired,
    },
  }
}

function rpcErrorCode(error: DatabaseResponse['error']): LodgingErrorCode {
  if (error?.code === '42501') return 'lodging_disabled'
  if (error?.code === '22023' || error?.code === '23514') return 'invalid_input'
  return 'database_error'
}

function responseCode(value: unknown): LodgingErrorCode {
  const code = String(value)
  if (code === 'expired') return 'quote_expired'
  if (code === 'not_found') return 'room_type_not_found'
  if (code in ERROR_MESSAGES) return code as LodgingErrorCode
  return 'database_error'
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function requestFailure(code: LodgingErrorCode): RequestLodgingResult {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } }
}

export function createLodgingService(database: LodgingDatabase) {
  async function quoteLodging(input: QuoteLodgingInput): Promise<LodgingQuote> {
    const expectedNights = assertQuoteInput(input)
    const { data, error } = await database.createLodgingQuote({
      business_id: input.businessId,
      contact_phone: input.contactPhone.trim(),
      contact_name: input.contactName?.trim() || null,
      check_in: input.checkIn,
      check_out: input.checkOut,
      adults: input.adults,
      children: input.children,
      rooms_count: input.roomsCount || 1,
      idempotency_key: input.idempotencyKey || null,
    })
    if (error) throw fail(rpcErrorCode(error))

    const payload = record(data)
    if (payload.result && payload.result !== 'quoted') {
      throw fail(responseCode(payload.result))
    }
    const rawQuote = record(payload.quote || payload)
    const firstRawOption = record(arrayValue(payload.options || rawQuote.options)[0])
    const quote: Omit<LodgingQuote, 'options'> = {
      quoteId: stringValue(rawQuote.id || rawQuote.quote_id || payload.quote_id),
      checkIn: stringValue(rawQuote.check_in) || input.checkIn,
      checkOut: stringValue(rawQuote.check_out) || input.checkOut,
      checkInTime: normalizedTime(
        rawQuote.check_in_time || payload.check_in_time || firstRawOption.check_in_time,
        '15:00',
      ),
      checkOutTime: normalizedTime(
        rawQuote.check_out_time || payload.check_out_time || firstRawOption.check_out_time,
        '11:00',
      ),
      adults: finiteNumber(rawQuote.adults, input.adults),
      children: finiteNumber(rawQuote.children, input.children),
      roomsCount: finiteNumber(rawQuote.rooms_count, input.roomsCount || 1),
      nights: finiteNumber(rawQuote.nights, expectedNights),
      expiresAt: stringValue(rawQuote.expires_at || payload.expires_at),
    }
    if (!quote.quoteId || !quote.expiresAt) throw fail('database_error')
    const rawOptions = arrayValue(payload.options || rawQuote.options)
    return {
      ...quote,
      options: rawOptions
        .map(option => normalizeOption(option, quote))
        .filter((option): option is LodgingQuoteOption => option !== null),
    }
  }

  async function requestLodging(
    input: RequestLodgingInput,
  ): Promise<RequestLodgingResult> {
    if (!input.businessId.trim() || !input.contactPhone.trim()) {
      return requestFailure('invalid_input')
    }

    try {
      const quote = await database.getLatestLodgingQuote(
        input.businessId,
        input.contactPhone.trim(),
      )
      if (!quote) return requestFailure('quote_not_found')
      const expiresAt = stringValue(quote.expires_at)
      if (!expiresAt || Date.parse(expiresAt) <= Date.now()) {
        return requestFailure('quote_expired')
      }

      const options = arrayValue(quote.options).map(record)
      const requestedName = normalizeName(input.roomTypeName || '')
      const option = options.find((candidate) => (
        (input.roomTypeId && String(candidate.room_type_id) === input.roomTypeId)
        || (requestedName && normalizeName(String(candidate.name || '')) === requestedName)
      )) || (!input.roomTypeId && !requestedName && options.length === 1 ? options[0] : null)
      if (!option) return requestFailure('room_type_not_found')
      if (normalizePricingModel(option.pricing_model) === 'manual') {
        return requestFailure('manual_quote')
      }

      const quoteId = stringValue(quote.id)
      const roomTypeId = stringValue(option.room_type_id)
      if (!quoteId || !roomTypeId) return requestFailure('database_error')
      const idempotencyKey = crypto.createHash('sha256').update([
        input.businessId,
        input.contactPhone.trim(),
        quoteId,
        roomTypeId,
      ].join(':')).digest('hex')
      const { data, error } = await database.createLodgingRequest({
        business_id: input.businessId,
        quote_id: quoteId,
        room_type_id: roomTypeId,
        contact_phone: input.contactPhone.trim(),
        contact_name: input.contactName?.trim() || null,
        idempotency_key: idempotencyKey,
        notes: input.notes?.trim() || null,
      })
      if (error) return requestFailure(rpcErrorCode(error))

      const payload = record(data)
      if (!['created', 'duplicate'].includes(String(payload.result))) {
        return requestFailure(responseCode(payload.result))
      }
      const request = record(payload.request)
      const mapped: LodgingRequest = {
        requestId: stringValue(request.id || request.request_id),
        quoteId: stringValue(request.quote_id) || quoteId,
        status: 'pending_owner',
        roomTypeId: stringValue(request.room_type_id) || roomTypeId,
        roomTypeName: stringValue(request.room_type_name) || stringValue(option.name),
        checkIn: stringValue(request.check_in) || stringValue(quote.check_in),
        checkOut: stringValue(request.check_out) || stringValue(quote.check_out),
        checkInTime: normalizedTime(
          request.check_in_time || option.check_in_time,
          '15:00',
        ),
        checkOutTime: normalizedTime(
          request.check_out_time || option.check_out_time,
          '11:00',
        ),
        adults: finiteNumber(request.adults, finiteNumber(quote.adults)),
        children: finiteNumber(request.children, finiteNumber(quote.children)),
        nights: finiteNumber(request.nights, finiteNumber(quote.nights)),
        unitsRequired: finiteNumber(
          request.units_required,
          finiteNumber(option.units_required, 1),
        ),
        currency: stringValue(request.currency) || stringValue(option.currency) || 'USD',
        subtotal: finiteNumber(request.subtotal),
        tax: finiteNumber(request.tax),
        fees: finiteNumber(request.fees),
        total: finiteNumber(request.total),
        expiresAt: stringValue(request.expires_at),
      }
      if (!mapped.requestId || !mapped.expiresAt) return requestFailure('database_error')
      return { ok: true, request: mapped }
    } catch {
      return requestFailure('database_error')
    }
  }

  return { quoteLodging, requestLodging }
}

const database = require('../db') as LodgingDatabase
const lodgingService = createLodgingService(database)

export const quoteLodging = lodgingService.quoteLodging
export const requestLodging = lodgingService.requestLodging
