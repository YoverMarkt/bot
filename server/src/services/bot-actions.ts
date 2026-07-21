import type {
  BookingTag,
  LodgingQuoteTag,
  LodgingRequestTag,
} from './bot-tags'

interface ErrorLike { message?: string }
interface MutationResult<T = unknown> {
  data?: T | null
  error?: ErrorLike | null
  duplicate?: boolean
  conflict?: boolean
}

export type BookingCreationOutcome =
  | 'none'
  | 'created'
  | 'duplicate'
  | 'conflict'
  | 'error'

export interface ActionBusiness {
  id: string
  name: string
  takes_bookings?: boolean | null
  takes_orders?: boolean | null
  lodging_enabled?: boolean | null
}

export interface ActionProduct {
  id?: string
  name?: string | null
  price?: string | number | null
  price_sale?: string | number | null
  stock?: string | null
  duration_minutes?: number | null
}

export interface ActionSession { contact_name?: string | null }
interface SavedOrder { id: string; total?: number }

interface DatabaseActions {
  createBooking(businessId: string, data: Record<string, unknown>): Promise<MutationResult>
  upsertSession(
    businessId: string,
    phone: string,
    data: Record<string, unknown>,
  ): Promise<MutationResult>
  recordAiGap(
    businessId: string,
    phone: string,
    question: string,
    reason: string,
  ): Promise<unknown>
  saveMessage(
    businessId: string,
    phone: string,
    role: string,
    content: string,
  ): Promise<unknown>
  getProducts(businessId: string): Promise<ActionProduct[]>
  createOrder(
    order: Record<string, unknown>,
    items: Record<string, unknown>[],
  ): Promise<MutationResult<SavedOrder>>
}

interface ParsedItem { name: string; qty: number }
interface ResolvedItem { product: ActionProduct; qty: number; unit: number }
interface ComputedOrder {
  items: Array<Record<string, unknown>>
  subtotal: number
  discount: number
  total: number
}

interface MoneyActions {
  parseItems(payload: string): ParsedItem[]
  resolveItems(
    parsed: ParsedItem[],
    products: ActionProduct[],
  ): { resolved: ResolvedItem[]; unresolved: string[] }
  computeOrder(resolved: ResolvedItem[]): ComputedOrder
  buildSummary(order: ComputedOrder): string
}

interface LodgingQuoteOption {
  roomTypeId: string
  name: string
  description?: string | null
  maxGuests: number
  availableUnits: number
  unitsRequired: number
  pricingModel?: string | null
  currency: string
  pricesIncludeTax: boolean
  subtotal: number | null
  tax: number | null
  fees: number | null
  total: number | null
  amenities?: string[] | null
  mediaUrls?: string[] | null
  nightlyRates?: unknown[] | null
  summary?: unknown
}

interface LodgingQuoteResult {
  quoteId: string
  checkIn: string
  checkOut: string
  checkInTime: string
  checkOutTime: string
  adults: number
  children: number
  nights: number
  expiresAt?: string | null
  options: LodgingQuoteOption[]
}

type LodgingFailureCode =
  | 'quote_not_found'
  | 'quote_expired'
  | 'unavailable'
  | 'manual_quote'
  | 'room_type_not_found'
  | 'invalid_input'
  | 'database_error'
  | 'lodging_disabled'

interface LodgingRequestRecord {
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
  subtotal: number | null
  tax: number | null
  fees: number | null
  total: number | null
  expiresAt?: string | null
}

type LodgingRequestResult =
  | { ok: true; request: LodgingRequestRecord }
  | { ok: false; error: { code: LodgingFailureCode; message?: string } }

interface LodgingActions {
  quoteLodging(input: {
    businessId: string
    contactPhone: string
    checkIn: string
    checkOut: string
    roomsCount: number
    adults: number
    children: number
  }): Promise<LodgingQuoteResult>
  requestLodging(input: {
    businessId: string
    contactPhone: string
    contactName: string
    roomTypeId?: string
    roomTypeName?: string
  }): Promise<LodgingRequestResult>
}

interface ActionLogger {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
}

export interface BotActionDependencies {
  database: DatabaseActions
  money: MoneyActions
  lodging?: LodgingActions
  logger?: ActionLogger
}

export interface ConversationOutcomeInput {
  business: ActionBusiness
  phone: string
  originalText: string
  hasSale: boolean
  hasHandoffTag: boolean
  isUncertain: boolean
  wasManual?: boolean | null
  send(message: string): Promise<unknown>
}

export interface ProcessOrderInput {
  business: ActionBusiness
  phone: string
  session?: ActionSession | null
  payload: string | null
  products: ActionProduct[]
  preFiltered: boolean
  send(message: string): Promise<unknown>
}

interface LodgingMediaInput {
  sendImage?: (url: string, caption?: string) => Promise<unknown>
  sendVideo?: (url: string, caption?: string) => Promise<unknown>
}

export interface ProcessLodgingQuoteInput extends LodgingMediaInput {
  business: ActionBusiness
  phone: string
  originalText: string
  quote: LodgingQuoteTag | null
  // Mensajes escritos por el huésped (historial + mensaje actual): las fechas
  // relativas ("el lunes", "mañana") se resuelven con el más reciente de aquí.
  guestMessages?: string[]
  send(message: string): Promise<unknown>
}

export interface ProcessLodgingRequestInput {
  business: ActionBusiness
  phone: string
  originalText: string
  request: LodgingRequestTag | null
  // Mensajes escritos por el huésped (historial + mensaje actual): el nombre
  // de la solicitud debe provenir de aquí; si falta, se falla cerrado.
  guestMessages?: string[]
  send(message: string): Promise<unknown>
}

export type LodgingActionOutcome =
  | 'none'
  | 'quoted'
  | 'requested'
  | 'retry'
  | 'handoff'
  | 'error'

// Resultado puro de una cotización de hospedaje, sin efectos secundarios
export interface ComputedLodgingQuote {
  outcome: 'quoted' | 'retry' | 'handoff' | 'error'
  message: string
  mediaOptions?: LodgingQuoteOption[]
  logLine?: string
}

function cleanLine(value: unknown, fallback = ''): string {
  return String(value ?? fallback).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

// El nombre de una solicitud de hospedaje debe haberlo ESCRITO el huésped en
// sus propios mensajes: si la IA lo puso por su cuenta (un "sí, por favor" no
// es un nombre), el que llama debe fallar cerrado y pedirlo.
function guestWroteName(contactName: unknown, guestMessages: unknown[]): boolean {
  const normalize = (value: unknown) => String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  const tokens = normalize(contactName).split(/[^a-z0-9]+/).filter(word => word.length >= 3)
  if (!tokens.length) return false
  const written = guestMessages.map(normalize).join(' ')
  return tokens.every(token => written.includes(token))
}

// ── Fechas relativas resueltas por CÓDIGO, no por el modelo ──────────
// "El lunes", "mañana" o "pasado mañana" son fechas calculables, no opiniones:
// si el huésped las mencionó sin fecha explícita, el calendario real corrige la
// interpretación del modelo (que puede equivocarse de día). La mención puede
// venir de cualquier mensaje del huésped: gana el MÁS RECIENTE que hable de
// fechas, así la corrección funciona aunque la etiqueta salga turnos después.
const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const

const normalizeGuestText = (value: unknown): string => String(value ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')

const todayInEcuador = (): string => new Date().toLocaleDateString('en-CA', {
  timeZone: 'America/Guayaquil',
})

const weekdayOf = (isoDate: string): number => new Date(`${isoDate}T12:00:00Z`).getUTCDay()

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const nextWeekday = (fromIso: string, weekday: number, strictlyAfter: boolean): string => {
  let delta = (weekday - weekdayOf(fromIso) + 7) % 7
  if (delta === 0 && strictlyAfter) delta = 7
  return addDays(fromIso, delta)
}

type StayDateMention =
  | { kind: 'absolute'; date: string }
  | { kind: 'weekday'; weekday: number }

const RELATIVE_DATE_PATTERN = /\b(pasado\s+manana|manana|hoy|domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/g

const stayDateMentions = (text: string, today: string): StayDateMention[] =>
  [...text.matchAll(RELATIVE_DATE_PATTERN)].map(match => {
    const term = match[1].replace(/\s+/g, ' ')
    if (term === 'hoy') return { kind: 'absolute', date: today }
    if (term === 'manana') return { kind: 'absolute', date: addDays(today, 1) }
    if (term === 'pasado manana') return { kind: 'absolute', date: addDays(today, 2) }
    return { kind: 'weekday', weekday: WEEKDAY_NAMES.indexOf(term as typeof WEEKDAY_NAMES[number]) }
  })

function resolveRelativeStayDates(
  guestText: unknown,
  checkIn: string,
  checkOut: string,
  today = todayInEcuador(),
): { checkIn: string; checkOut: string } {
  // Acepta un mensaje o la lista completa del huésped (del más viejo al más
  // nuevo) y decide con el MÁS RECIENTE que hable de fechas; los mensajes sin
  // fechas ("2 habitaciones") se saltan.
  const messages = (Array.isArray(guestText) ? guestText : [guestText]).map(normalizeGuestText)
  for (const text of messages.reverse()) {
    // Con fecha explícita ("20 de julio", "20/07", "2026-07-20") se respeta al modelo
    if (/\d{1,2}\s*(de\s+[a-z]|\/|-)\s*\w+/.test(text)) return { checkIn, checkOut }
    const mentions = stayDateMentions(text, today)
    if (!mentions.length) continue

    const nights = Math.max(1, Math.round(
      (new Date(`${checkOut}T12:00:00Z`).getTime() - new Date(`${checkIn}T12:00:00Z`).getTime()) / 86_400_000,
    ))
    const first = mentions[0]
    const resolvedIn = first.kind === 'absolute' ? first.date : nextWeekday(today, first.weekday, false)
    const second = mentions[1]
    let resolvedOut = !second
      ? addDays(resolvedIn, nights)
      : second.kind === 'absolute' ? second.date : nextWeekday(resolvedIn, second.weekday, true)
    // Una salida que no queda después de la entrada no es interpretable: se
    // conserva la cantidad de noches en vez de producir una estadía imposible
    if (resolvedOut <= resolvedIn) resolvedOut = addDays(resolvedIn, nights)
    return { checkIn: resolvedIn, checkOut: resolvedOut }
  }
  return { checkIn, checkOut }
}

function formatAmount(value: number, currency = 'USD'): string {
  const amount = Number(value)
  const normalizedCurrency = cleanLine(currency, 'USD').toUpperCase()
  return normalizedCurrency === 'USD'
    ? `$${amount.toFixed(2)}`
    : `${normalizedCurrency} ${amount.toFixed(2)}`
}

function lodgingErrorCode(error: unknown): LodgingFailureCode | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return String((error as { code?: unknown }).code || '') as LodgingFailureCode
}

function validMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validTotal(value: unknown): value is number {
  return validMoney(value) && value > 0
}

function buildLodgingQuoteSummary(quote: LodgingQuoteResult): string {
  const people = quote.children > 0
    ? `${quote.adults} adulto(s) y ${quote.children} niño(s)`
    : `${quote.adults} adulto(s)`
  const optionLines = quote.options.map((option, index) => {
    const details = [
      `*${index + 1}. ${cleanLine(option.name, 'Habitación')}*`,
      `Capacidad: hasta ${option.maxGuests} persona(s)`,
      `Disponibles ahora: ${option.availableUnits}`,
      `Para este grupo: ${option.unitsRequired} habitación(es)`,
    ]
    if (option.description) details.push(cleanLine(option.description))
    if (option.amenities?.length) {
      details.push(`Incluye: ${option.amenities.slice(0, 6).map(value => cleanLine(value)).join(', ')}`)
    }
    if (validTotal(option.total)) {
      if (validMoney(option.subtotal)) {
        details.push(`Alojamiento: ${formatAmount(option.subtotal, option.currency)}`)
      }
      if (validMoney(option.tax)) {
        details.push(
          `${option.pricesIncludeTax ? 'Impuestos incluidos' : 'Impuestos adicionales'}: ${formatAmount(option.tax, option.currency)}`,
        )
      }
      if (validMoney(option.fees) && option.fees > 0) {
        details.push(`Cargos: ${formatAmount(option.fees, option.currency)}`)
      }
      details.push(`💰 *Total oficial: ${formatAmount(option.total, option.currency)}*`)
    } else {
      details.push('Tarifa: requiere confirmación manual del equipo')
    }
    return details.join('\n')
  })
  return `🏨 *Opciones de hospedaje*\n📅 Entrada: ${quote.checkIn} desde ${quote.checkInTime} · Salida: ${quote.checkOut} hasta ${quote.checkOutTime}\n🌙 ${quote.nights} noche(s) · 👥 ${people}\n\n${optionLines.join('\n\n')}\n\nElige una opción si deseas solicitarla. La disponibilidad mostrada es actual, pero todavía no confirma ni paga una reserva; el equipo autorizado debe aprobarla.`
}

function buildLodgingRequestSummary(request: LodgingRequestRecord): string {
  const totalLine = validTotal(request.total)
    ? `\n💰 *Total oficial: ${formatAmount(request.total, request.currency)}*`
    : ''
  return `✅ *Solicitud de hospedaje registrada*\n${cleanLine(request.roomTypeName, 'Habitación')}\n📅 Entrada: ${request.checkIn} desde ${request.checkInTime} · Salida: ${request.checkOut} hasta ${request.checkOutTime} · ${request.nights} noche(s)\n🏨 ${request.unitsRequired} habitación(es) · 👥 ${request.adults + request.children} persona(s)${totalLine}\n\nQuedó *pendiente de confirmación del equipo autorizado*. Todavía no está confirmada; un asesor continuará contigo.`
}

function createBotActions(dependencies: BotActionDependencies) {
  const { database, money, lodging } = dependencies
  const logger = dependencies.logger || console

  async function sendAndSave(
    business: ActionBusiness,
    phone: string,
    message: string,
    send: (message: string) => Promise<unknown>,
  ): Promise<void> {
    await database.saveMessage(business.id, phone, 'assistant', message)
    await send(message)
  }

  async function keepAutomated(
    business: ActionBusiness,
    phone: string,
    originalText: string,
  ): Promise<void> {
    const { error } = await database.upsertSession(business.id, phone, {
      manual_mode: false,
      last_message: originalText,
      last_message_at: new Date().toISOString(),
      unread_owner: false,
    })
    if (error) logger.error('❌ upsertSession hospedaje:', error)
  }

  async function handoffLodging(
    business: ActionBusiness,
    phone: string,
    originalText: string,
    message: string,
    send: (message: string) => Promise<unknown>,
  ): Promise<void> {
    const { error } = await database.upsertSession(business.id, phone, {
      manual_mode: true,
      last_message: originalText,
      last_message_at: new Date().toISOString(),
      unread_owner: true,
    })
    if (error) logger.error('❌ upsertSession hospedaje:', error)
    else logger.log(`🏨 [${business.name}] solicitud de hospedaje derivada — ${phone}`)
    await sendAndSave(business, phone, message, send)
  }

  async function sendLodgingMedia(
    options: LodgingQuoteOption[],
    input: LodgingMediaInput,
  ): Promise<void> {
    const media = options.flatMap(option => (
      (option.mediaUrls || []).map(url => ({ url, caption: cleanLine(option.name) }))
    )).filter(item => /^https:\/\//i.test(item.url)).slice(0, 3)

    for (const item of media) {
      try {
        const looksLikeVideo = /\.(?:mp4|mov|webm)(?:$|[?#])/i.test(item.url)
        if (looksLikeVideo && input.sendVideo) {
          await input.sendVideo(item.url, item.caption || undefined)
        } else if (!looksLikeVideo && input.sendImage) {
          await input.sendImage(item.url, item.caption || undefined)
        }
      } catch (error) {
        logger.error(
          '❌ media de hospedaje:',
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  // Cálculo PURO de la respuesta a un ##STAY_QUOTE## (sin tocar sesión ni
  // notificar a nadie): lo comparten el canal real y el simulador del admin.
  async function computeLodgingQuoteReply(
    business: ProcessLodgingQuoteInput['business'],
    contactPhone: string,
    quote: NonNullable<ProcessLodgingQuoteInput['quote']>,
    guestText: string | string[] = '',
    // Habitación ya elegida por el huésped (modo menú): la cotización se
    // centra en ella y solo muestra alternativas si no tiene cupo
    focusRoomTypeId: string | null = null,
  ): Promise<ComputedLodgingQuote> {
    if (business.lodging_enabled !== true || !lodging) {
      return { outcome: 'handoff', message: 'No puedo consultar hospedaje automáticamente en este momento. Un asesor continuará contigo para ayudarte 🙏' }
    }

    if (
      !quote.checkIn || !quote.checkOut
      || quote.roomsCount == null || quote.adults == null || quote.children == null
    ) {
      return { outcome: 'retry', message: 'Necesito fechas válidas de entrada y salida (AAAA-MM-DD), al menos una habitación, un adulto y el número de niños para consultar el hospedaje.' }
    }

    // "El lunes" lo resuelve el calendario, no el modelo
    const stayDates = resolveRelativeStayDates(guestText, quote.checkIn, quote.checkOut)

    try {
      const result = await lodging.quoteLodging({
        businessId: business.id,
        contactPhone,
        checkIn: stayDates.checkIn,
        checkOut: stayDates.checkOut,
        roomsCount: quote.roomsCount,
        adults: quote.adults,
        children: quote.children,
      })
      const viableOptions = result.options.filter(option => (
        Number.isInteger(option.availableUnits)
        && Number.isInteger(option.unitsRequired)
        && option.unitsRequired > 0
        && option.availableUnits >= option.unitsRequired
      ))
      if (!viableOptions.length) {
        return { outcome: 'retry', message: 'No encontré habitaciones disponibles para todo ese periodo. Puedes indicarme otras fechas y lo consulto nuevamente.' }
      }

      // Con habitación elegida, el total que ve el huésped es SOLO el de esa
      // habitación; las demás aparecen únicamente si la suya no tiene cupo
      const focused = focusRoomTypeId
        ? viableOptions.filter(option => option.roomTypeId === focusRoomTypeId)
        : viableOptions
      const chosenUnavailable = Boolean(focusRoomTypeId) && !focused.length
      const options = focused.length ? focused : viableOptions

      const hasAutomaticPrice = options.some(option => validTotal(option.total))
      if (!hasAutomaticPrice) {
        return {
          outcome: 'handoff',
          message: `Encontré opciones de hospedaje para ${result.checkIn} al ${result.checkOut}, pero sus tarifas requieren revisión manual. Para no inventar ningún total, un asesor continuará contigo 🙏`,
          mediaOptions: options,
        }
      }

      const officialQuote = { ...result, options }
      const unavailableNote = chosenUnavailable
        ? 'La habitación que elegiste no tiene cupo para esas fechas 😔 Estas son las opciones disponibles:\n\n'
        : ''
      return {
        outcome: 'quoted',
        message: `${unavailableNote}${buildLodgingQuoteSummary(officialQuote)}`,
        mediaOptions: options,
        logLine: `🏨 [${business.name}] cotización ${result.quoteId} — ${result.nights} noche(s) — ${contactPhone}`,
      }
    } catch (error) {
      const code = lodgingErrorCode(error)
      if (code === 'invalid_input') {
        return { outcome: 'retry', message: 'No pude validar esas fechas o la cantidad de personas. Revísalas y envíamelas nuevamente, por favor.' }
      }
      if (code === 'unavailable') {
        return { outcome: 'retry', message: 'No hay habitaciones disponibles para todo ese periodo. Si me indicas otras fechas, puedo consultar nuevamente.' }
      }

      logger.error(
        '❌ cotizando hospedaje:',
        error instanceof Error ? error.message : error,
      )
      return code === 'manual_quote'
        ? { outcome: 'handoff', message: 'La tarifa para esas fechas debe revisarla una persona. Un asesor continuará contigo sin confirmar ningún total ni reserva 🙏' }
        : { outcome: 'error', message: 'No pude consultar disponibilidad y precios de forma segura. Un asesor continuará contigo para revisarlo 🙏' }
    }
  }

  async function processLodgingQuote(
    input: ProcessLodgingQuoteInput,
  ): Promise<LodgingActionOutcome> {
    const { business, phone, originalText, quote, send } = input
    if (!quote) return 'none'

    const computed = await computeLodgingQuoteReply(
      business, phone, quote,
      input.guestMessages?.length ? input.guestMessages : originalText,
    )
    if (computed.outcome === 'retry') {
      await keepAutomated(business, phone, originalText)
      await sendAndSave(business, phone, computed.message, send)
      return 'retry'
    }
    if (computed.outcome === 'handoff' || computed.outcome === 'error') {
      await handoffLodging(business, phone, originalText, computed.message, send)
      if (computed.mediaOptions) await sendLodgingMedia(computed.mediaOptions, input)
      return computed.outcome
    }

    await keepAutomated(business, phone, originalText)
    await sendAndSave(business, phone, computed.message, send)
    if (computed.mediaOptions) await sendLodgingMedia(computed.mediaOptions, input)
    if (computed.logLine) logger.log(computed.logLine)
    return 'quoted'
  }

  async function processLodgingRequest(
    input: ProcessLodgingRequestInput,
  ): Promise<LodgingActionOutcome> {
    const { business, phone, originalText, request, send } = input
    if (!request) return 'none'

    if (business.lodging_enabled !== true || !lodging) {
      const message = 'No pude registrar esa solicitud de hospedaje de forma segura. Un asesor continuará contigo 🙏'
      await handoffLodging(business, phone, originalText, message, send)
      return 'handoff'
    }

    const roomType = cleanLine(request.roomTypeIdOrName)
    const contactName = cleanLine(request.contactName)
    if (!roomType || roomType.length > 160 || !contactName || contactName.length > 120) {
      const message = 'Indícame el nombre exacto de una opción cotizada y el nombre de la persona que se hospedará.'
      await keepAutomated(business, phone, originalText)
      await sendAndSave(business, phone, message, send)
      return 'retry'
    }

    // La IA no puede inventar el nombre: debe estar escrito por el huésped
    if (!guestWroteName(contactName, input.guestMessages ?? [])) {
      const message = 'Para registrar la solicitud solo me falta el nombre de la persona que se hospedará. ¿Me lo escribes, por favor?'
      await keepAutomated(business, phone, originalText)
      await sendAndSave(business, phone, message, send)
      return 'retry'
    }

    const isRoomTypeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(roomType)
    try {
      const result = await lodging.requestLodging({
        businessId: business.id,
        contactPhone: phone,
        contactName,
        ...(isRoomTypeId ? { roomTypeId: roomType } : { roomTypeName: roomType }),
      })
      if (result.ok) {
        const summary = buildLodgingRequestSummary(result.request)
        await handoffLodging(business, phone, originalText, summary, send)
        logger.log(`🏨 [${business.name}] hold ${result.request.requestId} pendiente del dueño — ${phone}`)
        return 'requested'
      }

      const { code } = result.error
      if (code === 'manual_quote' || code === 'database_error') {
        const message = code === 'manual_quote'
          ? 'Esa opción requiere una tarifa manual. Un asesor continuará contigo sin confirmar ningún total ni reserva 🙏'
          : 'No pude registrar la solicitud de forma segura. Un asesor continuará contigo para revisarla 🙏'
        await handoffLodging(business, phone, originalText, message, send)
        return code === 'manual_quote' ? 'handoff' : 'error'
      }

      const message = code === 'unavailable'
        ? 'Esa opción acaba de quedarse sin disponibilidad. No registré ninguna reserva; indícame si deseas cotizar otras fechas u otra habitación.'
        : code === 'quote_expired'
          ? 'La cotización anterior expiró. Indícame nuevamente las fechas y personas para consultar disponibilidad actualizada.'
          : code === 'quote_not_found'
            ? 'Primero necesito cotizar las fechas y el número de personas antes de solicitar una habitación.'
            : 'No identifiqué esa opción en la cotización vigente. Elige el nombre exacto de una de las habitaciones mostradas.'
      await keepAutomated(business, phone, originalText)
      await sendAndSave(business, phone, message, send)
      return 'retry'
    } catch (error) {
      logger.error(
        '❌ solicitando hospedaje:',
        error instanceof Error ? error.message : error,
      )
      const message = 'No pude registrar la solicitud de hospedaje de forma segura. Un asesor continuará contigo para revisarla 🙏'
      await handoffLodging(business, phone, originalText, message, send)
      return 'error'
    }
  }

  async function createBookingFromTag(
    business: ActionBusiness,
    phone: string,
    booking: BookingTag | null,
    products: ActionProduct[],
  ): Promise<BookingCreationOutcome> {
    if (!booking) return 'none'
    if (business.takes_bookings !== true) {
      logger.log(`🚫 [${business.name}] ##BOOK## ignorado — negocio sin reservas`)
      return 'error'
    }
    const {
      contactName, bookingDateRaw, bookingTimeRaw, service, bookingDate, bookingTime,
    } = booking
    try {
      if (!bookingDate || !bookingTime) {
        throw new Error(`formato inválido: fecha="${bookingDateRaw}" hora="${bookingTimeRaw}"`)
      }
      const normalizedService = service.trim().toLowerCase()
      const exactMatch = products.find(product => (
        product.name?.trim().toLowerCase() === normalizedService
      ))
      const partialMatches = products.filter(product => {
        const productName = product.name?.trim().toLowerCase()
        return Boolean(productName && (
          normalizedService.includes(productName)
          || productName.includes(normalizedService)
        ))
      })
      // Una coincidencia inequívoca permite usar la duración real del servicio.
      // Si el nombre es ambiguo, la base aplicará la duración de agenda configurada.
      const matched = exactMatch || (partialMatches.length === 1 ? partialMatches[0] : null)
      const duration = matched?.duration_minutes || null
      const result = await database.createBooking(business.id, {
        contact_phone: phone,
        contact_name: contactName.trim(),
        service: service.trim(),
        booking_date: bookingDate,
        booking_time: bookingTime,
        duration_minutes: duration,
        status: 'pending',
      })
      if (result.error) {
        throw new Error(result.error.message || 'No se pudo crear la reserva')
      }
      if (result.conflict) {
        logger.log(`⚠️ [${business.name}] Horario ocupado durante la reserva — ${bookingDate} ${bookingTime}`)
        return 'conflict'
      }
      if (result.duplicate) {
        logger.log(`↩️ [${business.name}] Reserva ya registrada — ${bookingDate} ${bookingTime}`)
        return 'duplicate'
      }
      if (!result.data) throw new Error('La base no devolvió la reserva creada')
      logger.log(`📅 [${business.name}] Reserva creada: ${contactName} — ${service} (${duration || '?'}min) — ${bookingDate} ${bookingTime}`)
      return 'created'
    } catch (error) {
      logger.error('❌ Error creando reserva:', error instanceof Error ? error.message : error)
      return 'error'
    }
  }

  async function handleConversationOutcome(
    input: ConversationOutcomeInput,
  ): Promise<{ handled: boolean }> {
    const {
      business, phone, originalText, hasSale, hasHandoffTag, isUncertain, wasManual, send,
    } = input
    if (isUncertain && !wasManual) {
      const handoffMessage = 'Permítame un momento por favor 🙏 enseguida un asesor de nuestro equipo continuará con usted para ayudarle mejor ✨'
      const { error } = await database.upsertSession(business.id, phone, {
        manual_mode: true,
        last_message: originalText,
        last_message_at: new Date().toISOString(),
        unread_owner: true,
      })
      if (error) logger.error('❌ upsertSession error:', error)
      else logger.log(`🤚 [${business.name}] manual_mode=true guardado para ${phone}`)
      void database.recordAiGap(
        business.id,
        phone,
        originalText,
        hasHandoffTag ? 'handoff' : 'uncertain',
      ).catch(error => logger.error(
        '❌ recordAiGap:',
        error instanceof Error ? error.message : error,
      ))
      await database.saveMessage(business.id, phone, 'assistant', handoffMessage)
      await send(handoffMessage)
      return { handled: true }
    }

    if (hasSale) {
      await database.upsertSession(business.id, phone, {
        manual_mode: true,
        last_message: originalText,
        last_message_at: new Date().toISOString(),
        unread_owner: true,
      })
      logger.log(`🛒 [${business.name}] VENTA detectada — chat a manual para confirmar/coordinar — ${phone}`)
    } else if (!isUncertain) {
      await database.upsertSession(business.id, phone, {
        manual_mode: false,
        last_message: originalText,
        last_message_at: new Date().toISOString(),
        unread_owner: false,
      })
    }
    return { handled: false }
  }

  async function processOrderPayload(input: ProcessOrderInput): Promise<boolean> {
    const { business, phone, session, products, preFiltered, send } = input
    if (!input.payload) return false
    if (business.takes_orders === false) {
      logger.log(`🚫 [${business.name}] ##PEDIDO## ignorado — negocio en modo informativo (takes_orders=false)`)
      return false
    }

    try {
      const catalog = preFiltered ? await database.getProducts(business.id) : products
      const parsed = money.parseItems(input.payload)
      const { resolved, unresolved } = money.resolveItems(parsed, catalog)
      if (!parsed.length || unresolved.length) {
        logger.log(`⚠️ [${business.name}] Pedido SIN total oficial — ítems no resueltos: ${unresolved.join(' | ') || '(vacío)'} — pasa al dueño`)
        return false
      }

      const order = money.computeOrder(resolved)
      const { data, error } = await database.createOrder({
        business_id: business.id,
        contact_phone: phone,
        contact_name: session?.contact_name || null,
        status: 'pendiente',
        subtotal: order.subtotal,
        discount: order.discount,
        total: order.total,
      }, order.items)
      if (error) throw new Error(error.message || 'No se pudo crear el pedido')
      if (!data) throw new Error('No se pudo crear el pedido')
      const summary = money.buildSummary(order)
      await send(summary)
      await database.saveMessage(business.id, phone, 'assistant', summary)
      logger.log(`🧾 [${business.name}] Pedido #${data.id.slice(0, 8)} — total oficial $${order.total.toFixed(2)} (${order.items.length} ítems) — ${phone}`)
      return true
    } catch (error) {
      logger.error('❌ procesando pedido:', error instanceof Error ? error.message : error)
      return false
    }
  }

  return {
    createBookingFromTag,
    handleConversationOutcome,
    processOrderPayload,
    computeLodgingQuoteReply,
    processLodgingQuote,
    processLodgingRequest,
  }
}

const actions = createBotActions({
  database: require('../db') as DatabaseActions,
  money: require('./money') as MoneyActions,
  lodging: require('./lodging') as LodgingActions,
})

export const createBookingFromTag = actions.createBookingFromTag
export const handleConversationOutcome = actions.handleConversationOutcome
export const processOrderPayload = actions.processOrderPayload
export const computeLodgingQuoteReply = actions.computeLodgingQuoteReply
export const processLodgingQuote = actions.processLodgingQuote
export const processLodgingRequest = actions.processLodgingRequest
export { createBotActions, guestWroteName, resolveRelativeStayDates }
