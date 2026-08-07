// Lo que devuelve el servidor. Se declara aquí para que la app no invente
// campos: si el backend cambia, el compilador avisa antes que un cliente.

export interface Capabilities {
  /** Catálogo con carrito: comida, bebidas, retail. */
  orders: boolean
  /** Estadías por fechas: hotel, hostal. */
  lodging: boolean
}

export interface Business {
  id: string
  name: string
  slug: string
  type: string | null
  slogan: string | null
  description: string | null
  address: string | null
  phone: string | null
  capabilities: Capabilities
  /** Color del negocio. Nulo = el de la plataforma. */
  brandColor: string | null
  /** Logo del negocio, ya subido a Cloudinary. Nulo = solo el nombre. */
  logoUrl: string | null
  /** Costo fijo de envío a domicilio. Informativo: el oficial lo calcula la base. */
  deliveryFee: number
}

/** Cómo dice el cliente que va a pagar. La plataforma NO cobra (regla #6). */
export type PaymentMethod = 'transferencia' | 'efectivo'

export type StoreStatus = 'abierta' | 'cerrada' | 'no_disponible' | 'suspendida'

export interface Category {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
}

export interface Variant {
  id: string
  name: string
  price: number
  priceSale: number | null
}

export interface Extra {
  id: string
  group: string
  name: string
  description: string | null
  price: number
  maxSelectable: number | null
}

/** Una opción concreta dentro de un grupo. El recargo puede ser NEGATIVO. */
export interface OptionChoice {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
  price: number
  referencesProductId: string | null
  defaultSelected: boolean
}

/**
 * Cómo se arma un plato. Los tres tipos son los tres selectores reales:
 *   single   → un radio. Tamaño de pizza, término de la carne.
 *   multiple → casillas con tope. Ingredientes, salsas.
 *   quantity → cada opción con su contador. Cortes de una parrillada.
 */
/** Cómo cobra el grupo. La base calcula igual: ver `services/pricing.ts`. */
export type PricingStrategy =
  | 'sum' | 'fixed' | 'highest_selected' | 'lowest_selected'
  | 'average' | 'included' | 'included_up_to_limit' | 'extra_after_limit'

export interface OptionGroup {
  id: string
  name: string
  description: string | null
  selectionType: 'single' | 'multiple' | 'quantity'
  pricingStrategy: PricingStrategy
  /** Cuántas van sin recargo en las dos estrategias con límite. */
  freeSelections: number
  required: boolean
  minSelectable: number
  maxSelectable: number
  options: OptionChoice[]
}

/** Lo que el cliente eligió de un grupo. `quantity` es 1 salvo en los contadores. */
export interface ChosenOption {
  groupId: string
  groupName: string
  optionId: string
  name: string
  price: number
  quantity: number
}

/**
 * Qué CLASE de producto es. No es un `if` por tipo de comida: dice si el
 * producto se arma eligiendo otros. Un combo de hamburguesas y uno de pizzas
 * recorren el mismo camino.
 */
export type ProductType = 'simple' | 'configurable' | 'combo' | 'daily_menu' | 'weighted'

/**
 * Un adicional: OTRO producto que se ofrece junto a este. No es una opción del
 * plato — al elegirlo entra al carrito como su propia línea, porque es algo
 * más que preparar y algo más que contar en el reporte de ventas.
 */
export interface Recommendation {
  section: string
  productId: string
  name: string
  description: string | null
  imageUrl: string | null
  price: number
}

export interface Product {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
  videoUrl: string | null
  categoryId: string | null
  tags: string[]
  available: boolean
  productType: ProductType
  /** Con variantes es un "desde"; sin ellas, el precio final. */
  priceFrom: number | null
  hasVariants: boolean
  variants: Variant[]
  extras: Extra[]
  optionGroups: OptionGroup[]
  recommendations: Recommendation[]
}

/** El horario vigente en «HH:MM». Nulo = hoy no se abre, y la portada calla. */
export interface TodaysHours {
  open: string
  close: string
}

export interface Catalog {
  business: Business | null
  status: StoreStatus
  canOrder: boolean
  /** El horario que se enseña en la portada, junto a la píldora de estado. */
  todaysHours?: TodaysHours | null
  /** Horas a las que el negocio puede tener el pedido listo, ya en ISO. */
  scheduleSlots?: string[]
  categories: Category[]
  products: Product[]
  uncategorized: number
}

export interface Address {
  id: string
  label: string
  address: string
  reference: string | null
  is_default: boolean
}

export interface Me {
  phone: string
  name: string | null
  addresses: Address[]
}

/** Una línea del carrito, ya resuelta contra el catálogo. */
export interface CartLine {
  /** Identidad de la línea: mismo producto con distintos extras son dos líneas. */
  key: string
  product: Product
  variant: Variant | null
  extras: Extra[]
  options: ChosenOption[]
  quantity: number
  note: string
  /** Solo para pintar. El importe que se cobra lo calcula el servidor. */
  unitPrice: number
}

export type Fulfillment = 'delivery' | 'pickup' | 'onsite'

export interface OrderResult {
  id?: string
  order_number?: number | string
  total?: number | string
  [key: string]: unknown
}

export interface BankAccount {
  bank_name?: string | null
  account_type?: string | null
  account_number?: string | null
  holder_name?: string | null
  holder_id?: string | null
  instructions?: string | null
  [key: string]: unknown
}

// ── Hospedaje ──────────────────────────────────────────────────────────────

export interface StayOption {
  roomTypeId: string
  name: string
  description: string | null
  maxGuests: number
  availableUnits: number
  unitsRequired: number
  currency: string
  pricesIncludeTax: boolean
  subtotal: number | null
  tax: number | null
  fees: number | null
  total: number | null
  amenities: string[]
  mediaUrls: string[]
}

export interface StayQuote {
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
  options: StayOption[]
  status: StoreStatus
  canRequest: boolean
}

export interface StayRequest {
  requestId: string
  roomTypeName: string
  checkIn: string
  checkOut: string
  checkInTime: string
  checkOutTime: string
  nights: number
  total: number
  currency: string
  expiresAt: string
  /** Siempre false: esto es una retención, la confirma el equipo. */
  confirmed: boolean
}
