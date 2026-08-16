interface ErrorLike { message?: string }
interface MutationResult<T = unknown> {
  data?: T | null
  error?: ErrorLike | null
  duplicate?: boolean
  conflict?: boolean
}

export interface ActionBusiness {
  id: string
  name: string
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
  products: ActionProduct[]
  preFiltered: boolean
  send(message: string): Promise<unknown>
}

function createBotActions(dependencies: BotActionDependencies) {
  const { database, money } = dependencies
  const logger = dependencies.logger || console

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
    handleConversationOutcome,
    processOrderPayload,
  }
}

const actions = createBotActions({
  database: require('../db') as DatabaseActions,
  money: require('./money') as MoneyActions,
})

export const handleConversationOutcome = actions.handleConversationOutcome
export const processOrderPayload = actions.processOrderPayload
export { createBotActions }
