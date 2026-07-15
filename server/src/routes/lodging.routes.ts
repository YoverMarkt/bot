import type { RequestHandler, Response } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'
import {
  LodgingServiceError,
  quoteLodging,
} from '../services/lodging'
import type { BusinessRecord } from '../services/notify'

type DataRecord = Record<string, unknown>
type PricingModel = 'per_unit' | 'per_person' | 'base_plus_extra' | 'manual'
type RequestStatus = 'confirmed' | 'rejected' | 'cancelled' | 'expired'
type BlockKind = 'manual' | 'external' | 'maintenance'

interface DatabaseResult {
  data?: unknown
  error?: { code?: string; message?: string } | null
}

const db = require('../db') as {
  getLodgingSettings(businessId: string): Promise<DataRecord | null>
  upsertLodgingSettings(businessId: string, data: DataRecord): Promise<DatabaseResult>
  getLodgingRoomTypes(businessId: string, includeInactive?: boolean): Promise<DataRecord[]>
  getLodgingRoomTypeById(businessId: string, id: string): Promise<DataRecord | null>
  createLodgingRoomType(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateLodgingRoomType(
    businessId: string,
    id: string,
    data: DataRecord,
  ): Promise<DatabaseResult>
  archiveLodgingRoomType(businessId: string, id: string): Promise<DatabaseResult>
  getLodgingRateOverrides(
    businessId: string,
    roomTypeId?: string | null,
    from?: string | null,
    to?: string | null,
  ): Promise<DataRecord[]>
  createLodgingRateOverride(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateLodgingRateOverride(
    businessId: string,
    id: string,
    data: DataRecord,
  ): Promise<DatabaseResult>
  deleteLodgingRateOverride(businessId: string, id: string): Promise<DatabaseResult>
  getLodgingRequests(
    businessId: string,
    status?: string | null,
    from?: string | null,
    to?: string | null,
  ): Promise<DataRecord[]>
  expireLodgingHolds(businessId: string): Promise<DatabaseResult>
  getLodgingRequestById(
    businessId: string,
    requestId: string,
  ): Promise<DataRecord | null>
  setLodgingRequestStatus(
    businessId: string,
    requestId: string,
    status: string,
  ): Promise<DatabaseResult>
  getLodgingBlocks(
    businessId: string,
    from?: string | null,
    to?: string | null,
    includeReleased?: boolean,
  ): Promise<DataRecord[]>
  upsertLodgingBlock(
    businessId: string,
    blockId: string | null,
    data: DataRecord,
  ): Promise<DatabaseResult>
  releaseLodgingBlock(businessId: string, blockId: string): Promise<DatabaseResult>
  getBusinessById(businessId: string): Promise<(BusinessRecord & {
    id: string
    name: string
  }) | null>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'owner',
    content: string,
  ): Promise<unknown>
}
const notifyService = require('../services/notify') as {
  sendToContact(
    business: BusinessRecord,
    phone: string,
    message: string,
  ): Promise<void>
}
const auth = require('../middleware/auth') as {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}

const router = createRouter()
const canManageLodging = auth.requirePermission('hospedaje')
const pricingModels: PricingModel[] = [
  'per_unit',
  'per_person',
  'base_plus_extra',
  'manual',
]
const requestStatuses: RequestStatus[] = [
  'confirmed',
  'rejected',
  'cancelled',
  'expired',
]
const blockKinds: BlockKind[] = ['manual', 'external', 'maintenance']
const supportedCurrencies = new Set([
  'USD',
  'EUR',
  'COP',
  'PEN',
  'MXN',
  'BRL',
  'CLP',
  'ARS',
])
const settingsDefaults = {
  currency: 'USD',
  tax_rate: 0,
  service_fee: 0,
  quote_expiry_minutes: 15,
  hold_minutes: 45,
  check_in_time: '15:00',
  check_out_time: '11:00',
  prices_include_tax: true,
} as const

class InvalidLodgingInput extends Error {}

const requireLodgingCapability: RequestHandler = (req, res, next) => {
  const user = req.user as Express.ClientUserClaims | undefined
  if (user?.lodgingEnabled === true) return next()
  return res.status(403).json({ error: 'Este negocio no tiene hospedaje habilitado' })
}

function isRecord(value: unknown): value is DataRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function numberField(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum
    || (integer && !Number.isInteger(parsed))) {
    throw new InvalidLodgingInput(`${name} es inválido`)
  }
  return parsed
}

function nullableMoney(value: unknown, name: string): number | null {
  if (value === null || value === undefined || value === '') return null
  return numberField(value, name, 0, 1_000_000)
}

function nullablePositiveMoney(value: unknown, name: string): number | null {
  const amount = nullableMoney(value, name)
  if (amount !== null && amount <= 0) {
    throw new InvalidLodgingInput(`${name} debe ser mayor a cero`)
  }
  return amount
}

function textField(
  value: unknown,
  name: string,
  maximum: number,
  required = false,
): string | null {
  if (value === null || value === undefined) {
    if (required) throw new InvalidLodgingInput(`${name} es obligatorio`)
    return null
  }
  if (typeof value !== 'string') throw new InvalidLodgingInput(`${name} es inválido`)
  const clean = value.trim()
  if ((required && !clean) || clean.length > maximum) {
    throw new InvalidLodgingInput(`${name} es inválido`)
  }
  return clean || null
}

function dateField(value: unknown, name: string): string {
  const clean = textField(value, name, 10, true) as string
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new InvalidLodgingInput(`${name} es inválida`)
  }
  const parsed = new Date(`${clean}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clean) {
    throw new InvalidLodgingInput(`${name} es inválida`)
  }
  return clean
}

function timeField(value: unknown, name: string): string {
  const clean = textField(value, name, 8, true) as string
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(clean)) {
    throw new InvalidLodgingInput(`${name} debe usar el formato HH:MM`)
  }
  return clean.slice(0, 5)
}

function normalizedSettings(row: DataRecord | null): DataRecord {
  const settings: DataRecord = { ...settingsDefaults }
  if (row) Object.assign(settings, row)
  settings.check_in_time = timeField(settings.check_in_time, 'Hora de entrada')
  settings.check_out_time = timeField(settings.check_out_time, 'Hora de salida')
  return settings
}

function stringArray(value: unknown, name: string, urlsOnly = false): string[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) {
    throw new InvalidLodgingInput(`${name} es inválido`)
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.length > 2048) {
      throw new InvalidLodgingInput(`${name} es inválido`)
    }
    const clean = item.trim()
    if (urlsOnly) {
      try {
        if (new URL(clean).protocol !== 'https:') throw new Error('protocolo')
      } catch {
        throw new InvalidLodgingInput('Cada archivo debe usar una URL HTTPS válida')
      }
    }
    return clean
  })
}

function sanitizeSettings(body: unknown): DataRecord {
  if (!isRecord(body)) throw new InvalidLodgingInput('Configuración inválida')
  const data: DataRecord = {}
  if ('currency' in body) {
    const currency = textField(body.currency, 'Moneda', 3, true) as string
    if (!supportedCurrencies.has(currency.toUpperCase())) {
      throw new InvalidLodgingInput('Moneda inválida')
    }
    data.currency = currency.toUpperCase()
  }
  if ('tax_rate' in body) data.tax_rate = numberField(body.tax_rate, 'Impuesto', 0, 1)
  if ('service_fee' in body) {
    data.service_fee = numberField(body.service_fee, 'Cargo de servicio', 0, 1_000_000)
  }
  if ('quote_expiry_minutes' in body) {
    data.quote_expiry_minutes = numberField(
      body.quote_expiry_minutes,
      'Vigencia de cotización',
      1,
      1440,
      true,
    )
  }
  if ('hold_minutes' in body) {
    data.hold_minutes = numberField(body.hold_minutes, 'Duración del hold', 5, 1440, true)
  }
  if ('check_in_time' in body) {
    data.check_in_time = timeField(body.check_in_time, 'Hora de entrada')
  }
  if ('check_out_time' in body) {
    data.check_out_time = timeField(body.check_out_time, 'Hora de salida')
  }
  if ('prices_include_tax' in body) {
    if (typeof body.prices_include_tax !== 'boolean') {
      throw new InvalidLodgingInput('La configuración de impuestos es inválida')
    }
    data.prices_include_tax = body.prices_include_tax
  }
  return data
}

function sanitizeRoomType(body: unknown): DataRecord {
  if (!isRecord(body)) throw new InvalidLodgingInput('Tipo de habitación inválido')
  const name = textField(body.name, 'Nombre', 120, true)
  const totalUnits = numberField(body.total_units, 'Habitaciones', 1, 10_000, true)
  const maxGuests = numberField(body.max_guests, 'Capacidad', 1, 100, true)
  const baseOccupancy = numberField(
    body.base_occupancy ?? 1,
    'Ocupación base',
    1,
    maxGuests,
    true,
  )
  if (typeof body.pricing_model !== 'string'
    || !pricingModels.includes(body.pricing_model as PricingModel)) {
    throw new InvalidLodgingInput('Modelo de precio inválido')
  }
  const pricingModel = body.pricing_model as PricingModel
  const baseRate = nullableMoney(body.base_rate, 'Tarifa base')
  if (pricingModel !== 'manual' && (baseRate === null || baseRate <= 0)) {
    throw new InvalidLodgingInput('La tarifa base debe ser mayor a cero')
  }
  const manualPricing = pricingModel === 'manual'
  const weekendRate = manualPricing
    ? null
    : nullablePositiveMoney(body.weekend_rate, 'Tarifa de fin de semana')
  return {
    name,
    total_units: totalUnits,
    max_guests: maxGuests,
    pricing_model: pricingModel,
    base_occupancy: baseOccupancy,
    base_rate: manualPricing ? null : baseRate,
    weekend_rate: weekendRate,
    // PostgreSQL mantiene estas columnas NOT NULL. Para una cotización manual
    // son valores neutros y el RPC nunca los usa para calcular dinero.
    extra_adult_rate: manualPricing
      ? 0
      : nullableMoney(body.extra_adult_rate, 'Adulto adicional') || 0,
    child_rate: manualPricing
      ? 0
      : nullableMoney(body.child_rate, 'Tarifa de niño') || 0,
    description: textField(body.description, 'Descripción', 5000),
    amenities: stringArray(body.amenities, 'Servicios'),
    media_urls: stringArray(body.media_urls, 'Archivos', true),
    active: body.active !== false,
  }
}

function sanitizeRateOverride(body: unknown): DataRecord {
  if (!isRecord(body)) throw new InvalidLodgingInput('Tarifa especial inválida')
  const closed = body.closed === true
  const baseRate = nullablePositiveMoney(body.base_rate, 'Tarifa especial')
  if (!closed && baseRate === null) {
    throw new InvalidLodgingInput('La tarifa especial debe ser mayor a cero')
  }
  return {
    room_type_id: textField(body.room_type_id, 'Tipo de habitación', 80, true),
    rate_date: dateField(body.rate_date, 'Fecha'),
    base_rate: baseRate,
    extra_adult_rate: nullableMoney(body.extra_adult_rate, 'Adulto adicional'),
    child_rate: nullableMoney(body.child_rate, 'Tarifa de niño'),
    closed,
    notes: textField(body.notes, 'Notas', 2000),
  }
}

function sanitizeBlock(body: unknown): DataRecord {
  if (!isRecord(body)) throw new InvalidLodgingInput('Bloqueo inválido')
  if (typeof body.kind !== 'string' || !blockKinds.includes(body.kind as BlockKind)) {
    throw new InvalidLodgingInput('Tipo de bloqueo inválido')
  }
  const startDate = dateField(body.start_date, 'Fecha inicial')
  const endDate = dateField(body.end_date, 'Fecha final')
  if (endDate <= startDate) {
    throw new InvalidLodgingInput('La fecha final debe ser posterior a la inicial')
  }
  return {
    room_type_id: textField(body.room_type_id, 'Tipo de habitación', 80, true),
    kind: body.kind,
    start_date: startDate,
    end_date: endDate,
    quantity: numberField(body.quantity, 'Cantidad', 1, 10_000, true),
    notes: textField(body.notes, 'Notas', 2000),
  }
}

function assertDatabaseResult(result: DatabaseResult, operation: string): unknown {
  if (result.error) throw new Error(`${operation}: ${result.error.message || 'Error desconocido'}`)
  return result.data
}

function safeFailure(res: Response, operation: string, error: unknown) {
  if (error instanceof InvalidLodgingInput) {
    return res.status(400).json({ error: error.message })
  }
  console.error(`❌ ${operation}:`, error instanceof Error ? error.message : 'Error desconocido')
  return res.status(500).json({ error: `No se pudo ${operation}` })
}

function rpcPayload(result: DatabaseResult, operation: string): DataRecord {
  const data = assertDatabaseResult(result, operation)
  return isRecord(data) ? data : {}
}

function moneyText(value: unknown, currency: unknown): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return ''
  const code = typeof currency === 'string' && supportedCurrencies.has(currency)
    ? currency
    : 'USD'
  return code === 'USD'
    ? `$${amount.toFixed(2)} USD`
    : `${amount.toFixed(2)} ${code}`
}

function lodgingStatusMessage(
  status: RequestStatus,
  request: DataRecord,
  businessName: string,
  settings: DataRecord,
): string | null {
  const room = typeof request.room_type_name === 'string'
    ? ` para *${request.room_type_name}*`
    : ''
  const checkInTime = typeof settings.check_in_time === 'string'
    ? settings.check_in_time
    : settingsDefaults.check_in_time
  const checkOutTime = typeof settings.check_out_time === 'string'
    ? settings.check_out_time
    : settingsDefaults.check_out_time
  const dates = request.check_in && request.check_out
    ? `, con entrada el *${request.check_in}* desde *${checkInTime}* y salida el *${request.check_out}* hasta *${checkOutTime}*`
    : ''
  if (status === 'confirmed') {
    const total = moneyText(request.total, request.currency)
    return `✅ Tu solicitud de hospedaje${room}${dates} en *${businessName}* quedó confirmada.${total ? ` Total del alojamiento: *${total}*.` : ''} El equipo continuará contigo para coordinar los detalles.`
  }
  if (status === 'rejected') {
    return `⚠️ Tu solicitud de hospedaje${room}${dates} en *${businessName}* no pudo ser confirmada. El equipo puede ayudarte a revisar otras opciones.`
  }
  if (status === 'cancelled') {
    return `ℹ️ Tu solicitud de hospedaje${room}${dates} en *${businessName}* fue cancelada. Si deseas otras fechas, escríbenos y te ayudamos.`
  }
  return null
}

const guards = [auth.authClient, canManageLodging, requireLodgingCapability] as const

router.get('/api/client/lodging/settings', ...guards, async (req, res) => {
  res.json(normalizedSettings(
    await db.getLodgingSettings(getClientBusinessId(req)),
  ))
})

router.put('/api/client/lodging/settings', ...guards, async (req, res) => {
  try {
    const data = assertDatabaseResult(
      await db.upsertLodgingSettings(getClientBusinessId(req), sanitizeSettings(req.body)),
      'actualizar hospedaje',
    )
    res.json(normalizedSettings(isRecord(data) ? data : null))
  } catch (error) {
    safeFailure(res, 'actualizar hospedaje', error)
  }
})

router.get('/api/client/lodging/room-types', ...guards, async (req, res) => {
  res.json(await db.getLodgingRoomTypes(
    getClientBusinessId(req),
    req.query.includeInactive === 'true',
  ))
})

router.post('/api/client/lodging/room-types', ...guards, async (req, res) => {
  try {
    const data = assertDatabaseResult(
      await db.createLodgingRoomType(getClientBusinessId(req), sanitizeRoomType(req.body)),
      'crear el tipo de habitación',
    )
    res.status(201).json(data)
  } catch (error) {
    safeFailure(res, 'crear el tipo de habitación', error)
  }
})

router.put('/api/client/lodging/room-types/:id', ...guards, async (req, res) => {
  try {
    const businessId = getClientBusinessId(req)
    const current = await db.getLodgingRoomTypeById(businessId, req.params.id)
    if (!current) return res.status(404).json({ error: 'Tipo de habitación no encontrado' })
    const data = assertDatabaseResult(
      await db.updateLodgingRoomType(
        businessId,
        req.params.id,
        sanitizeRoomType({ ...current, ...req.body }),
      ),
      'actualizar el tipo de habitación',
    )
    res.json(data)
  } catch (error) {
    safeFailure(res, 'actualizar el tipo de habitación', error)
  }
})

router.delete('/api/client/lodging/room-types/:id', ...guards, async (req, res) => {
  try {
    const data = assertDatabaseResult(
      await db.archiveLodgingRoomType(getClientBusinessId(req), req.params.id),
      'archivar el tipo de habitación',
    )
    if (!data) return res.status(404).json({ error: 'Tipo de habitación no encontrado' })
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'archivar el tipo de habitación', error)
  }
})

router.get('/api/client/lodging/rate-overrides', ...guards, async (req, res) => {
  res.json(await db.getLodgingRateOverrides(
    getClientBusinessId(req),
    typeof req.query.roomTypeId === 'string' ? req.query.roomTypeId : null,
    typeof req.query.from === 'string' ? req.query.from : null,
    typeof req.query.to === 'string' ? req.query.to : null,
  ))
})

router.post('/api/client/lodging/rate-overrides', ...guards, async (req, res) => {
  try {
    const data = assertDatabaseResult(
      await db.createLodgingRateOverride(
        getClientBusinessId(req),
        sanitizeRateOverride(req.body),
      ),
      'crear la tarifa especial',
    )
    res.status(201).json(data)
  } catch (error) {
    safeFailure(res, 'crear la tarifa especial', error)
  }
})

router.put('/api/client/lodging/rate-overrides/:id', ...guards, async (req, res) => {
  try {
    const data = assertDatabaseResult(
      await db.updateLodgingRateOverride(
        getClientBusinessId(req),
        req.params.id,
        sanitizeRateOverride(req.body),
      ),
      'actualizar la tarifa especial',
    )
    if (!data) return res.status(404).json({ error: 'Tarifa especial no encontrada' })
    res.json(data)
  } catch (error) {
    safeFailure(res, 'actualizar la tarifa especial', error)
  }
})

router.delete('/api/client/lodging/rate-overrides/:id', ...guards, async (req, res) => {
  try {
    const data = assertDatabaseResult(
      await db.deleteLodgingRateOverride(getClientBusinessId(req), req.params.id),
      'eliminar la tarifa especial',
    )
    if (!data) return res.status(404).json({ error: 'Tarifa especial no encontrada' })
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'eliminar la tarifa especial', error)
  }
})

router.get('/api/client/lodging/availability', ...guards, async (req, res) => {
  try {
    const quote = await quoteLodging({
      businessId: getClientBusinessId(req),
      contactPhone: textField(req.query.contactPhone, 'Contacto', 120, true) as string,
      contactName: textField(req.query.contactName, 'Nombre', 200),
      checkIn: dateField(req.query.checkIn, 'Entrada'),
      checkOut: dateField(req.query.checkOut, 'Salida'),
      adults: numberField(req.query.adults, 'Adultos', 1, 100, true),
      children: numberField(req.query.children ?? 0, 'Niños', 0, 100, true),
      roomsCount: numberField(req.query.rooms ?? 1, 'Habitaciones', 1, 100, true),
    })
    res.json(quote)
  } catch (error) {
    if (error instanceof LodgingServiceError) {
      const status = error.code === 'lodging_disabled' ? 403
        : error.code === 'invalid_input' ? 400
          : 500
      return res.status(status).json({ error: error.message, code: error.code })
    }
    safeFailure(res, 'consultar disponibilidad', error)
  }
})

router.post('/api/client/lodging/availability', ...guards, async (req, res) => {
  try {
    if (!isRecord(req.body)) throw new InvalidLodgingInput('Consulta inválida')
    const user = req.user as Express.ClientUserClaims
    const quote = await quoteLodging({
      businessId: getClientBusinessId(req),
      contactPhone: textField(
        req.body.contactPhone ?? req.body.contact_phone ?? `panel-preview:${user.userId || 'owner'}`,
        'Contacto',
        120,
        true,
      ) as string,
      contactName: textField(req.body.contactName ?? req.body.contact_name, 'Nombre', 200),
      checkIn: dateField(req.body.checkIn ?? req.body.check_in, 'Entrada'),
      checkOut: dateField(req.body.checkOut ?? req.body.check_out, 'Salida'),
      adults: numberField(req.body.adults, 'Adultos', 1, 100, true),
      children: numberField(req.body.children ?? 0, 'Niños', 0, 100, true),
      roomsCount: numberField(
        req.body.rooms ?? req.body.rooms_count ?? 1,
        'Habitaciones',
        1,
        100,
        true,
      ),
    })
    res.json(quote)
  } catch (error) {
    if (error instanceof LodgingServiceError) {
      const status = error.code === 'lodging_disabled' ? 403
        : error.code === 'invalid_input' ? 400
          : 500
      return res.status(status).json({ error: error.message, code: error.code })
    }
    safeFailure(res, 'consultar disponibilidad', error)
  }
})

router.get('/api/client/lodging/requests', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  assertDatabaseResult(await db.expireLodgingHolds(businessId), 'depurar solicitudes vencidas')
  res.json(await db.getLodgingRequests(
    businessId,
    typeof req.query.status === 'string' ? req.query.status : null,
    typeof req.query.from === 'string' ? req.query.from : null,
    typeof req.query.to === 'string' ? req.query.to : null,
  ))
})

router.put('/api/client/lodging/requests/:id/status', ...guards, async (req, res) => {
  const status = isRecord(req.body) ? req.body.status : null
  if (typeof status !== 'string' || !requestStatuses.includes(status as RequestStatus)) {
    return res.status(400).json({ error: 'Estado inválido' })
  }
  try {
    const businessId = getClientBusinessId(req)
    const current = await db.getLodgingRequestById(businessId, req.params.id)
    if (!current) return res.status(404).json({ error: 'Solicitud no encontrada' })
    const payload = rpcPayload(
      await db.setLodgingRequestStatus(
        businessId,
        req.params.id,
        status,
      ),
      'actualizar la solicitud',
    )
    if (payload.result === 'not_found') {
      return res.status(404).json({ error: 'Solicitud no encontrada' })
    }
    if (payload.result === 'expired' || payload.result === 'invalid_transition') {
      return res.status(409).json({
        error: payload.result === 'expired'
          ? 'La solicitud venció y ya no se puede confirmar'
          : 'El cambio de estado no está permitido',
        code: payload.result,
      })
    }
    const updated = isRecord(payload.request) ? payload.request : current
    const contactPhone = typeof updated.contact_phone === 'string'
      ? updated.contact_phone
      : typeof current.contact_phone === 'string' ? current.contact_phone : null
    let notificationSent = false
    if (payload.result === 'updated' && payload.changed === true && contactPhone) {
      try {
        const business = await db.getBusinessById(businessId)
        const settings = normalizedSettings(await db.getLodgingSettings(businessId))
        const message = business
          ? lodgingStatusMessage(
            status as RequestStatus,
            { ...current, ...updated },
            business.name,
            settings,
          )
          : null
        if (business && message) {
          await notifyService.sendToContact(business, contactPhone, message)
          notificationSent = true
          try {
            await db.saveMessage(businessId, contactPhone, 'owner', message)
          } catch (error) {
            console.error(
              '❌ Registro de notificación de hospedaje:',
              error instanceof Error ? error.message : 'Error desconocido',
            )
          }
        }
      } catch (error) {
        console.error(
          '❌ Notificación de hospedaje:',
          error instanceof Error ? error.message : 'Error desconocido',
        )
      }
    }
    res.json({
      request: updated,
      changed: payload.changed === true,
      notificationSent,
    })
  } catch (error) {
    safeFailure(res, 'actualizar la solicitud', error)
  }
})

router.get('/api/client/lodging/blocks', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  assertDatabaseResult(await db.expireLodgingHolds(businessId), 'depurar solicitudes vencidas')
  res.json(await db.getLodgingBlocks(
    businessId,
    typeof req.query.from === 'string' ? req.query.from : null,
    typeof req.query.to === 'string' ? req.query.to : null,
    req.query.includeReleased === 'true',
  ))
})

router.post('/api/client/lodging/blocks', ...guards, async (req, res) => {
  try {
    const payload = rpcPayload(
      await db.upsertLodgingBlock(
        getClientBusinessId(req),
        null,
        sanitizeBlock(req.body),
      ),
      'crear el bloqueo',
    )
    if (payload.result === 'unavailable') {
      return res.status(409).json({ error: 'El bloqueo supera las habitaciones disponibles' })
    }
    res.status(201).json(payload.block || payload)
  } catch (error) {
    safeFailure(res, 'crear el bloqueo', error)
  }
})

router.put('/api/client/lodging/blocks/:id', ...guards, async (req, res) => {
  try {
    const payload = rpcPayload(
      await db.upsertLodgingBlock(
        getClientBusinessId(req),
        req.params.id,
        sanitizeBlock(req.body),
      ),
      'actualizar el bloqueo',
    )
    if (payload.result === 'not_found') {
      return res.status(404).json({ error: 'Bloqueo no encontrado' })
    }
    if (payload.result === 'forbidden') {
      return res.status(403).json({
        error: 'Los cupos de una solicitud solo se liberan cambiando su estado',
      })
    }
    if (payload.result === 'unavailable') {
      return res.status(409).json({ error: 'El bloqueo supera las habitaciones disponibles' })
    }
    res.json(payload.block || payload)
  } catch (error) {
    safeFailure(res, 'actualizar el bloqueo', error)
  }
})

router.delete('/api/client/lodging/blocks/:id', ...guards, async (req, res) => {
  try {
    const payload = rpcPayload(
      await db.releaseLodgingBlock(getClientBusinessId(req), req.params.id),
      'liberar el bloqueo',
    )
    if (payload.result === 'not_found') {
      return res.status(404).json({ error: 'Bloqueo no encontrado' })
    }
    if (payload.result === 'forbidden') {
      return res.status(403).json({
        error: 'Los cupos de una solicitud solo se liberan cambiando su estado',
      })
    }
    res.json({ ok: true })
  } catch (error) {
    safeFailure(res, 'liberar el bloqueo', error)
  }
})

export = router
