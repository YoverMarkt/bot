import type { BookingTag } from './bot-tags'

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

interface ActionLogger {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
}

export interface BotActionDependencies {
  database: DatabaseActions
  money: MoneyActions
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
  // Ítems ya estructurados (modo menú): el nombre resuelve el precio y `note`
  // es el modificador de la línea (p. ej. el sabor). Si vienen, se usan tal
  // cual en vez de parsear el string `payload`.
  items?: { name: string; qty: number; note?: string | null }[]
  products: ActionProduct[]
  preFiltered: boolean
  send(message: string): Promise<unknown>
}

function createBotActions(dependencies: BotActionDependencies) {
  const { database, money } = dependencies
  const logger = dependencies.logger || console

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
    const needsHandoff = hasHandoffTag || isUncertain
    if (needsHandoff) {
      if (!wasManual) {
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
      }
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
    } else {
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
      // Modo menú: ítems estructurados con su modificador (sabor). Modo IA:
      // se parsea el string ##PEDIDO##.
      const parsed = input.items?.length
        ? input.items.map(item => ({
          name: String(item.name || '').trim(),
          qty: Math.min(Math.max(Number(item.qty) || 1, 1), 99),
          note: item.note || null,
        }))
        : money.parseItems(input.payload)
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
  }
}

const actions = createBotActions({
  database: require('../db') as DatabaseActions,
  money: require('./money') as MoneyActions,
})

export const createBookingFromTag = actions.createBookingFromTag
export const handleConversationOutcome = actions.handleConversationOutcome
export const processOrderPayload = actions.processOrderPayload
export { createBotActions }
