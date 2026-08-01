import crypto from 'node:crypto'
import { FlowDataExchangeError } from './whatsapp-flow-data-exchange'
import { recordFlowMetricBestEffort } from './whatsapp-flow-metrics'

type JsonRecord = Record<string, unknown>

export type LodgingFlowProvider = 'meta' | 'ycloud'

export interface LodgingFlowDataExchangeRequest {
  version?: unknown
  action?: unknown
  screen?: unknown
  data?: unknown
  flow_token?: unknown
}

export interface LodgingFlowDataExchangeResponse {
  screen: string
  data: JsonRecord
}

export interface LodgingFlowSession {
  id: string
  business_id: string
  provider: LodgingFlowProvider
  flow_version_id: string
  status: 'open' | 'submitted' | 'expired' | 'cancelled'
  context: JsonRecord
  context_revision: number
  expires_at: string
  flow?: {
    capability_key?: string | null
  } | null
}

export interface LodgingFlowBusiness extends JsonRecord {
  id: string
  name?: string | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
  lodging_enabled?: boolean | null
}

export interface LodgingFlowHandlerInput {
  request: LodgingFlowDataExchangeRequest
  session: LodgingFlowSession
  business: LodgingFlowBusiness
  flowToken?: string
}

export interface LodgingFlowQuoteOption {
  roomTypeId: string
  name: string
  description?: string | null
  maxGuests: number
  availableUnits: number
  unitsRequired: number
  pricingModel: 'per_unit' | 'per_person' | 'base_plus_extra' | 'manual'
  currency: string
  pricesIncludeTax: boolean
  subtotal: number | null
  tax: number | null
  fees: number | null
  total: number | null
}

export interface LodgingFlowQuote {
  quoteId: string
  businessId?: string | null
  contactPhone?: string | null
  status?: string | null
  checkIn: string
  checkOut: string
  checkInTime: string
  checkOutTime: string
  adults: number
  children: number
  roomsCount: number
  nights: number
  expiresAt: string
  options: LodgingFlowQuoteOption[]
}

export interface LodgingFlowDependencies {
  quoteLodging(input: {
    businessId: string
    contactPhone: string
    checkIn: string
    checkOut: string
    adults: number
    children: number
    roomsCount: number
    idempotencyKey: string
  }): Promise<unknown>
  getLodgingQuoteById(
    businessId: string,
    quoteId: string,
  ): Promise<unknown | null>
  updateFlowSessionContext(
    businessId: string,
    provider: LodgingFlowProvider,
    flowToken: string,
    expectedRevision: number,
    context: JsonRecord,
  ): Promise<unknown>
  recordFlowMetric(input: {
    businessId: string
    provider: LodgingFlowProvider
    flowVersionId: string
    sessionId: string
    eventType: string
    sourceKey: string
    metadata: JsonRecord
  }): Promise<unknown>
  now?(): number
}

interface LodgingSearchContext extends JsonRecord {
  fingerprint: string
  check_in: string
  check_out: string
  adults: number
  children: number
  rooms_count: number
  quote_id: string
  quote_expires_at: string
}

interface LodgingDraftContext extends JsonRecord {
  quote_id: string
  room_type_id: string
  contact_name: string
  notes: string | null
}

interface CanonicalStayInput {
  checkIn: string
  checkOut: string
  adults: number
  children: number
  roomsCount: number
  nights: number
}

const ECUADOR_TIME_ZONE = 'America/Guayaquil'
const DAY_MS = 86_400_000
const MAX_TOKEN_LENGTH = 512
const MAX_OPTIONS = 200
const MAX_CONTACT_NAME = 120
const MAX_NOTES = 1000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function cleanText(
  value: unknown,
  maximum: number,
  required = false,
): string | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new FlowDataExchangeError(422, 'Completa los campos obligatorios.')
    }
    return null
  }
  if (typeof value !== 'string') {
    throw new FlowDataExchangeError(422, 'Uno de los campos no es válido.')
  }
  const clean = value.trim()
  if ((required && !clean) || clean.length > maximum) {
    throw new FlowDataExchangeError(422, 'Uno de los campos no es válido.')
  }
  return clean || null
}

function integerField(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = finiteNumber(value)
  if (parsed === null
    || !Number.isInteger(parsed)
    || parsed < minimum
    || parsed > maximum) {
    throw new FlowDataExchangeError(
      422,
      `${label} debe ser un número entre ${minimum} y ${maximum}.`,
    )
  }
  return parsed
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value
}

// Flow JSON 5.0 entrega yyyy-MM-dd. También se tolera el timestamp en
// milisegundos usado por versiones anteriores para que un retry antiguo falle
// de forma segura en el servidor y no por un cambio de representación.
function flowDate(value: unknown): string {
  const raw = text(value)
  if (validIsoDate(raw)) return raw
  if (/^\d{13}$/.test(raw)) {
    const parsed = new Date(Number(raw))
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  }
  throw new FlowDataExchangeError(
    422,
    'Elige fechas válidas de entrada y salida.',
  )
}

function dateAtEcuador(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ECUADOR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now))
  const values = new Map(parts.map(part => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

function addDays(date: string, days: number): string {
  return new Date(
    Date.parse(`${date}T12:00:00.000Z`) + (days * DAY_MS),
  ).toISOString().slice(0, 10)
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(`${checkOut}T00:00:00.000Z`)
      - Date.parse(`${checkIn}T00:00:00.000Z`)) / DAY_MS,
  )
}

function stayInput(
  data: JsonRecord,
  now: number,
): CanonicalStayInput {
  const checkIn = flowDate(data.check_in)
  const checkOut = flowDate(data.check_out)
  const adults = integerField(data.adults, 1, 100, 'Adultos')
  const children = integerField(data.children, 0, 100, 'Niños')
  const roomsCount = integerField(
    data.rooms_count,
    1,
    100,
    'Habitaciones',
  )
  const nights = nightsBetween(checkIn, checkOut)
  if (checkIn < dateAtEcuador(now)) {
    throw new FlowDataExchangeError(
      422,
      'La fecha de entrada no puede estar en el pasado.',
    )
  }
  if (nights < 1 || nights > 365) {
    throw new FlowDataExchangeError(
      422,
      'La estadía debe tener entre 1 y 365 noches.',
    )
  }
  if (adults + children > 100) {
    throw new FlowDataExchangeError(
      422,
      'El grupo no puede superar 100 huéspedes.',
    )
  }
  return {
    checkIn,
    checkOut,
    adults,
    children,
    roomsCount,
    nights,
  }
}

function dateRange(
  data: JsonRecord,
  now: number,
): { checkIn: string; checkOut: string } {
  const checkIn = flowDate(data.check_in)
  const checkOut = flowDate(data.check_out)
  const nights = nightsBetween(checkIn, checkOut)
  if (checkIn < dateAtEcuador(now)) {
    throw new FlowDataExchangeError(
      422,
      'La fecha de entrada no puede estar en el pasado.',
    )
  }
  if (nights < 1 || nights > 365) {
    throw new FlowDataExchangeError(
      422,
      'La estadía debe tener entre 1 y 365 noches.',
    )
  }
  return { checkIn, checkOut }
}

function normalizedTime(value: unknown, fallback: string): string {
  const raw = text(value)
  return /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)
    ? raw.slice(0, 5)
    : fallback
}

function normalizePricingModel(
  value: unknown,
): LodgingFlowQuoteOption['pricingModel'] {
  return ['per_unit', 'per_person', 'base_plus_extra', 'manual']
    .includes(String(value))
    ? value as LodgingFlowQuoteOption['pricingModel']
    : 'manual'
}

function normalizeOption(value: unknown): LodgingFlowQuoteOption | null {
  const raw = record(value)
  const roomTypeId = text(
    raw.room_type_id ?? raw.roomTypeId ?? raw.id,
  ).toLowerCase()
  const name = text(raw.name ?? raw.room_type_name ?? raw.roomTypeName)
  if (!UUID_PATTERN.test(roomTypeId) || !name) return null

  const unitsRequired = finiteNumber(
    raw.units_required ?? raw.unitsRequired,
  )
  const availableUnits = raw.available === false || raw.closed === true
    ? 0
    : finiteNumber(raw.available_units ?? raw.availableUnits)
  if (unitsRequired === null
    || availableUnits === null
    || !Number.isInteger(unitsRequired)
    || !Number.isInteger(availableUnits)
    || unitsRequired < 1
    || availableUnits < unitsRequired) {
    return null
  }

  return {
    roomTypeId,
    name,
    description: text(raw.description) || null,
    maxGuests: finiteNumber(raw.max_guests ?? raw.maxGuests) || 0,
    availableUnits,
    unitsRequired,
    pricingModel: normalizePricingModel(
      raw.pricing_model ?? raw.pricingModel,
    ),
    currency: text(raw.currency).toUpperCase() || 'USD',
    pricesIncludeTax: raw.prices_include_tax !== false
      && raw.pricesIncludeTax !== false,
    subtotal: finiteNumber(raw.subtotal),
    tax: finiteNumber(raw.tax),
    fees: finiteNumber(raw.fees),
    total: finiteNumber(raw.total),
  }
}

function normalizeQuote(value: unknown): LodgingFlowQuote | null {
  const envelope = record(value)
  const raw = Object.keys(record(envelope.quote)).length
    ? record(envelope.quote)
    : envelope
  const quoteId = text(
    raw.id ?? raw.quote_id ?? raw.quoteId ?? envelope.quote_id,
  ).toLowerCase()
  const checkIn = text(raw.check_in ?? raw.checkIn)
  const checkOut = text(raw.check_out ?? raw.checkOut)
  const expiresAt = text(raw.expires_at ?? raw.expiresAt)
  const adults = finiteNumber(raw.adults)
  const children = finiteNumber(raw.children)
  const roomsCount = finiteNumber(raw.rooms_count ?? raw.roomsCount)
  const nights = finiteNumber(raw.nights)
  if (!UUID_PATTERN.test(quoteId)
    || !validIsoDate(checkIn)
    || !validIsoDate(checkOut)
    || !expiresAt
    || adults === null
    || children === null
    || roomsCount === null
    || nights === null) {
    return null
  }
  const rawOptions = array(envelope.options ?? raw.options)
    .map(normalizeOption)
    .filter((option): option is LodgingFlowQuoteOption => option !== null)
  const options = [
    ...new Map(rawOptions.map(option => [option.roomTypeId, option])).values(),
  ]
  return {
    quoteId,
    businessId: text(raw.business_id ?? raw.businessId) || null,
    contactPhone: text(raw.contact_phone ?? raw.contactPhone) || null,
    status: text(raw.status) || null,
    checkIn,
    checkOut,
    checkInTime: normalizedTime(
      raw.check_in_time ?? raw.checkInTime,
      '15:00',
    ),
    checkOutTime: normalizedTime(
      raw.check_out_time ?? raw.checkOutTime,
      '11:00',
    ),
    adults,
    children,
    roomsCount,
    nights,
    expiresAt,
    options,
  }
}

function automaticOptions(
  quote: LodgingFlowQuote,
  preferredRoomTypeId: string | null,
): LodgingFlowQuoteOption[] {
  const options = quote.options.filter(isAutomaticOption)
  if (options.length > MAX_OPTIONS) {
    throw new FlowDataExchangeError(
      409,
      'Hay demasiadas habitaciones para mostrarlas completas aquí. '
      + 'Cierra el formulario y continúa por el chat.',
    )
  }
  return [...options].sort((left, right) => {
    if (!preferredRoomTypeId) return 0
    if (left.roomTypeId === preferredRoomTypeId) return -1
    if (right.roomTypeId === preferredRoomTypeId) return 1
    return 0
  })
}

function isAutomaticOption(option: LodgingFlowQuoteOption): boolean {
  return option.pricingModel !== 'manual'
    && option.total !== null
    && option.total >= 0
}

function optionTitle(value: string): string {
  const clean = value.trim()
  return clean.length <= 30 ? clean : `${clean.slice(0, 29)}…`
}

function headingText(value: unknown): string {
  const clean = text(value)
  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`
}

function money(value: number | null, currency: string): string {
  const amount = value === null || !Number.isFinite(value) ? 0 : value
  try {
    return new Intl.NumberFormat('es-EC', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `$${amount.toFixed(2)} ${currency || 'USD'}`
  }
}

function expiryLabel(expiresAt: string): string {
  const timestamp = Date.parse(expiresAt)
  if (!Number.isFinite(timestamp)) {
    return 'Cotización válida por tiempo limitado.'
  }
  const formatted = new Intl.DateTimeFormat('es-EC', {
    timeZone: ECUADOR_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
  return `Cotización válida hasta ${formatted}. La disponibilidad se comprueba otra vez al enviarla.`
}

function peopleLabel(adults: number, children: number): string {
  return children
    ? `${adults} adulto(s) · ${children} niño(s)`
    : `${adults} adulto(s)`
}

function datesData(
  business: LodgingFlowBusiness,
  now: number,
  errorMessage = '',
): JsonRecord {
  const minimum = dateAtEcuador(now)
  return {
    business_name: headingText(business.name || 'Nuestro alojamiento'),
    min_date: minimum,
    // El backend sigue limitando cada estadía a 365 noches. Dos años de
    // calendario permiten buscar con anticipación sin incrustar una fecha fija.
    max_date: addDays(minimum, 730),
    error_message: errorMessage,
  }
}

function guestsData(
  checkIn: string,
  checkOut: string,
  errorMessage = '',
): JsonRecord {
  return {
    check_in: checkIn,
    check_out: checkOut,
    stay_summary: checkIn && checkOut
      ? `Entrada: ${checkIn} · Salida: ${checkOut}`
      : 'Elige nuevamente las fechas de tu estadía.',
    error_message: errorMessage,
  }
}

function manualOptionCount(quote: LodgingFlowQuote): number {
  return quote.options.filter(option => option.pricingModel === 'manual').length
}

function optionsData(
  quote: LodgingFlowQuote,
  options: LodgingFlowQuoteOption[],
  errorMessage = '',
): JsonRecord {
  const manualCount = manualOptionCount(quote)
  return {
    stay_summary: `${quote.nights} noche(s) · ${peopleLabel(
      quote.adults,
      quote.children,
    )} · mínimo ${quote.roomsCount} habitación(es)`,
    quote_expires_label: expiryLabel(quote.expiresAt),
    room_options: options.map(option => ({
      id: option.roomTypeId,
      title: optionTitle(
        `${option.name} · ${option.unitsRequired} hab. · ${
          money(option.total, option.currency)
        }`,
      ),
    })),
    manual_notice: manualCount
      ? `${manualCount} opción(es) adicional(es) requieren tarifa manual por chat.`
      : '',
    error_message: errorMessage,
  }
}

function detailsData(
  quote: LodgingFlowQuote,
  option: LodgingFlowQuoteOption,
  errorMessage = '',
): JsonRecord {
  return {
    room_type_id: option.roomTypeId,
    chosen_room_summary: [
      option.name,
      `${quote.nights} noche(s) · ${peopleLabel(
        quote.adults,
        quote.children,
      )}`,
      `${option.unitsRequired} habitación(es) · ${
        money(option.total, option.currency)
      }`,
    ].join('\n'),
    quote_expires_label: expiryLabel(quote.expiresAt),
    error_message: errorMessage,
  }
}

function reviewData(
  flowToken: string,
  quote: LodgingFlowQuote,
  option: LodgingFlowQuoteOption,
): JsonRecord {
  const lines = [
    option.name,
    `Entrada: ${quote.checkIn} desde ${quote.checkInTime}`,
    `Salida: ${quote.checkOut} hasta ${quote.checkOutTime}`,
    `${quote.nights} noche(s) · ${peopleLabel(quote.adults, quote.children)}`,
    `${option.unitsRequired} habitación(es)`,
    option.subtotal !== null
      ? `Alojamiento: ${money(option.subtotal, option.currency)}`
      : '',
    option.tax !== null
      ? `${option.pricesIncludeTax ? 'Impuestos incluidos' : 'Impuestos adicionales'}: ${
        money(option.tax, option.currency)
      }`
      : '',
    option.fees !== null && option.fees > 0
      ? `Cargos: ${money(option.fees, option.currency)}`
      : '',
  ].filter(Boolean)
  return {
    flow_token: flowToken,
    summary: lines.join('\n'),
    total: money(option.total, option.currency),
    notice: 'Al enviarla crearás una solicitud pendiente de confirmación del equipo. Todavía no es una reserva confirmada ni un pago.',
  }
}

function contextOf(session: LodgingFlowSession): JsonRecord {
  return record(session.context)
}

function searchOf(context: JsonRecord): LodgingSearchContext | null {
  const raw = record(context.lodging_search)
  const fingerprint = text(raw.fingerprint)
  const checkIn = text(raw.check_in)
  const checkOut = text(raw.check_out)
  const quoteId = text(raw.quote_id).toLowerCase()
  const quoteExpiresAt = text(raw.quote_expires_at)
  const adults = finiteNumber(raw.adults)
  const children = finiteNumber(raw.children)
  const roomsCount = finiteNumber(raw.rooms_count)
  if (!/^[0-9a-f]{64}$/.test(fingerprint)
    || !validIsoDate(checkIn)
    || !validIsoDate(checkOut)
    || !UUID_PATTERN.test(quoteId)
    || !quoteExpiresAt
    || adults === null
    || children === null
    || roomsCount === null) {
    return null
  }
  return {
    fingerprint,
    check_in: checkIn,
    check_out: checkOut,
    adults,
    children,
    rooms_count: roomsCount,
    quote_id: quoteId,
    quote_expires_at: quoteExpiresAt,
  }
}

function draftOf(context: JsonRecord): LodgingDraftContext | null {
  const raw = record(context.lodging_draft)
  const quoteId = text(raw.quote_id).toLowerCase()
  const roomTypeId = text(raw.room_type_id).toLowerCase()
  const contactName = text(raw.contact_name)
  const notes = raw.notes === null ? null : text(raw.notes) || null
  if (!UUID_PATTERN.test(quoteId)
    || !UUID_PATTERN.test(roomTypeId)
    || contactName.length < 2
    || contactName.length > MAX_CONTACT_NAME
    || (notes && notes.length > MAX_NOTES)) {
    return null
  }
  return {
    quote_id: quoteId,
    room_type_id: roomTypeId,
    contact_name: contactName,
    notes,
  }
}

function preferredRoomTypeId(context: JsonRecord): string | null {
  const value = text(context.preferred_room_type_id).toLowerCase()
  return UUID_PATTERN.test(value) ? value : null
}

function sessionAlias(session: LodgingFlowSession): string {
  const alias = `flow-session:${session.id}`
  if (!session.id || alias.length > 80) {
    throw new FlowDataExchangeError(
      410,
      'La sesión del formulario no es válida.',
    )
  }
  return alias
}

function fingerprint(input: CanonicalStayInput): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    check_in: input.checkIn,
    check_out: input.checkOut,
    adults: input.adults,
    children: input.children,
    rooms_count: input.roomsCount,
  })).digest('hex')
}

function flowTokenFrom(input: LodgingFlowHandlerInput): string {
  const raw = input.flowToken ?? input.request.flow_token
  const token = text(raw)
  if (!token
    || token.length > MAX_TOKEN_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new FlowDataExchangeError(
      400,
      'El token del formulario no es válido.',
    )
  }
  return token
}

function validateInput(
  input: LodgingFlowHandlerInput,
  now: number,
): void {
  const { request, session, business } = input
  if (request.version !== '3.0') {
    throw new FlowDataExchangeError(
      400,
      'La versión del formulario no es compatible.',
    )
  }
  const capability = text(session.flow?.capability_key)
  if (capability !== 'lodging' && !capability.startsWith('lodging.')) {
    throw new FlowDataExchangeError(
      403,
      'Este formulario no corresponde a hospedaje.',
    )
  }
  if (session.status !== 'open' || Date.parse(session.expires_at) <= now) {
    throw new FlowDataExchangeError(
      410,
      'La sesión del formulario expiró. Vuelve al chat.',
    )
  }
  if (business.id !== session.business_id
    || business.active === false
    || business.bot_active === false
    || business.suspended === true
    || business.lodging_enabled !== true) {
    throw new FlowDataExchangeError(
      403,
      'El hospedaje no está disponible en este momento.',
    )
  }
}

function quoteMatchesSearch(
  quote: LodgingFlowQuote,
  search: LodgingSearchContext,
): boolean {
  return quote.quoteId === search.quote_id
    && quote.checkIn === search.check_in
    && quote.checkOut === search.check_out
    && quote.adults === search.adults
    && quote.children === search.children
    && quote.roomsCount === search.rooms_count
}

function quoteIsOpen(
  quote: LodgingFlowQuote,
  now: number,
): boolean {
  return (!quote.status || quote.status === 'quoted')
    && Date.parse(quote.expiresAt) > now
}

function recordMetric(
  dependencies: LodgingFlowDependencies,
  session: LodgingFlowSession,
  eventType: string,
  discriminator = '',
): void {
  recordFlowMetricBestEffort(
    dependencies.recordFlowMetric,
    {
      businessId: session.business_id,
      provider: session.provider,
      flowVersionId: session.flow_version_id,
      sessionId: session.id,
      eventType,
      sourceKey: [
        session.id,
        eventType,
        session.context_revision,
        discriminator,
      ].join(':'),
      metadata: {},
    },
  )
}

async function loadContextQuote(
  dependencies: LodgingFlowDependencies,
  session: LodgingFlowSession,
  context: JsonRecord,
  now: number,
): Promise<{
  search: LodgingSearchContext
  quote: LodgingFlowQuote
} | null> {
  const search = searchOf(context)
  if (!search) return null
  const quote = normalizeQuote(
    await dependencies.getLodgingQuoteById(
      session.business_id,
      search.quote_id,
    ),
  )
  if (!quote
    || (quote.businessId && quote.businessId !== session.business_id)
    || (quote.contactPhone
      && quote.contactPhone !== sessionAlias(session))
    || !quoteMatchesSearch(quote, search)
    || !quoteIsOpen(quote, now)) {
    return null
  }
  return { search, quote }
}

function updateResult(value: unknown): {
  result: string
  session: LodgingFlowSession | null
} {
  const raw = record(value)
  const rawSession = record(raw.session)
  return {
    result: text(raw.result),
    session: Object.keys(rawSession).length
      ? rawSession as unknown as LodgingFlowSession
      : null,
  }
}

async function persistContext(
  dependencies: LodgingFlowDependencies,
  input: LodgingFlowHandlerInput,
  flowToken: string,
  context: JsonRecord,
): Promise<{
  result: string
  session: LodgingFlowSession | null
}> {
  const result = updateResult(await dependencies.updateFlowSessionContext(
    input.session.business_id,
    input.session.provider,
    flowToken,
    input.session.context_revision,
    context,
  ))
  if (result.result !== 'updated' && result.result !== 'stale') {
    throw new FlowDataExchangeError(
      410,
      'La sesión del formulario ya no está disponible.',
    )
  }
  return result
}

function knownQuoteError(error: unknown): FlowDataExchangeError | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = text((error as { code?: unknown }).code)
  if (code === 'invalid_input') {
    return new FlowDataExchangeError(
      422,
      'No pudimos validar las fechas o la cantidad de huéspedes.',
    )
  }
  if (code === 'lodging_disabled') {
    return new FlowDataExchangeError(
      403,
      'El hospedaje no está disponible en este momento.',
    )
  }
  if (code === 'quote_expired') {
    return new FlowDataExchangeError(
      409,
      'La cotización venció. Consulta nuevamente la disponibilidad.',
    )
  }
  return null
}

function intentFrom(request: LodgingFlowDataExchangeRequest): string {
  const data = record(request.data)
  if (request.action === 'data_exchange') return text(data.intent)
  return text(request.action)
}

function automaticOptionsOrError(
  quote: LodgingFlowQuote,
  context: JsonRecord,
): {
  options: LodgingFlowQuoteOption[]
  error: string
} {
  const options = automaticOptions(quote, preferredRoomTypeId(context))
  if (options.length) return { options, error: '' }
  return {
    options,
    error: manualOptionCount(quote)
      ? 'Hay disponibilidad, pero estas tarifas deben confirmarse por chat. Cierra el formulario y habla con el equipo.'
      : 'No encontramos habitaciones disponibles para todo ese periodo. Prueba otras fechas.',
  }
}

function quoteStepResponse(
  quote: LodgingFlowQuote,
  context: JsonRecord,
  errorMessage = '',
): LodgingFlowDataExchangeResponse {
  const preferredId = preferredRoomTypeId(context)
  if (preferredId) {
    const selected = quote.options.find(option => (
      option.roomTypeId === preferredId
    ))
    if (selected?.pricingModel === 'manual') {
      return {
        screen: 'LODGING_GUESTS',
        data: guestsData(
          quote.checkIn,
          quote.checkOut,
          'La habitación que elegiste requiere que el equipo confirme la tarifa por chat. Cierra el formulario para continuar con ellos.',
        ),
      }
    }
    if (selected && isAutomaticOption(selected)) {
      // El cliente ya eligió esta habitación en el menú. Conservamos esa
      // decisión y pedimos únicamente sus datos, sin mostrar otro selector.
      return {
        screen: 'LODGING_DETAILS',
        data: detailsData(quote, selected, errorMessage),
      }
    }
  }

  const available = automaticOptionsOrError(quote, context)
  if (!available.options.length) {
    return {
      screen: 'LODGING_GUESTS',
      data: guestsData(
        quote.checkIn,
        quote.checkOut,
        errorMessage || available.error,
      ),
    }
  }
  return {
    screen: 'LODGING_OPTIONS',
    data: optionsData(
      quote,
      available.options,
      errorMessage || (
        preferredId
          ? 'La habitación elegida ya no está disponible. Elige una alternativa.'
          : ''
      ),
    ),
  }
}

async function quoteResponseFromContext(
  dependencies: LodgingFlowDependencies,
  session: LodgingFlowSession,
  context: JsonRecord,
  now: number,
  errorMessage = '',
): Promise<LodgingFlowDataExchangeResponse | null> {
  const current = await loadContextQuote(
    dependencies,
    session,
    context,
    now,
  )
  if (!current) return null
  return quoteStepResponse(current.quote, context, errorMessage)
}

async function staleQuoteResponse(
  dependencies: LodgingFlowDependencies,
  staleSession: LodgingFlowSession | null,
  expectedFingerprint: string,
  now: number,
): Promise<LodgingFlowDataExchangeResponse | null> {
  if (!staleSession) return null
  const context = contextOf(staleSession)
  if (searchOf(context)?.fingerprint !== expectedFingerprint) return null
  return quoteResponseFromContext(
    dependencies,
    staleSession,
    context,
    now,
  )
}

async function staleReviewResponse(
  dependencies: LodgingFlowDependencies,
  staleSession: LodgingFlowSession | null,
  flowToken: string,
  expectedDraft: LodgingDraftContext,
  now: number,
): Promise<LodgingFlowDataExchangeResponse | null> {
  if (!staleSession) return null
  const context = contextOf(staleSession)
  const currentDraft = draftOf(context)
  if (!currentDraft
    || currentDraft.quote_id !== expectedDraft.quote_id
    || currentDraft.room_type_id !== expectedDraft.room_type_id
    || currentDraft.contact_name !== expectedDraft.contact_name
    || currentDraft.notes !== expectedDraft.notes) {
    return null
  }
  const current = await loadContextQuote(
    dependencies,
    staleSession,
    context,
    now,
  )
  if (!current) return null
  const option = automaticOptions(
    current.quote,
    preferredRoomTypeId(context),
  ).find(candidate => candidate.roomTypeId === currentDraft.room_type_id)
  return option
    ? {
      screen: 'LODGING_REVIEW',
      data: reviewData(flowToken, current.quote, option),
    }
    : null
}

async function backResponse(
  dependencies: LodgingFlowDependencies,
  input: LodgingFlowHandlerInput,
  flowToken: string,
  now: number,
): Promise<LodgingFlowDataExchangeResponse> {
  const context = contextOf(input.session)
  const search = searchOf(context)
  const requestedScreen = text(input.request.screen)
  // YCloud/Meta puede omitir `screen` en BACK. En ese caso no debemos
  // reiniciar el formulario: reconstruimos el paso actual únicamente con el
  // contexto canónico que ya guardó el servidor.
  const screen = requestedScreen || (
    draftOf(context)
      ? 'LODGING_REVIEW'
      : search
        ? (
          preferredRoomTypeId(context)
            ? 'LODGING_DETAILS'
            : 'LODGING_OPTIONS'
        )
        : 'LODGING_GUESTS'
  )

  if (screen === 'LODGING_GUESTS' || !search) {
    return {
      screen: 'LODGING_DATES',
      data: datesData(input.business, now),
    }
  }
  if (screen === 'LODGING_OPTIONS' || screen === 'LODGING_DETAILS') {
    return {
      screen: 'LODGING_GUESTS',
      data: guestsData(search.check_in, search.check_out),
    }
  }
  if (screen === 'LODGING_REVIEW') {
    const response = await quoteResponseFromContext(
      dependencies,
      input.session,
      context,
      now,
    )
    if (response) return response
    return {
      screen: 'LODGING_GUESTS',
      data: guestsData(
        search.check_in,
        search.check_out,
        'La cotización venció. Consulta nuevamente la disponibilidad.',
      ),
    }
  }
  return {
    screen: 'LODGING_DATES',
    data: datesData(input.business, now),
  }
}

async function recoverableResponse(
  dependencies: LodgingFlowDependencies,
  input: LodgingFlowHandlerInput,
  error: FlowDataExchangeError,
  now: number,
): Promise<LodgingFlowDataExchangeResponse> {
  const requestData = record(input.request.data)
  const intent = intentFrom(input.request)
  if (intent === 'review_lodging') {
    const response = await quoteResponseFromContext(
      dependencies,
      input.session,
      contextOf(input.session),
      now,
      error.publicMessage,
    )
    if (response) return response
  }
  if (intent === 'quote_lodging') {
    let checkIn = text(requestData.check_in)
    let checkOut = text(requestData.check_out)
    try {
      checkIn = flowDate(requestData.check_in)
      checkOut = flowDate(requestData.check_out)
    } catch {
      // El mensaje queda en la primera pantalla si ni siquiera hay fechas
      // canónicas para reconstruir el segundo paso.
    }
    if (validIsoDate(checkIn) && validIsoDate(checkOut)) {
      return {
        screen: 'LODGING_GUESTS',
        data: guestsData(checkIn, checkOut, error.publicMessage),
      }
    }
  }
  return {
    screen: 'LODGING_DATES',
    data: datesData(input.business, now, error.publicMessage),
  }
}

export function createWhatsAppFlowLodgingDataExchangeHandler(
  dependencies: LodgingFlowDependencies,
) {
  const now = dependencies.now || Date.now

  return async (
    input: LodgingFlowHandlerInput,
  ): Promise<LodgingFlowDataExchangeResponse> => {
    const currentTime = now()
    const flowToken = flowTokenFrom(input)
    validateInput(input, currentTime)
    const requestData = record(input.request.data)
    const intent = intentFrom(input.request)

    try {
      if (input.request.action === 'INIT') {
        recordMetric(
          dependencies,
          input.session,
          'lodging.step.init',
        )
        return {
          screen: 'LODGING_DATES',
          data: datesData(input.business, currentTime),
        }
      }

      if (input.request.action === 'BACK') {
        recordMetric(
          dependencies,
          input.session,
          'lodging.step.back',
          text(input.request.screen),
        )
        return backResponse(
          dependencies,
          input,
          flowToken,
          currentTime,
        )
      }

      if (intent === 'continue_lodging_dates') {
        const dates = dateRange(requestData, currentTime)
        recordMetric(
          dependencies,
          input.session,
          'lodging.step.dates',
        )
        return {
          screen: 'LODGING_GUESTS',
          data: guestsData(dates.checkIn, dates.checkOut),
        }
      }

      if (intent === 'quote_lodging') {
        const stay = stayInput(requestData, currentTime)
        const stayFingerprint = fingerprint(stay)
        const context = contextOf(input.session)
        const existing = searchOf(context)

        if (existing?.fingerprint === stayFingerprint) {
          const response = await quoteResponseFromContext(
            dependencies,
            input.session,
            context,
            currentTime,
          )
          if (response) return response
        }

        let rawQuote: unknown
        try {
          rawQuote = await dependencies.quoteLodging({
            businessId: input.session.business_id,
            contactPhone: sessionAlias(input.session),
            checkIn: stay.checkIn,
            checkOut: stay.checkOut,
            adults: stay.adults,
            children: stay.children,
            roomsCount: stay.roomsCount,
            idempotencyKey: [
              'flow',
              input.session.id,
              stayFingerprint,
              input.session.context_revision,
            ].join(':'),
          })
        } catch (error) {
          throw knownQuoteError(error) || error
        }
        const quote = normalizeQuote(rawQuote)
        if (!quote
          || quote.checkIn !== stay.checkIn
          || quote.checkOut !== stay.checkOut
          || quote.adults !== stay.adults
          || quote.children !== stay.children
          || quote.roomsCount !== stay.roomsCount
          || quote.nights !== stay.nights
          || !quoteIsOpen(quote, currentTime)) {
          throw new Error('La cotización de hospedaje no coincide con la búsqueda')
        }

        const nextContext: JsonRecord = {
          ...context,
          lodging_search: {
            fingerprint: stayFingerprint,
            check_in: stay.checkIn,
            check_out: stay.checkOut,
            adults: stay.adults,
            children: stay.children,
            rooms_count: stay.roomsCount,
            quote_id: quote.quoteId,
            quote_expires_at: quote.expiresAt,
          } satisfies LodgingSearchContext,
        }
        delete nextContext.lodging_draft
        // Construir la pantalla antes de persistir conserva el fail-closed de
        // listas demasiado grandes: nunca guardamos un estado que el teléfono
        // no podría representar de forma completa.
        const nextResponse = quoteStepResponse(quote, nextContext)
        const persisted = await persistContext(
          dependencies,
          input,
          flowToken,
          nextContext,
        )
        if (persisted.result === 'stale') {
          const recovered = await staleQuoteResponse(
            dependencies,
            persisted.session,
            stayFingerprint,
            currentTime,
          )
          if (recovered) return recovered
          throw new FlowDataExchangeError(
            409,
            'El formulario cambió. Intenta nuevamente.',
          )
        }

        recordMetric(
          dependencies,
          input.session,
          'lodging.step.quote',
          stayFingerprint,
        )
        return nextResponse
      }

      if (intent === 'review_lodging') {
        const roomTypeId = (
          cleanText(requestData.room_type_id, 64, true) as string
        ).toLowerCase()
        if (!UUID_PATTERN.test(roomTypeId)) {
          throw new FlowDataExchangeError(
            422,
            'Elige una habitación válida.',
          )
        }
        const contactName = cleanText(
          requestData.contact_name,
          MAX_CONTACT_NAME,
          true,
        ) as string
        if (contactName.length < 2) {
          throw new FlowDataExchangeError(
            422,
            'Escribe un nombre válido para la solicitud.',
          )
        }
        const notes = cleanText(requestData.notes, MAX_NOTES)
        const context = contextOf(input.session)
        const current = await loadContextQuote(
          dependencies,
          input.session,
          context,
          currentTime,
        )
        if (!current) {
          const search = searchOf(context)
          return {
            screen: 'LODGING_GUESTS',
            data: guestsData(
              search?.check_in || '',
              search?.check_out || '',
              'La cotización venció. Consulta nuevamente la disponibilidad.',
            ),
          }
        }
        const lockedRoomTypeId = preferredRoomTypeId(context)
        const lockedOption = lockedRoomTypeId
          ? current.quote.options.find(candidate => (
            candidate.roomTypeId === lockedRoomTypeId
            && isAutomaticOption(candidate)
          ))
          : null
        if (lockedOption && roomTypeId !== lockedOption.roomTypeId) {
          throw new FlowDataExchangeError(
            422,
            'La habitación elegida no puede cambiarse desde este formulario.',
          )
        }
        const option = automaticOptions(
          current.quote,
          preferredRoomTypeId(context),
        ).find(candidate => candidate.roomTypeId === roomTypeId)
        if (!option) {
          const available = automaticOptionsOrError(current.quote, context)
          return {
            screen: available.options.length
              ? 'LODGING_OPTIONS'
              : 'LODGING_GUESTS',
            data: available.options.length
              ? optionsData(
                current.quote,
                available.options,
                'La habitación elegida ya no está disponible.',
              )
              : guestsData(
                current.search.check_in,
                current.search.check_out,
                available.error,
              ),
          }
        }

        const draft: LodgingDraftContext = {
          quote_id: current.quote.quoteId,
          room_type_id: option.roomTypeId,
          contact_name: contactName,
          notes,
        }
        const persisted = await persistContext(
          dependencies,
          input,
          flowToken,
          {
            ...context,
            lodging_draft: draft,
          },
        )
        if (persisted.result === 'stale') {
          const recovered = await staleReviewResponse(
            dependencies,
            persisted.session,
            flowToken,
            draft,
            currentTime,
          )
          if (recovered) return recovered
          throw new FlowDataExchangeError(
            409,
            'El formulario cambió. Intenta nuevamente.',
          )
        }

        recordMetric(
          dependencies,
          input.session,
          'lodging.step.review',
          option.roomTypeId,
        )
        return {
          screen: 'LODGING_REVIEW',
          data: reviewData(flowToken, current.quote, option),
        }
      }

      throw new FlowDataExchangeError(
        422,
        'La acción del formulario no es válida.',
      )
    } catch (error) {
      if (error instanceof FlowDataExchangeError
        && (error.status === 409 || error.status === 422)) {
        return recoverableResponse(
          dependencies,
          input,
          error,
          currentTime,
        )
      }
      throw error
    }
  }
}
