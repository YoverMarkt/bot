// Lo que devuelve el servidor. Se declara aquí para que la app no invente
// campos: si el backend cambia, el compilador avisa antes que un cliente.

export interface Capabilities {
  /** Catálogo con carrito: comida, bebidas, retail. */
  orders: boolean
}

export interface Business {
  /**
   * Los métodos de pago que este local acepta.
   *
   * Los manda el servidor, no los decide la app: hasta el 2026-08-16 estaban
   * escritos en `CartSheet.tsx` y el dueño no elegía nada.
   */
  paymentMethods?: StorePaymentMethod[]
  id: string
  name: string
  slug: string
  type: string | null
  slogan: string | null
  description: string | null
  address: string | null
  phone: string | null
  /**
   * `true` si ese WhatsApp es el de UMBANI y no el del local.
   *
   * Cambia lo que la app le dice a quien no tiene enlace: en el marketplace el
   * enlace nace de ELEGIR un local dentro del chat de Umbani, así que hay un
   * paso más que nombrar. Con canal propio no lo hay.
   */
  phoneIsPlatform?: boolean
  capabilities: Capabilities
  /** Color del negocio. Nulo = el de la plataforma. */
  brandColor: string | null
  /** Logo del negocio, ya subido a Cloudinary. Nulo = solo el nombre. */
  logoUrl: string | null
  /** Portada a sangre de la tienda. Nulo = cabecera de tinta, sin hueco roto. */
  coverUrl: string | null
  /** Costo fijo de envío a domicilio. Informativo: el oficial lo calcula la base. */
  deliveryFee: number
  /** Minutos hasta tener el pedido listo. Lo pone el dueño en su panel. */
  prepTimeMinutes: number
  /** Minutos que suma llevarlo a domicilio. Cero = entrega en su cuadra. */
  deliveryExtraMinutes: number
  /**
   * Lo mínimo que este local prepara, SIN contar el envío. Cero = sin mínimo.
   *
   * ⚠️ Se pinta en el carrito, no solo al confirmar. La base lo exige
   * igualmente —eso es lo que manda—, pero si el cliente se enterara solo ahí
   * habría armado el carrito entero para que se lo rechacen al final.
   */
  minOrderAmount: number
}

/** Cómo dice el cliente que va a pagar. La plataforma NO cobra (regla #6). */
export type PaymentMethod = 'transferencia' | 'efectivo' | 'pago_al_retirar'

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
  categories: Category[]
  products: Product[]
  uncategorized: number
}

export interface Address {
  id: string
  label: string
  address: string
  reference: string | null
  /** El pin. Nulo = esta dirección no tiene ubicación todavía. */
  latitude?: number | string | null
  longitude?: number | string | null
  /** Metros de error del GPS. Nulo = no se sabe, que NO es lo mismo que cero. */
  accuracy_m?: number | string | null
  building_type?: string | null
  /** Lo permanente de esa casa. No es `deliveryNotes`, que es de un pedido. */
  courier_notes?: string | null
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

/**
 * Lo que el cliente eligió, agrupado por el SERVIDOR (`order-detail.ts`).
 *
 * Llega agrupado y no en crudo a propósito: el mismo plato se enseña en el
 * seguimiento, en el panel del dueño y en el WhatsApp del cliente, y agrupar
 * en cada sitio es como acabaron diciendo cosas distintas.
 */
export interface GrupoElegido {
  group: string
  items: { name: string; quantity: number }[]
}

/** Una línea del pedido, tal como la congeló la base al crearlo. */
export interface TrackedItem {
  product_name: string
  variant_name?: string | null
  /** Ya agrupado. Vacío en los pedidos anteriores al motor de opciones. */
  options?: GrupoElegido[] | null
  /** El respaldo de esos pedidos viejos: una lista plana, sin grupos. */
  extras_names?: string[] | null
  item_note?: string | null
  quantity: number
  line_total: number | string
}

/** Un pedido tal como lo ve su dueño en la pantalla de seguimiento. */
export interface TrackedOrder {
  id: string
  order_number: number
  status: string
  total: number | string | null
  /**
   * El envío que se cobró en ESTE pedido.
   *
   * ⚠️ Viaja desde el 2026-08-31 porque sin él la pantalla del comprobante no
   * cuadraba: quien vuelve debiendo veía «1× Burger Pack $12.09» y debajo
   * «Total $14.09», con los $2.00 del reparto en ningún sitio. El salto sin
   * explicar es justo lo que hace dudar de un total que se va a transferir.
   */
  shipping?: number | string | null
  currency?: string | null
  fulfillment: Fulfillment | null
  created_at: string
  /**
   * Cuándo el negocio dio el pago por bueno. Nulo = todavía no.
   *
   * No siempre viene de haber subido el comprobante aquí: el dueño lo marca
   * también cuando la captura le llegó por WhatsApp, que es como transfiere la
   * mayoría. Por eso no se puede deducir del estado.
   */
  payment_confirmed_at?: string | null
  /**
   * Lo que pidió, tal como lo congeló la base al crear el pedido.
   *
   * Son los nombres GUARDADOS, no los del catálogo de hoy: si el negocio
   * renombra un producto o le cambia el precio, el pedido tiene que seguir
   * diciendo lo que el cliente compró.
   */
  order_items?: TrackedItem[] | null
  /** El historial de estados, que es de donde sale la hora de cada paso. */
  events: { to_status: string; created_at: string }[]
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

/**
 * Un método de pago tal como lo manda el servidor para ESE negocio.
 *
 * La app pinta lo que reciba: la lista dejó de estar escrita en el código el
 * 2026-08-16, cuando se descubrió que el dueño creía que elegía cómo le pagan
 * y en realidad la tienda ofrecía los tres a todo el mundo.
 */
export type StorePaymentMethod = {
  code: string
  label: string
  help_text: string | null
  is_prepaid: boolean
  requires_proof: boolean
}
