import type {
  FlowProvider,
  JsonObject,
  ResolvedFlowSession,
} from '../db/repositories/whatsapp-flows'
import { FlowDataExchangeError } from './whatsapp-flow-data-exchange'
import { recordFlowMetricBestEffort } from './whatsapp-flow-metrics'

const PROVIDER: FlowProvider = 'ycloud'
const GENERAL_SERVICE_ID = 'general'
const MAX_TOKEN_LENGTH = 512
const MAX_DYNAMIC_OPTIONS = 200
const AVAILABILITY_DAYS_AHEAD = 30
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,6})?)?$/
const DAYS_ES = ['Dom.', 'Lun.', 'Mar.', 'Mié.', 'Jue.', 'Vie.', 'Sáb.']

type DataRecord = Record<string, unknown>

export interface AppointmentFlowBusiness extends DataRecord {
  id?: string
  name?: string | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
  takes_bookings?: boolean | null
}

export interface FlowAppointmentServiceRecord extends DataRecord {
  id?: string
  business_id?: string | null
  name?: string | null
  duration_minutes?: number | string | null
  active?: boolean | null
}

export interface FlowAppointmentAvailabilityRow extends DataRecord {
  booking_date?: string | null
  booking_time?: string | null
}

export interface AppointmentAvailabilityInput {
  businessId: string
  serviceId: string | null
  durationMinutes: number | null
  daysAhead: number
}

export interface AppointmentFlowDataExchangeRequest {
  version?: unknown
  action?: unknown
  screen?: unknown
  data?: unknown
  flow_token?: unknown
}

export interface AppointmentFlowDataExchangeResponse {
  screen?: string
  data: DataRecord
}

export interface WhatsAppFlowAppointmentDataExchangeDependencies {
  getFlowSessionByToken(
    provider: FlowProvider,
    flowToken: string,
  ): Promise<ResolvedFlowSession | null>
  updateFlowSessionContext(
    businessId: string,
    provider: FlowProvider,
    flowToken: string,
    expectedRevision: number,
    context: JsonObject,
  ): Promise<JsonObject>
  getBusinessById(
    businessId: string,
  ): Promise<AppointmentFlowBusiness | null>
  getFlowAppointmentServices(
    businessId: string,
  ): Promise<FlowAppointmentServiceRecord[]>
  getFlowAppointmentAvailability(
    input: AppointmentAvailabilityInput,
  ): Promise<FlowAppointmentAvailabilityRow[]>
  recordFlowMetric?(input: {
    businessId: string
    provider: FlowProvider
    flowVersionId: string
    sessionId?: string | null
    eventType: string
    sourceKey: string
    metadata?: JsonObject
  }): Promise<boolean>
}

interface AppointmentDraft extends JsonObject {
  contact_name: string
  notes: string | null
  request_status: 'pending'
}

interface AppointmentContext extends JsonObject {
  service_id?: string
  service_name?: string
  duration_minutes?: number | null
  booking_date?: string
  booking_time?: string
  appointment_draft?: AppointmentDraft
}

interface CanonicalService {
  id: string
  name: string
  durationMinutes: number | null
  synthetic: boolean
}

interface CanonicalAvailability {
  date: string
  time: string
}

const asRecord = (value: unknown): DataRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as DataRecord
    : {}
)

const cleanText = (
  value: unknown,
  maximum: number,
  required = false,
): string | null => {
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

const optionTitle = (value: unknown): string => {
  const clean = String(value || '').trim()
  return clean.length <= 30 ? clean : `${clean.slice(0, 29)}…`
}
const headingText = (value: unknown): string => {
  const clean = String(value || '').trim()
  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`
}

const durationOf = (
  service: FlowAppointmentServiceRecord,
): number | null => {
  const duration = Number(service.duration_minutes)
  return Number.isInteger(duration) && duration >= 1 && duration <= 1440
    ? duration
    : null
}

function canonicalServices(
  records: FlowAppointmentServiceRecord[],
  businessId: string,
): CanonicalService[] {
  if (!Array.isArray(records)) {
    throw new FlowDataExchangeError(
      503,
      'No pudimos consultar los servicios en este momento.',
    )
  }
  if (records.length > MAX_DYNAMIC_OPTIONS) {
    throw new FlowDataExchangeError(
      409,
      'Hay demasiados servicios para mostrarlos completos aquí. '
      + 'Cierra el formulario y continúa por el chat.',
    )
  }

  const services = records.flatMap((service): CanonicalService[] => {
    const id = String(service.id || '').trim()
    const name = String(service.name || '').trim()
    const tenant = String(service.business_id || '').trim()
    const duration = durationOf(service)
    if (service.active === false
      || !UUID_PATTERN.test(id)
      || !name
      || duration === null
      || (tenant && tenant !== businessId)) {
      return []
    }
    return [{
      id,
      name: name.slice(0, 160),
      durationMinutes: duration,
      synthetic: false,
    }]
  })

  if (services.length) {
    return [...new Map(services.map(service => [service.id, service])).values()]
  }
  return [{
    id: GENERAL_SERVICE_ID,
    name: 'Cita general',
    durationMinutes: null,
    synthetic: true,
  }]
}

const serviceOptions = (services: CanonicalService[]): DataRecord[] => (
  services.map(service => ({
    id: service.id,
    title: optionTitle(
      service.durationMinutes
        ? `${service.name} · ${service.durationMinutes} min`
        : service.name,
    ),
  }))
)

function validDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  const match = clean.match(DATE_PATTERN)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? clean
    : null
}

function validTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  const match = clean.match(TIME_PATTERN)
  return match ? `${match[1]}:${match[2]}` : null
}

function canonicalAvailability(
  rows: FlowAppointmentAvailabilityRow[],
): CanonicalAvailability[] {
  if (!Array.isArray(rows)) {
    throw new FlowDataExchangeError(
      503,
      'No pudimos consultar los horarios en este momento.',
    )
  }
  const unique = new Map<string, CanonicalAvailability>()
  for (const row of rows) {
    const date = validDate(row.booking_date)
    const time = validTime(row.booking_time)
    if (!date || !time) continue
    unique.set(`${date}:${time}`, { date, time })
  }
  return [...unique.values()].sort((left, right) => (
    left.date.localeCompare(right.date) || left.time.localeCompare(right.time)
  ))
}

function dateLabel(dateValue: string): string {
  const match = dateValue.match(DATE_PATTERN)
  if (!match) return dateValue
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return `${DAYS_ES[date.getUTCDay()]} ${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
}

function dateOptions(rows: CanonicalAvailability[]): DataRecord[] {
  const dates = [...new Set(rows.map(row => row.date))]
  if (dates.length > MAX_DYNAMIC_OPTIONS) {
    throw new FlowDataExchangeError(
      409,
      'Hay demasiadas fechas para mostrarlas completas. Continúa por el chat.',
    )
  }
  return dates.map(date => ({ id: date, title: optionTitle(dateLabel(date)) }))
}

function timeOptions(
  rows: CanonicalAvailability[],
  date: string,
): DataRecord[] {
  const times = rows
    .filter(row => row.date === date)
    .map(row => row.time)
  if (times.length > MAX_DYNAMIC_OPTIONS) {
    throw new FlowDataExchangeError(
      409,
      'Hay demasiados horarios para mostrarlos completos. Continúa por el chat.',
    )
  }
  return times.map(time => ({ id: time, title: time }))
}

const contextOf = (session: ResolvedFlowSession): AppointmentContext => (
  asRecord(session.context) as AppointmentContext
)

function serviceFromContext(
  context: AppointmentContext,
  services: CanonicalService[],
): CanonicalService | null {
  const id = typeof context.service_id === 'string'
    ? context.service_id.trim()
    : ''
  return services.find(service => service.id === id) || null
}

const serviceInput = (
  businessId: string,
  service: CanonicalService,
): AppointmentAvailabilityInput => ({
  businessId,
  serviceId: service.synthetic ? null : service.id,
  durationMinutes: service.durationMinutes,
  daysAhead: AVAILABILITY_DAYS_AHEAD,
})

async function availabilityFor(
  dependencies: WhatsAppFlowAppointmentDataExchangeDependencies,
  businessId: string,
  service: CanonicalService,
): Promise<CanonicalAvailability[]> {
  return canonicalAvailability(
    await dependencies.getFlowAppointmentAvailability(
      serviceInput(businessId, service),
    ),
  )
}

const appointmentSummary = (
  service: CanonicalService,
  date: string,
  time: string,
): string => `${service.name} · ${dateLabel(date)} · ${time}`

const serviceScreenData = (
  business: AppointmentFlowBusiness,
  services: CanonicalService[],
  errorMessage = '',
): DataRecord => ({
  business_name: headingText(business.name || 'Nuestro negocio'),
  services: serviceOptions(services),
  error_message: errorMessage,
})

const dateScreenData = (
  service: CanonicalService,
  rows: CanonicalAvailability[],
  errorMessage = '',
): DataRecord => ({
  service_name: service.name,
  dates: dateOptions(rows),
  error_message: errorMessage,
})

const timeScreenData = (
  service: CanonicalService,
  date: string,
  rows: CanonicalAvailability[],
  errorMessage = '',
): DataRecord => ({
  service_name: service.name,
  date_label: dateLabel(date),
  times: timeOptions(rows, date),
  error_message: errorMessage,
})

const detailsScreenData = (
  service: CanonicalService,
  date: string,
  time: string,
  errorMessage = '',
): DataRecord => ({
  appointment_summary: appointmentSummary(service, date, time),
  error_message: errorMessage,
})

function validateSession(
  session: ResolvedFlowSession | null,
): ResolvedFlowSession {
  if (!session) {
    throw new FlowDataExchangeError(
      401,
      'La sesión del formulario no es válida.',
    )
  }
  if (session.provider !== PROVIDER
    || session.flow?.capability_key !== 'appointment') {
    throw new FlowDataExchangeError(
      403,
      'Este formulario no corresponde a citas.',
    )
  }
  if (session.status !== 'open'
    || Date.parse(session.expires_at) <= Date.now()) {
    throw new FlowDataExchangeError(
      410,
      'La sesión del formulario expiró. Vuelve al chat.',
    )
  }
  return session
}

function validateBusiness(
  business: AppointmentFlowBusiness | null,
): AppointmentFlowBusiness {
  if (!business
    || business.active === false
    || business.bot_active === false
    || business.suspended === true
    || business.takes_bookings !== true) {
    throw new FlowDataExchangeError(
      403,
      'Las citas no están disponibles en este momento.',
    )
  }
  return business
}

function tokenFrom(request: AppointmentFlowDataExchangeRequest): string {
  const token = typeof request.flow_token === 'string'
    ? request.flow_token.trim()
    : ''
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

const intentFrom = (
  request: AppointmentFlowDataExchangeRequest,
  data: DataRecord,
): string => (
  request.action === 'data_exchange'
    ? String(data.intent || '')
    : String(request.action || '')
)

function recordStepMetric(
  dependencies: WhatsAppFlowAppointmentDataExchangeDependencies,
  session: ResolvedFlowSession,
  eventType: string,
  discriminator = '',
): void {
  recordFlowMetricBestEffort(
    dependencies.recordFlowMetric,
    {
      businessId: session.business_id,
      provider: PROVIDER,
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

async function persistContext(
  dependencies: WhatsAppFlowAppointmentDataExchangeDependencies,
  session: ResolvedFlowSession,
  flowToken: string,
  context: AppointmentContext,
): Promise<void> {
  const result = await dependencies.updateFlowSessionContext(
    session.business_id,
    PROVIDER,
    flowToken,
    session.context_revision,
    context,
  )
  if (result.result === 'stale') {
    throw new FlowDataExchangeError(
      409,
      'El formulario cambió. Intenta nuevamente.',
    )
  }
  if (result.result !== 'updated') {
    throw new FlowDataExchangeError(
      410,
      'La sesión del formulario ya no está disponible.',
    )
  }
}

function inferredScreen(context: AppointmentContext): string {
  if (context.appointment_draft) return 'APPOINTMENT_REVIEW'
  if (context.booking_time) return 'APPOINTMENT_DETAILS'
  if (context.booking_date) return 'APPOINTMENT_TIME'
  if (context.service_id) return 'APPOINTMENT_DATE'
  return 'APPOINTMENT_SERVICE'
}

async function backResponse(
  dependencies: WhatsAppFlowAppointmentDataExchangeDependencies,
  session: ResolvedFlowSession,
  currentScreen: string,
  context: AppointmentContext,
  business: AppointmentFlowBusiness,
  services: CanonicalService[],
): Promise<AppointmentFlowDataExchangeResponse> {
  const service = serviceFromContext(context, services)
  if (currentScreen === 'APPOINTMENT_DATE' || !service) {
    return {
      screen: 'APPOINTMENT_SERVICE',
      data: serviceScreenData(business, services),
    }
  }
  if (currentScreen === 'APPOINTMENT_TIME') {
    const availability = await availabilityFor(
      dependencies,
      session.business_id,
      service,
    )
    return {
      screen: 'APPOINTMENT_DATE',
      data: dateScreenData(service, availability),
    }
  }
  const date = validDate(context.booking_date)
  if (currentScreen === 'APPOINTMENT_DETAILS') {
    if (!date) {
      const availability = await availabilityFor(
        dependencies,
        session.business_id,
        service,
      )
      return {
        screen: 'APPOINTMENT_DATE',
        data: dateScreenData(service, availability),
      }
    }
    const availability = await availabilityFor(
      dependencies,
      session.business_id,
      service,
    )
    const times = timeOptions(availability, date)
    if (!times.length) {
      return {
        screen: 'APPOINTMENT_DATE',
        data: dateScreenData(
          service,
          availability,
          'Esa fecha ya no tiene horarios. Elige otra.',
        ),
      }
    }
    return {
      screen: 'APPOINTMENT_TIME',
      data: timeScreenData(service, date, availability),
    }
  }
  const time = validTime(context.booking_time)
  if (currentScreen === 'APPOINTMENT_REVIEW' && date && time) {
    return {
      screen: 'APPOINTMENT_DETAILS',
      data: detailsScreenData(service, date, time),
    }
  }
  return {
    screen: 'APPOINTMENT_SERVICE',
    data: serviceScreenData(business, services),
  }
}

async function recoverableResponse(
  dependencies: WhatsAppFlowAppointmentDataExchangeDependencies,
  session: ResolvedFlowSession,
  request: AppointmentFlowDataExchangeRequest,
  intent: string,
  context: AppointmentContext,
  business: AppointmentFlowBusiness,
  services: CanonicalService[],
  error: FlowDataExchangeError,
): Promise<AppointmentFlowDataExchangeResponse> {
  const service = serviceFromContext(context, services)
  const requestedScreen = typeof request.screen === 'string'
    ? request.screen.trim()
    : ''
  const preferredScreen = intent === 'select_service'
    ? 'APPOINTMENT_SERVICE'
    : intent === 'select_date'
      ? 'APPOINTMENT_DATE'
      : intent === 'select_time'
        ? 'APPOINTMENT_TIME'
        : intent === 'review_appointment'
          ? 'APPOINTMENT_DETAILS'
          : requestedScreen

  if (!service || preferredScreen === 'APPOINTMENT_SERVICE') {
    return {
      screen: 'APPOINTMENT_SERVICE',
      data: serviceScreenData(business, services, error.publicMessage),
    }
  }

  try {
    const availability = await availabilityFor(
      dependencies,
      session.business_id,
      service,
    )
    if (preferredScreen === 'APPOINTMENT_DATE') {
      return {
        screen: 'APPOINTMENT_DATE',
        data: dateScreenData(service, availability, error.publicMessage),
      }
    }
    const date = validDate(context.booking_date)
    if (preferredScreen === 'APPOINTMENT_TIME' && date) {
      return {
        screen: 'APPOINTMENT_TIME',
        data: timeScreenData(
          service,
          date,
          availability,
          error.publicMessage,
        ),
      }
    }
    const time = validTime(context.booking_time)
    if (preferredScreen === 'APPOINTMENT_DETAILS' && date && time) {
      return {
        screen: 'APPOINTMENT_DETAILS',
        data: detailsScreenData(
          service,
          date,
          time,
          error.publicMessage,
        ),
      }
    }
  } catch {
    // Si el horario cambió mientras se preparaba el error, se vuelve al
    // servicio. Nunca se fabrican fechas u horas para intentar continuar.
  }
  return {
    screen: 'APPOINTMENT_SERVICE',
    data: serviceScreenData(business, services, error.publicMessage),
  }
}

/**
 * Handler aislado de appointment_standard. Solo acepta identificadores del
 * teléfono: nombres, duraciones, fechas y horas se vuelven a resolver contra
 * dependencias tenant-safe y se guardan mediante CAS en el contexto servidor.
 */
export function createWhatsAppFlowAppointmentDataExchangeService(
  dependencies: WhatsAppFlowAppointmentDataExchangeDependencies,
) {
  return async (
    request: AppointmentFlowDataExchangeRequest,
  ): Promise<AppointmentFlowDataExchangeResponse> => {
    if (request.action === 'ping') {
      return { data: { status: 'active' } }
    }
    if (request.version !== '3.0') {
      throw new FlowDataExchangeError(
        400,
        'La versión del formulario no es compatible.',
      )
    }

    const flowToken = tokenFrom(request)
    const requestData = asRecord(request.data)
    if (typeof requestData.error === 'string' && requestData.error.trim()) {
      const errorCode = requestData.error.trim()
        .replace(/[^A-Za-z0-9_.-]+/g, '_')
        .slice(0, 60)
      void dependencies.getFlowSessionByToken(PROVIDER, flowToken)
        .then(async (resolvedSession) => {
          if (resolvedSession) {
            recordStepMetric(
              dependencies,
              resolvedSession,
              'flow.error',
              errorCode,
            )
          }
        })
        .catch(() => undefined)
      return { data: { acknowledged: true } }
    }

    const session = validateSession(
      await dependencies.getFlowSessionByToken(PROVIDER, flowToken),
    )
    const business = validateBusiness(
      await dependencies.getBusinessById(session.business_id),
    )
    const context = contextOf(session)
    const intent = intentFrom(request, requestData)

    let services: CanonicalService[]
    try {
      services = canonicalServices(
        await dependencies.getFlowAppointmentServices(session.business_id),
        session.business_id,
      )
    } catch (error) {
      if (error instanceof FlowDataExchangeError && error.status === 409) {
        return {
          screen: 'APPOINTMENT_SERVICE',
          data: serviceScreenData(business, [], error.publicMessage),
        }
      }
      throw error
    }

    try {
      if (request.action === 'INIT') {
        recordStepMetric(dependencies, session, 'step.init')
        return {
          screen: 'APPOINTMENT_SERVICE',
          data: serviceScreenData(business, services),
        }
      }

      if (request.action === 'BACK') {
        const requestedScreen = cleanText(request.screen, 64)
          || inferredScreen(context)
        recordStepMetric(
          dependencies,
          session,
          'step.back',
          requestedScreen,
        )
        return backResponse(
          dependencies,
          session,
          requestedScreen,
          context,
          business,
          services,
        )
      }

      if (intent === 'select_service') {
        const serviceId = cleanText(requestData.service_id, 64, true) as string
        const service = services.find(candidate => candidate.id === serviceId)
        if (!service) {
          throw new FlowDataExchangeError(
            409,
            'El servicio elegido ya no está disponible.',
          )
        }
        const availability = await availabilityFor(
          dependencies,
          session.business_id,
          service,
        )
        if (!dateOptions(availability).length) {
          throw new FlowDataExchangeError(
            409,
            'No hay fechas disponibles para ese servicio en este momento.',
          )
        }
        const nextContext: AppointmentContext = {
          ...context,
          service_id: service.id,
          service_name: service.name,
          duration_minutes: service.durationMinutes,
        }
        delete nextContext.booking_date
        delete nextContext.booking_time
        delete nextContext.appointment_draft
        await persistContext(
          dependencies,
          session,
          flowToken,
          nextContext,
        )
        recordStepMetric(
          dependencies,
          session,
          'step.select_service',
          service.id,
        )
        return {
          screen: 'APPOINTMENT_DATE',
          data: dateScreenData(service, availability),
        }
      }

      const service = serviceFromContext(context, services)
      if (!service) {
        throw new FlowDataExchangeError(
          409,
          'Elige nuevamente el servicio para continuar.',
        )
      }

      if (intent === 'select_date') {
        const selectedDate = cleanText(
          requestData.booking_date,
          10,
          true,
        ) as string
        const availability = await availabilityFor(
          dependencies,
          session.business_id,
          service,
        )
        if (!validDate(selectedDate)
          || !availability.some(row => row.date === selectedDate)) {
          throw new FlowDataExchangeError(
            409,
            'La fecha elegida ya no está disponible.',
          )
        }
        if (!timeOptions(availability, selectedDate).length) {
          throw new FlowDataExchangeError(
            409,
            'La fecha elegida ya no tiene horarios disponibles.',
          )
        }
        const nextContext: AppointmentContext = {
          ...context,
          service_id: service.id,
          service_name: service.name,
          duration_minutes: service.durationMinutes,
          booking_date: selectedDate,
        }
        delete nextContext.booking_time
        delete nextContext.appointment_draft
        await persistContext(
          dependencies,
          session,
          flowToken,
          nextContext,
        )
        recordStepMetric(
          dependencies,
          session,
          'step.select_date',
          selectedDate,
        )
        return {
          screen: 'APPOINTMENT_TIME',
          data: timeScreenData(service, selectedDate, availability),
        }
      }

      const selectedDate = validDate(context.booking_date)
      if (!selectedDate) {
        throw new FlowDataExchangeError(
          409,
          'Elige nuevamente la fecha para continuar.',
        )
      }

      if (intent === 'select_time') {
        const selectedTime = cleanText(
          requestData.booking_time,
          8,
          true,
        ) as string
        const canonicalTime = validTime(selectedTime)
        const availability = await availabilityFor(
          dependencies,
          session.business_id,
          service,
        )
        if (!canonicalTime
          || !availability.some(row => (
            row.date === selectedDate && row.time === canonicalTime
          ))) {
          throw new FlowDataExchangeError(
            409,
            'La hora elegida acaba de dejar de estar disponible.',
          )
        }
        const nextContext: AppointmentContext = {
          ...context,
          service_id: service.id,
          service_name: service.name,
          duration_minutes: service.durationMinutes,
          booking_date: selectedDate,
          booking_time: canonicalTime,
        }
        delete nextContext.appointment_draft
        await persistContext(
          dependencies,
          session,
          flowToken,
          nextContext,
        )
        recordStepMetric(
          dependencies,
          session,
          'step.select_time',
          `${selectedDate}:${canonicalTime}`,
        )
        return {
          screen: 'APPOINTMENT_DETAILS',
          data: detailsScreenData(
            service,
            selectedDate,
            canonicalTime,
          ),
        }
      }

      const selectedTime = validTime(context.booking_time)
      if (!selectedTime) {
        throw new FlowDataExchangeError(
          409,
          'Elige nuevamente la hora para continuar.',
        )
      }

      if (intent === 'review_appointment') {
        const contactName = cleanText(
          requestData.contact_name,
          120,
          true,
        ) as string
        if (contactName.length < 2) {
          throw new FlowDataExchangeError(
            422,
            'Escribe un nombre válido para la solicitud.',
          )
        }
        const notes = cleanText(requestData.notes, 500)
        const availability = await availabilityFor(
          dependencies,
          session.business_id,
          service,
        )
        if (!availability.some(row => (
          row.date === selectedDate && row.time === selectedTime
        ))) {
          throw new FlowDataExchangeError(
            409,
            'Ese horario acaba de ocuparse. Elige otro para continuar.',
          )
        }
        const draft: AppointmentDraft = {
          contact_name: contactName,
          notes,
          request_status: 'pending',
        }
        const nextContext: AppointmentContext = {
          ...context,
          service_id: service.id,
          service_name: service.name,
          duration_minutes: service.durationMinutes,
          booking_date: selectedDate,
          booking_time: selectedTime,
          appointment_draft: draft,
        }
        await persistContext(
          dependencies,
          session,
          flowToken,
          nextContext,
        )
        recordStepMetric(
          dependencies,
          session,
          'step.review_appointment',
        )
        return {
          screen: 'APPOINTMENT_REVIEW',
          data: {
            flow_token: flowToken,
            service_id: service.id,
            service_name: service.name,
            booking_date: selectedDate,
            booking_time: selectedTime,
            contact_name: contactName,
            notes: notes || '',
            request_status: 'pending',
            summary: appointmentSummary(
              service,
              selectedDate,
              selectedTime,
            ),
            pending_notice: 'El negocio revisará y confirmará tu solicitud. '
              + 'Todavía no es una cita confirmada.',
          },
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
          session,
          request,
          intent,
          context,
          business,
          services,
          error,
        )
      }
      throw error
    }
  }
}
