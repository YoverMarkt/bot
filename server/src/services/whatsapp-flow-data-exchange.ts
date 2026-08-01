import {
  WHATSAPP_FLOW_CATALOG_MODIFIER_LIMIT,
  WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT,
  type FlowProvider,
  type FlowSessionContextUpdateResult,
  type JsonObject,
  type ResolvedFlowSession,
} from '../db/repositories/whatsapp-flows'
import { recordFlowMetricBestEffort } from './whatsapp-flow-metrics'

const PROVIDER: FlowProvider = 'ycloud'
const MAX_TOKEN_LENGTH = 512
const MAX_ITEMS = 3
const MAX_DYNAMIC_OPTIONS = 200
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type DataRecord = Record<string, unknown>

interface FlowBusiness extends DataRecord {
  id?: string
  name?: string | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
  takes_orders?: boolean | null
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
  lead_enabled?: boolean | null
  payment_methods?: string | null
}

interface FlowProduct extends DataRecord {
  id?: string
  name?: string | null
  price?: number | string | null
  price_sale?: number | string | null
  stock?: string | null
  tags?: string[] | null
  active?: boolean | null
}

interface FlowModifier extends DataRecord {
  id?: string
  category_tag?: string | null
  group_label?: string | null
  name?: string | null
  active?: boolean | null
}

interface CartItem {
  product_id: string
  quantity: number
  modifier_ids: string[]
  note: string | null
}

interface CanonicalItem extends CartItem {
  product_name: string
  modifier_names: string[]
  unit_price_cents: number
  line_total_cents: number
}

interface OrderContext extends JsonObject {
  fulfillment?: string
  items?: CartItem[]
  order_draft?: JsonObject
}

export interface FlowDataExchangeRequest {
  version?: unknown
  action?: unknown
  screen?: unknown
  data?: unknown
  flow_token?: unknown
}

export interface FlowDataExchangeResponse {
  screen?: string
  data: DataRecord
}

export interface WhatsAppFlowDataExchangeDependencies {
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
  ): Promise<FlowSessionContextUpdateResult>
  getBusinessById(businessId: string): Promise<FlowBusiness | null>
  getFlowCatalogProducts(businessId: string): Promise<FlowProduct[]>
  getFlowCatalogModifiers(businessId: string): Promise<FlowModifier[]>
  getFlowAppointmentServices?(businessId: string): Promise<DataRecord[]>
  getFlowAppointmentAvailability?(input: {
    businessId: string
    serviceId: string | null
    durationMinutes: number | null
    daysAhead: number
  }): Promise<DataRecord[]>
  quoteLodging?(input: {
    businessId: string
    contactPhone: string
    checkIn: string
    checkOut: string
    adults: number
    children: number
    roomsCount: number
    idempotencyKey: string
  }): Promise<unknown>
  getLodgingQuoteById?(
    businessId: string,
    quoteId: string,
  ): Promise<unknown | null>
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

export class FlowDataExchangeError extends Error {
  status: number
  publicMessage: string

  constructor(status: number, message: string) {
    super(message)
    this.name = 'FlowDataExchangeError'
    this.status = status
    this.publicMessage = message
  }
}

class FlowCatalogLimitError extends FlowDataExchangeError {
  constructor() {
    super(
      409,
      'El catálogo es demasiado grande para mostrarlo completo aquí. '
      + 'Cierra el formulario y continúa el pedido por el chat.',
    )
    this.name = 'FlowCatalogLimitError'
  }
}

const asRecord = (value: unknown): DataRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as DataRecord
    : {}
)

const normalized = (value: unknown): string => String(value || '')
  .trim()
  .toLocaleLowerCase('es')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64)

const cleanText = (
  value: unknown,
  maximum: number,
  required = false,
): string | null => {
  if (value === undefined || value === null) {
    if (required) throw new FlowDataExchangeError(422, 'Completa los campos obligatorios.')
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

const priceCents = (product: FlowProduct): number | null => {
  const value = Number(product.price_sale ?? product.price)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`
const optionTitle = (value: unknown): string => {
  const clean = String(value || '').trim()
  return clean.length <= 30 ? clean : `${clean.slice(0, 29)}…`
}
const headingText = (value: unknown): string => {
  const clean = String(value || '').trim()
  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`
}

const availableProducts = (products: FlowProduct[]): FlowProduct[] => (
  [...new Map(products.filter(product => (
    product.active !== false
    && product.stock !== 'agotado'
    && UUID_PATTERN.test(String(product.id || ''))
    && Boolean(String(product.name || '').trim())
    && priceCents(product) !== null
  )).map(product => [String(product.id), product])).values()]
)

interface Category {
  id: string
  title: string
}

const categories = (products: FlowProduct[]): Category[] => {
  const choices = new Map<string, string>()
  for (const product of products) {
    for (const tag of product.tags || []) {
      const title = String(tag || '').trim()
      const id = normalized(title)
      if (id && !choices.has(id)) choices.set(id, title)
    }
  }
  if (!choices.size) return [{ id: '__all__', title: 'Todos' }]
  const hasUntagged = products.some(product => !(product.tags || []).some(tag => normalized(tag)))
  if (hasUntagged) choices.set('__other__', 'Otros')
  if (choices.size > MAX_DYNAMIC_OPTIONS) throw new FlowCatalogLimitError()
  return [...choices].map(([id, title]) => ({ id, title: optionTitle(title) }))
}

const productInCategory = (product: FlowProduct, categoryId: string): boolean => {
  if (categoryId === '__all__') return true
  const tags = product.tags || []
  if (categoryId === '__other__') return !tags.some(tag => normalized(tag))
  return tags.some(tag => normalized(tag) === categoryId)
}

const productsForCategory = (
  products: FlowProduct[],
  categoryId: string,
): FlowProduct[] => products.filter(product => productInCategory(product, categoryId))

const productOptions = (products: FlowProduct[]): DataRecord[] => products.map(product => ({
  id: String(product.id),
  title: optionTitle(
    `${String(product.name).trim()} · ${money(priceCents(product) as number)}`,
  ),
}))

const modifiersForCategory = (
  modifiers: FlowModifier[],
  categoryId: string,
): FlowModifier[] => modifiers.filter(modifier => (
  modifier.active !== false
  && UUID_PATTERN.test(String(modifier.id || ''))
  && Boolean(String(modifier.name || '').trim())
    && (
      categoryId === '__all__'
      || normalized(modifier.category_tag) === categoryId
    )
))

const modifierOptions = (modifiers: FlowModifier[]): DataRecord[] => (
  modifiers.length
    ? modifiers.map(modifier => ({
      id: String(modifier.id),
      title: optionTitle(modifier.name),
    }))
    : [{ id: 'none', title: 'Sin opción adicional' }]
)

const contextOf = (session: ResolvedFlowSession): OrderContext => (
  asRecord(session.context) as OrderContext
)

const cartItems = (context: OrderContext): CartItem[] => {
  if (!Array.isArray(context.items)) return []
  return context.items.flatMap((value) => {
    const item = asRecord(value)
    const productId = String(item.product_id || '')
    const quantity = Number(item.quantity)
    const modifierIds = Array.isArray(item.modifier_ids)
      ? item.modifier_ids.map(String)
      : []
    if (!UUID_PATTERN.test(productId)
      || !Number.isInteger(quantity)
      || quantity < 1
      || quantity > 99
      || modifierIds.some(id => !UUID_PATTERN.test(id))) {
      return []
    }
    return [{
      product_id: productId,
      quantity,
      modifier_ids: modifierIds,
      note: typeof item.note === 'string' && item.note.trim()
        ? item.note.trim().slice(0, 240)
        : null,
    }]
  }).slice(0, MAX_ITEMS)
}

const canonicalizeCart = (
  items: CartItem[],
  products: FlowProduct[],
  modifiers: FlowModifier[],
): CanonicalItem[] => items.map((item) => {
  const product = products.find(candidate => candidate.id === item.product_id)
  const unitPrice = product ? priceCents(product) : null
  if (!product || unitPrice === null) {
    throw new FlowDataExchangeError(
      409,
      'Un producto ya no está disponible. Regresa y vuelve a seleccionarlo.',
    )
  }
  const allowedCategories = new Set((product.tags || []).map(normalized))
  const selectedModifiers = item.modifier_ids.map((id) => {
    const modifier = modifiers.find(candidate => candidate.id === id)
    if (!modifier || modifier.active === false
      || !allowedCategories.has(normalized(modifier.category_tag))) {
      throw new FlowDataExchangeError(
        409,
        'Una opción del producto ya no está disponible. Regresa y vuelve a seleccionarla.',
      )
    }
    return modifier
  })
  return {
    ...item,
    product_name: String(product.name).trim(),
    modifier_names: selectedModifiers.map(modifier => String(modifier.name).trim()),
    unit_price_cents: unitPrice,
    line_total_cents: unitPrice * item.quantity,
  }
})

const cartSummary = (items: CanonicalItem[]): string => (
  items.length
    ? items.map((item) => {
      const modifier = item.modifier_names.length
        ? ` (${item.modifier_names.join(', ')})`
        : ''
      return `${item.quantity} × ${item.product_name}${modifier} — ${money(item.line_total_cents)}`
    }).join('\n')
    : 'Tu pedido todavía está vacío.'
)

function paymentMethods(value?: string | null): DataRecord[] {
  const labels = String(value || '')
    .split(/[\n,;|]+/)
    .map(label => label.trim())
    .filter(Boolean)
  const effective = labels.length ? labels : ['Efectivo']
  const unique = new Map<string, string>()
  for (const [index, title] of effective.entries()) {
    const id = normalized(title) || `payment-${index + 1}`
    if (!unique.has(id)) unique.set(id, title)
    if (unique.size >= 10) break
  }
  return [...unique].map(([id, title]) => ({
    id,
    title: optionTitle(title),
  }))
}

const fulfillmentOptions = (): DataRecord[] => [
  { id: 'delivery', title: 'Entrega a domicilio' },
  { id: 'pickup', title: 'Retiro en el local' },
  { id: 'onsite', title: 'Consumir en el local' },
]

const itemScreen = (position: number): string => {
  if (position === 1) return 'ORDER_ITEM_ONE'
  if (position === 2) return 'ORDER_ITEM_TWO'
  return 'ORDER_ITEM_THREE'
}

function backTarget(screen: string | null, itemCount: number): string {
  if (screen === 'ORDER_ITEM_ONE') return 'ORDER_METHOD'
  if (screen === 'ORDER_ITEM_TWO') return 'ORDER_ITEM_ONE'
  if (screen === 'ORDER_ITEM_THREE') return 'ORDER_ITEM_TWO'
  if (screen === 'ORDER_DETAILS') {
    return itemScreen(Math.max(1, Math.min(itemCount, MAX_ITEMS)))
  }
  if (screen === 'ORDER_REVIEW') return 'ORDER_DETAILS'
  return 'ORDER_METHOD'
}

function catalogData(
  products: FlowProduct[],
  modifiers: FlowModifier[],
  categoryId?: string | null,
): DataRecord {
  const categoryOptions = categories(products)
  const selectedCategory = categoryOptions.some(option => option.id === categoryId)
    ? categoryId as string
    : categoryOptions[0]?.id || '__all__'
  const selectedProducts = productsForCategory(products, selectedCategory)
  return {
    categories: categoryOptions,
    products: productOptions(selectedProducts),
    modifiers: modifierOptions(modifiersForCategory(modifiers, selectedCategory)),
  }
}

function orderDetailsData(
  context: OrderContext,
  business: FlowBusiness,
  canonicalItems: CanonicalItem[],
): DataRecord {
  return {
    fulfillment: String(context.fulfillment || ''),
    payment_methods: paymentMethods(business.payment_methods),
    items_json: JSON.stringify(cartItems(context)),
    cart_summary: cartSummary(canonicalItems),
    error_message: '',
  }
}

function recoverableErrorResponse(
  request: FlowDataExchangeRequest,
  requestData: DataRecord,
  error: FlowDataExchangeError,
  context: OrderContext,
  business: FlowBusiness,
  products: FlowProduct[],
  modifiers: FlowModifier[],
): FlowDataExchangeResponse {
  const requestedScreen = typeof request.screen === 'string'
    ? request.screen.trim()
    : ''
  const position = Number(requestData.item_position)
  const inferredItemScreen = Number.isInteger(position)
    && position >= 1
    && position <= MAX_ITEMS
    ? itemScreen(position)
    : null
  const validScreen = [
    'ORDER_METHOD',
    'ORDER_ITEM_ONE',
    'ORDER_ITEM_TWO',
    'ORDER_ITEM_THREE',
    'ORDER_DETAILS',
  ].includes(requestedScreen)
    ? requestedScreen
    : null
  const intent = String(requestData.intent || '')
  const screen = validScreen
    || (intent === 'start_order'
      ? 'ORDER_METHOD'
      : inferredItemScreen
        || (intent === 'review_order' ? 'ORDER_DETAILS' : null))
    || (context.fulfillment ? 'ORDER_DETAILS' : 'ORDER_METHOD')

  let canonicalItems: CanonicalItem[] = []
  try {
    canonicalItems = canonicalizeCart(cartItems(context), products, modifiers)
  } catch {
    // El propio cambio del catálogo puede ser la causa del error recuperable.
    // Se conserva el contexto en servidor y se deja al cliente corregirlo.
  }

  if (screen === 'ORDER_METHOD') {
    return {
      screen,
      data: {
        business_name: headingText(business.name || 'Nuestro negocio'),
        fulfillment_options: fulfillmentOptions(),
        error_message: error.publicMessage,
      },
    }
  }
  if (/^ORDER_ITEM_(?:ONE|TWO|THREE)$/.test(screen)) {
    const category = typeof requestData.category_id === 'string'
      ? requestData.category_id
      : null
    return {
      screen,
      data: {
        ...catalogData(products, modifiers, category),
        cart_summary: cartSummary(canonicalItems),
        error_message: error.publicMessage,
      },
    }
  }
  return {
    screen: 'ORDER_DETAILS',
    data: {
      ...orderDetailsData(context, business, canonicalItems),
      error_message: error.publicMessage,
    },
  }
}

function catalogLimitResponse(
  business: FlowBusiness,
  error: FlowCatalogLimitError,
): FlowDataExchangeResponse {
  return {
    screen: 'ORDER_METHOD',
    data: {
      business_name: headingText(business.name || 'Nuestro negocio'),
      fulfillment_options: fulfillmentOptions(),
      error_message: error.publicMessage,
    },
  }
}

function backResponse(
  currentScreen: string | null,
  context: OrderContext,
  business: FlowBusiness,
  products: FlowProduct[],
  modifiers: FlowModifier[],
  flowToken: string,
): FlowDataExchangeResponse {
  const items = cartItems(context)
  const canonicalItems = canonicalizeCart(items, products, modifiers)
  const screen = backTarget(currentScreen, items.length)
  if (screen === 'ORDER_METHOD') {
    return {
      screen,
      data: {
        business_name: headingText(business.name || 'Nuestro negocio'),
        fulfillment_options: fulfillmentOptions(),
        error_message: '',
      },
    }
  }
  if (/^ORDER_ITEM_(?:ONE|TWO|THREE)$/.test(screen)) {
    return {
      screen,
      data: {
        ...catalogData(products, modifiers),
        cart_summary: cartSummary(canonicalItems),
        error_message: '',
      },
    }
  }
  if (screen === 'ORDER_DETAILS') {
    return {
      screen,
      data: orderDetailsData(context, business, canonicalItems),
    }
  }

  const draft = asRecord(context.order_draft)
  const totalCents = canonicalItems.reduce(
    (total, item) => total + item.line_total_cents,
    0,
  )
  return {
    screen: 'ORDER_REVIEW',
    data: {
      flow_token: flowToken,
      fulfillment: String(context.fulfillment || ''),
      items_json: JSON.stringify(items),
      contact_name: String(draft.contact_name || ''),
      address: String(draft.address || ''),
      address_reference: String(draft.address_reference || ''),
      payment_method: String(draft.payment_method || ''),
      requested_for: String(draft.requested_for || ''),
      notes: String(draft.notes || ''),
      summary: cartSummary(canonicalItems),
      total: money(totalCents),
    },
  }
}

function validateSession(session: ResolvedFlowSession | null): ResolvedFlowSession {
  if (!session) throw new FlowDataExchangeError(401, 'La sesión del formulario no es válida.')
  if (session.provider !== PROVIDER) {
    throw new FlowDataExchangeError(403, 'Este formulario no corresponde al proveedor.')
  }
  if (session.status !== 'open' || Date.parse(session.expires_at) <= Date.now()) {
    throw new FlowDataExchangeError(410, 'La sesión del formulario expiró. Vuelve al chat.')
  }
  return session
}

function validateBusiness(business: FlowBusiness | null): FlowBusiness {
  if (!business
    || business.active === false
    || business.bot_active === false
    || business.suspended === true) {
    throw new FlowDataExchangeError(403, 'Este formulario no está disponible en este momento.')
  }
  return business
}

function validateOrderBusiness(
  session: ResolvedFlowSession,
  business: FlowBusiness,
): FlowBusiness {
  if (session.flow?.capability_key !== 'order'
    || business.takes_orders !== true) {
    throw new FlowDataExchangeError(
      403,
      'Este formulario no corresponde a pedidos.',
    )
  }
  return business
}

function recordStepMetric(
  dependencies: WhatsAppFlowDataExchangeDependencies,
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
  dependencies: WhatsAppFlowDataExchangeDependencies,
  session: ResolvedFlowSession,
  flowToken: string,
  context: OrderContext,
): Promise<void> {
  const result = await dependencies.updateFlowSessionContext(
    session.business_id,
    PROVIDER,
    flowToken,
    session.context_revision,
    context,
  )
  if (result.result === 'stale') {
    throw new FlowDataExchangeError(409, 'El formulario cambió. Intenta nuevamente.')
  }
  if (result.result !== 'updated') {
    throw new FlowDataExchangeError(410, 'La sesión del formulario ya no está disponible.')
  }
}

function tokenFrom(request: FlowDataExchangeRequest): string {
  const token = typeof request.flow_token === 'string'
    ? request.flow_token.trim()
    : ''
  if (!token
    || token.length > MAX_TOKEN_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new FlowDataExchangeError(400, 'El token del formulario no es válido.')
  }
  return token
}

function intentFrom(request: FlowDataExchangeRequest, data: DataRecord): string {
  const action = String(request.action || '')
  if (action === 'data_exchange') return String(data.intent || '')
  return action
}

export function createWhatsAppFlowDataExchangeService(
  dependencies: WhatsAppFlowDataExchangeDependencies,
) {
  return async (
    request: FlowDataExchangeRequest,
  ): Promise<FlowDataExchangeResponse> => {
    if (request.action === 'ping') {
      return { data: { status: 'active' } }
    }
    if (request.version !== '3.0') {
      throw new FlowDataExchangeError(400, 'La versión del formulario no es compatible.')
    }

    const flowToken = tokenFrom(request)
    const requestData = asRecord(request.data)
    // YCloud pide acuse explícito de sus notificaciones de error. No se guarda
    // error_message (puede contener datos del cliente); solo un código acotado.
    // La observabilidad es deliberadamente asíncrona: una caída de la base no
    // debe impedir el ACK ni provocar que el proveedor repita la notificación.
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

    const resolvedSession = await dependencies.getFlowSessionByToken(
      PROVIDER,
      flowToken,
    )
    const session = validateSession(resolvedSession)
    const business = validateBusiness(
      await dependencies.getBusinessById(session.business_id),
    )
    const capability = String(session.flow?.capability_key || '')

    if (capability === 'appointment') {
      // Carga diferida: los handlers especializados importan la clase de error
      // de este módulo y no deben crear un ciclo durante su inicialización.
      const appointment = require(
        './whatsapp-flow-data-exchange-appointment'
      ) as typeof import('./whatsapp-flow-data-exchange-appointment')
      return appointment.createWhatsAppFlowAppointmentDataExchangeService(
        dependencies as unknown as
          import('./whatsapp-flow-data-exchange-appointment')
            .WhatsAppFlowAppointmentDataExchangeDependencies,
      )(request)
    }

    if (capability === 'lodging') {
      if (!dependencies.quoteLodging || !dependencies.getLodgingQuoteById) {
        throw new FlowDataExchangeError(
          503,
          'La cotización de hospedaje no está disponible en este momento.',
        )
      }
      if (!business.id || business.id !== session.business_id) {
        throw new FlowDataExchangeError(
          403,
          'El formulario no pertenece a este negocio.',
        )
      }
      const lodging = require(
        './whatsapp-flow-data-exchange-lodging'
      ) as typeof import('./whatsapp-flow-data-exchange-lodging')
      return lodging.createWhatsAppFlowLodgingDataExchangeHandler(
        dependencies as unknown as
          import('./whatsapp-flow-data-exchange-lodging')
            .LodgingFlowDependencies,
      )({
        request,
        session: session as unknown as
          import('./whatsapp-flow-data-exchange-lodging').LodgingFlowSession,
        business: business as
          import('./whatsapp-flow-data-exchange-lodging').LodgingFlowBusiness,
        flowToken,
      })
    }

    if (capability === 'lead') {
      const lead = require(
        './whatsapp-flow-data-exchange-lead'
      ) as typeof import('./whatsapp-flow-data-exchange-lead')
      return lead.handleLeadFlowDataExchange({
        request,
        session,
        business,
        flowToken,
      }, dependencies)
    }

    validateOrderBusiness(session, business)
    const intent = intentFrom(request, requestData)
    const [catalogProducts, catalogModifiers] = await Promise.all([
      dependencies.getFlowCatalogProducts(session.business_id),
      dependencies.getFlowCatalogModifiers(session.business_id),
    ])
    const products = availableProducts(catalogProducts)
    const modifiers = [
      ...new Map(catalogModifiers
        .filter(modifier => modifier.active !== false)
        .map(modifier => [String(modifier.id), modifier]))
        .values(),
    ]
    const currentContext = contextOf(session)
    const currentItems = cartItems(currentContext)

    try {
    if (catalogProducts.length > WHATSAPP_FLOW_CATALOG_PRODUCT_LIMIT
      || catalogModifiers.length > WHATSAPP_FLOW_CATALOG_MODIFIER_LIMIT) {
      // El repositorio consulta límite + 1. Si llega el centinela, se falla de
      // forma visible: nunca se presenta al cliente un catálogo incompleto.
      throw new FlowCatalogLimitError()
    }
    if (!products.length) {
      throw new FlowDataExchangeError(409, 'No hay productos disponibles en este momento.')
    }
    if (request.action === 'BACK') {
      const currentScreen = cleanText(request.screen, 64)
      const inferredScreen = currentScreen
        || (currentContext.order_draft
          ? 'ORDER_REVIEW'
          : currentItems.length
            ? 'ORDER_DETAILS'
            : currentContext.fulfillment
              ? 'ORDER_ITEM_ONE'
              : 'ORDER_METHOD')
      recordStepMetric(
        dependencies,
        session,
        'step.back',
        inferredScreen,
      )
      return backResponse(
        inferredScreen,
        currentContext,
        business,
        products,
        modifiers,
        flowToken,
      )
    }

    if (request.action === 'INIT') {
      recordStepMetric(dependencies, session, 'step.init')
      return {
        screen: 'ORDER_METHOD',
        data: {
          business_name: headingText(business.name || 'Nuestro negocio'),
          fulfillment_options: fulfillmentOptions(),
          error_message: '',
        },
      }
    }

    if (intent === 'start_order') {
      const fulfillment = cleanText(requestData.fulfillment, 20, true) as string
      if (!['delivery', 'pickup', 'onsite'].includes(fulfillment)) {
        throw new FlowDataExchangeError(422, 'Elige una modalidad de entrega válida.')
      }
      const nextContext: OrderContext = {
        ...currentContext,
        fulfillment,
        items: [],
      }
      delete nextContext.order_draft
      await persistContext(dependencies, session, flowToken, nextContext)
      recordStepMetric(
        dependencies,
        session,
        'step.start_order',
        fulfillment,
      )
      return {
        screen: 'ORDER_ITEM_ONE',
        data: {
          ...catalogData(products, modifiers),
          cart_summary: cartSummary([]),
          error_message: '',
        },
      }
    }

    if (intent === 'load_products') {
      const position = Number(requestData.item_position)
      if (!Number.isInteger(position) || position < 1 || position > MAX_ITEMS) {
        throw new FlowDataExchangeError(422, 'La posición del producto no es válida.')
      }
      const categoryId = cleanText(requestData.category_id, 120, true) as string
      const data = catalogData(products, modifiers, categoryId)
      if (!(data.products as unknown[]).length) {
        throw new FlowDataExchangeError(409, 'No hay productos disponibles en esa categoría.')
      }
      recordStepMetric(
        dependencies,
        session,
        'step.load_products',
        `${position}:${categoryId}`,
      )
      return {
        screen: itemScreen(position),
        data: {
          ...data,
          cart_summary: cartSummary(canonicalizeCart(currentItems, products, modifiers)),
          error_message: '',
        },
      }
    }

    if (intent === 'save_item') {
      const position = Number(requestData.item_position)
      const quantity = Number(requestData.quantity)
      const categoryId = cleanText(requestData.category_id, 120, true) as string
      const productId = cleanText(requestData.product_id, 64, true) as string
      const modifierId = cleanText(requestData.modifier_id, 64) || 'none'
      const note = cleanText(requestData.item_note, 240)
      if (!Number.isInteger(position) || position < 1 || position > MAX_ITEMS
        || position > currentItems.length + 1
        || !Number.isInteger(quantity) || quantity < 1 || quantity > 99
        || !UUID_PATTERN.test(productId)) {
        throw new FlowDataExchangeError(422, 'El producto o la cantidad no son válidos.')
      }
      const selectedProduct = products.find(product => (
        product.id === productId && productInCategory(product, categoryId)
      ))
      if (!selectedProduct) {
        throw new FlowDataExchangeError(409, 'El producto ya no está disponible.')
      }
      const allowedModifiers = modifiersForCategory(modifiers, categoryId)
      const selectedModifier = modifierId === 'none'
        ? null
        : allowedModifiers.find(modifier => modifier.id === modifierId)
      if (modifierId !== 'none' && !selectedModifier) {
        throw new FlowDataExchangeError(409, 'La opción elegida ya no está disponible.')
      }
      const nextItems = [...currentItems]
      nextItems[position - 1] = {
        product_id: productId,
        quantity,
        modifier_ids: selectedModifier ? [String(selectedModifier.id)] : [],
        note,
      }
      const compactItems = nextItems.filter(Boolean).slice(0, MAX_ITEMS)
      const nextContext: OrderContext = {
        ...currentContext,
        items: compactItems,
      }
      await persistContext(dependencies, session, flowToken, nextContext)
      recordStepMetric(
        dependencies,
        session,
        'step.save_item',
        String(position),
      )
      const canonicalItems = canonicalizeCart(compactItems, products, modifiers)
      const nextStep = String(requestData.next_step || 'finish_items')
      if (nextStep === 'add_more' && position < MAX_ITEMS) {
        return {
          screen: itemScreen(position + 1),
          data: {
            ...catalogData(products, modifiers),
            cart_summary: cartSummary(canonicalItems),
            error_message: '',
          },
        }
      }
      return {
        screen: 'ORDER_DETAILS',
        data: orderDetailsData(nextContext, business, canonicalItems),
      }
    }

    if (intent === 'review_order') {
      if (!currentItems.length) {
        throw new FlowDataExchangeError(422, 'Agrega al menos un producto al pedido.')
      }
      const fulfillment = String(currentContext.fulfillment || '')
      if (!['delivery', 'pickup', 'onsite'].includes(fulfillment)) {
        throw new FlowDataExchangeError(422, 'La modalidad de entrega no es válida.')
      }
      const contactName = cleanText(requestData.contact_name, 120, true) as string
      const address = cleanText(requestData.address, 500)
      if (fulfillment === 'delivery' && !address) {
        throw new FlowDataExchangeError(422, 'Escribe la dirección para la entrega.')
      }
      const addressReference = cleanText(requestData.address_reference, 500)
      const paymentMethod = cleanText(requestData.payment_method, 120, true) as string
      const validPaymentMethods = paymentMethods(business.payment_methods)
      if (!validPaymentMethods.some(method => method.id === paymentMethod)) {
        throw new FlowDataExchangeError(422, 'El método de pago no es válido.')
      }
      const requestedFor = cleanText(requestData.requested_for, 80)
      const notes = cleanText(requestData.notes, 1000)
      const canonicalItems = canonicalizeCart(currentItems, products, modifiers)
      const totalCents = canonicalItems.reduce(
        (total, item) => total + item.line_total_cents,
        0,
      )
      const canonicalPayload: JsonObject = {
        fulfillment,
        items: currentItems,
        contact_name: contactName,
        address,
        address_reference: addressReference,
        payment_method: paymentMethod,
        requested_for: requestedFor,
        notes,
        total_cents: totalCents,
      }
      await persistContext(dependencies, session, flowToken, {
        ...currentContext,
        items: currentItems,
        order_draft: canonicalPayload,
      })
      recordStepMetric(dependencies, session, 'step.review_order')
      return {
        screen: 'ORDER_REVIEW',
        data: {
          flow_token: flowToken,
          fulfillment,
          items_json: JSON.stringify(currentItems),
          contact_name: contactName,
          address: address || '',
          address_reference: addressReference || '',
          payment_method: paymentMethod,
          requested_for: requestedFor || '',
          notes: notes || '',
          summary: cartSummary(canonicalItems),
          total: money(totalCents),
        },
      }
    }

    throw new FlowDataExchangeError(422, 'La acción del formulario no es válida.')
    } catch (error) {
      if (error instanceof FlowCatalogLimitError) {
        return catalogLimitResponse(business, error)
      }
      if (error instanceof FlowDataExchangeError
        && (error.status === 409 || error.status === 422)) {
        return recoverableErrorResponse(
          request,
          requestData,
          error,
          currentContext,
          business,
          products,
          modifiers,
        )
      }
      throw error
    }
  }
}
