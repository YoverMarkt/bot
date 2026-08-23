// Modo MENÚ (estilo banco): toda la conversación la conduce el CÓDIGO con
// opciones generadas desde los datos reales del negocio. La IA no participa:
// los textos son plantillas mínimas y los precios salen del catálogo. Si el
// cliente escribe algo fuera del menú, se le vuelve
// a mostrar el menú (fallo cerrado) o se deriva al equipo. Los totales los
// calcula SIEMPRE el servidor.

interface FlowBusiness {
  id: string
  name?: string | null
  takes_orders?: boolean | null
}

interface FlowProduct {
  id: string
  name?: string | null
  price?: number | string | null
  price_sale?: number | string | null
  description?: string | null
  stock?: string | null
  tags?: string[] | null
  image_url?: string | null
  video_url?: string | null
  active?: boolean | null
}

// Modificador de menú (p. ej. el SABOR de la pizza): opción que el cliente
// elige además del producto, sin cambiar el precio. Agrupado por category_tag.
interface FlowModifier {
  category_tag?: string | null
  group_label?: string | null
  name?: string | null
  description?: string | null
}

interface CartItem {
  productId: string
  name: string
  quantity: number
  priceCents: number
  // Modificador elegido (p. ej. el sabor). Viaja pegado a la línea del pedido.
  //
  // ⚠️ Es el sistema VIEJO (`menu_modifiers`): un texto suelto, colgado de la
  // categoría entera. Se conserva para los negocios que aún lo usan, pero lo
  // que se elige por `option_groups` va en `options` — estructurado, con su
  // id, y lo guarda `order_item_options`.
  modifier?: string
  /** Opciones del motor de personalización, con su id real. */
  options?: ChosenOption[]
}

/** Una opción elegida del motor: id real, para que la base la valide. */
export interface ChosenOption {
  optionId: string
  groupName: string
  name: string
}

/** Un grupo de opciones tal como lo lee `getStorefrontOptionGroups`. */
export interface FlowOptionGroup {
  id: string
  product_id?: string | null
  category_id?: string | null
  name?: string | null
  selection_type?: string | null
  required?: boolean | null
  sort?: number | null
}

/** Una opción de un grupo, tal como la lee `getStorefrontOptions`. */
export interface FlowOption {
  id: string
  option_group_id?: string | null
  name?: string | null
  price_adjustment?: number | string | null
  stock?: string | null
  sort?: number | null
}

type FlowView =
  | { kind: 'main' }
  | { kind: 'categories'; intent: 'order' | 'browse'; page: number }
  // Paso de modificador (sabor): antes de elegir el producto/tamaño, cuando la
  // categoría tiene modificadores y el cliente está pidiendo.
  | { kind: 'modifier'; tag: string; page: number }
  | { kind: 'products'; intent: 'order' | 'browse'; tag: string | null; page: number }
  | { kind: 'product'; intent: 'order' | 'browse'; productId: string; tag: string | null; page: number; mediaShown?: boolean }
  // Un grupo de opciones del motor, de uno en uno. `groupIndex` dice por cuál
  // va: así el cliente contesta una pregunta por mensaje, como en el banco.
  | { kind: 'options'; productId: string; tag: string | null; groupIndex: number }
  | { kind: 'quantity'; productId: string }
  | { kind: 'after-add' }
  | { kind: 'order-confirm' }

interface FlowState {
  view: FlowView
  cart: CartItem[]
  // Modificador elegido (sabor) pendiente de adjuntar al producto/tamaño
  pendingModifier?: string
  /** Opciones ya elegidas para el producto que se está armando. */
  pendingOptions?: ChosenOption[]
  updatedAt: number
}

type FlowAction =
  | { type: 'handoff' }
  // `payload` va en el MISMO formato que ##PEDIDO:producto x cantidad; ...##
  // para que el canal real lo procese con money.ts y las RPC atómicas de
  // siempre: el menú no crea un camino de dinero paralelo.
  // `payload` es respaldo (formato ##PEDIDO##); `items` lleva cada línea con su
  // modificador (sabor) para que money.ts calcule el precio por el producto y
  // pliegue el sabor en el nombre visible.
  | {
      type: 'order'
      summary: string
      totalCents: number
      payload: string
      // `note` es el modificador VIEJO (texto). `options` son las del motor,
      // con su id real, y son las que acaban en `order_item_options`.
      items: {
        name: string
        qty: number
        note?: string | null
        productId?: string
        options?: ChosenOption[]
      }[]
    }

// Ítems del último pedido del contacto. Solo se reutilizan producto y cantidad:
// el precio SIEMPRE se recalcula con el catálogo vigente, nunca el histórico.
export interface LastOrderItem {
  product_id?: string | null
  product_name?: string | null
  quantity?: number | null
}

export interface MenuFlowInput {
  business: FlowBusiness
  contact: string
  message: string
  products: FlowProduct[]
  // El prompt no decide precios, disponibilidad ni transiciones. Solo permite
  // respetar el nombre, tono o saludo que configuró el dueño al dar la
  // bienvenida en este flujo determinista.
  /** El saludo que escribió el dueño. Se muestra TAL CUAL. */
  welcomeMessage?: string | null
  modifiers?: FlowModifier[]
  lastOrderItems?: LastOrderItem[]
  /**
   * El motor de personalización: los mismos grupos y opciones que usa la mini
   * app. Cuando un producto tiene grupos, se preguntan DESPUÉS de elegirlo —
   * al revés que `menu_modifiers`, que preguntaba el sabor antes de saber si
   * el cliente quería un jugo o una cola, y se lo pegaba a las dos cosas.
   */
  optionGroups?: FlowOptionGroup[]
  options?: FlowOption[]
  /** La categoría de cada producto, para los grupos que cuelgan de ella. */
  productCategories?: Record<string, string | null>
}

// Una opción puede ser texto simple (las fijas del menú, ya cortas) o un
// objeto con descripción, como las filas de lista de WhatsApp: título corto
// arriba y el detalle debajo (precio, capacidad). Igual que el menú del banco.
export type MenuOption = string | { title: string; description?: string }

// Archivo de un producto que el bot envía cuando el cliente
// pide verlo. `isVideo` decide si va por sendVideo o sendImage en el canal real.
export interface FlowMediaItem {
  url: string
  isVideo: boolean
}

export interface MenuFlowResult {
  reply: string
  options: MenuOption[]
  image?: string | null
  // Fotos y videos a enviar (paso "Ver fotos y videos"): fotos primero, video
  // al final. El ejecutor los manda con sendImage/sendVideo existentes.
  media?: FlowMediaItem[]
  action?: FlowAction
  // El cliente acaba de llegar (o volvió al inicio). Lo usa el ejecutor para
  // adjuntar el enlace de la tienda, que necesita base de datos y por eso no
  // se puede armar aquí: este servicio es puro a propósito.
  isWelcome?: boolean
}

// ── Etiquetas fijas del menú (el cliente ve exactamente estos textos) ──
const OPT_ORDER = '🛒 Hacer un pedido'
const OPT_REPEAT = '🔄 Repetir mi último pedido'
const OPT_BROWSE = '📋 Ver productos y precios'
const OPT_MEDIA = '📷 Ver fotos y videos'
const OPT_TEAM = '💬 Hablar con el equipo'
const OPT_BACK = '⬅️ Volver'
const OPT_HOME = '🏠 Menú principal'
const OPT_MORE = '➡️ Ver más'
const OPT_ASK = '🛒 Pedirlo'
const OPT_FINISH = '✅ Finalizar pedido'
const OPT_CONFIRM = '✅ Confirmar pedido'
const OPT_EMPTY = '🗑️ Vaciar carrito'
const OPT_OTHER = '✍️ Otra cantidad'

const PAGE_SIZE = 6
// WhatsApp permite 10 filas por lista: 9 opciones + "Ver más" entran justas.
const CATEGORY_PAGE_SIZE = 9
// Modificadores (sabores): 8 + "Ver más" + "Volver" = 10.
const MODIFIER_PAGE_SIZE = 8
const FLOW_TTL_MS = 30 * 60 * 1000
const PROMPT_CHOOSE = 'Elige una opción del menú 👇'
const NOT_UNDERSTOOD = `🙏 No te entendí. ${PROMPT_CHOOSE}`

const normalizeText = (value: string): string => value
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{M}+/gu, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const parseQuantity = (message: string, max: number): number | null => {
  const match = normalizeText(message).match(/^(\d{1,3})\b/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null
}

// El título es la identidad de la opción: es lo que se compara y lo que viaja
// como texto. La descripción es solo presentación.
const optionTitle = (option: MenuOption): string => (
  typeof option === 'string' ? option : option.title
)

// El cliente puede tocar la opción (llega el título exacto) o escribir su
// número de lista, como en el banco ("1", "2", …)
const matchOption = (message: string, options: MenuOption[]): string | null => {
  const text = normalizeText(message)
  if (!text) return null
  const titles = options.map(optionTitle)
  const byLabel = titles.find(title => normalizeText(title) === text)
  if (byLabel) return byLabel
  if (/^\d{1,2}$/.test(text)) {
    const index = Number(text) - 1
    if (index >= 0 && index < titles.length) return titles[index]
  }
  return null
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`

const priceCentsOf = (product: FlowProduct): number | null => {
  const raw = product.price_sale ?? product.price
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
}

const capitalize = (value: string): string => value ? value.charAt(0).toUpperCase() + value.slice(1) : value

/**
 * Los grupos que aplican a ESTE producto: los suyos y los de su categoría.
 *
 * ⚠️ Solo `single` (elegir uno). `multiple` y `quantity` piden casillas y
 * contadores, que en una lista de WhatsApp se vuelven una conversación larga
 * y confusa; esos productos se piden en la mini app, que es justo para lo que
 * está. Aquí se filtran para no prometer lo que el chat no sabe hacer.
 */
const gruposDelProducto = (
  input: MenuFlowInput,
  productId: string,
): FlowOptionGroup[] => {
  const categoria = input.productCategories?.[productId] ?? null
  return (input.optionGroups || [])
    .filter(grupo => (
      grupo.selection_type === 'single'
      && (grupo.product_id === productId
        || (Boolean(grupo.category_id) && grupo.category_id === categoria))
    ))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
}

/** Un producto con un grupo OBLIGATORIO que el chat no sabe preguntar. */
const exigeLaApp = (input: MenuFlowInput, productId: string): boolean => {
  const categoria = input.productCategories?.[productId] ?? null
  return (input.optionGroups || []).some(grupo => (
    grupo.required === true
    && grupo.selection_type !== 'single'
    && (grupo.product_id === productId
      || (Boolean(grupo.category_id) && grupo.category_id === categoria))
  ))
}

const opcionesDelGrupo = (input: MenuFlowInput, groupId: string): FlowOption[] => (
  (input.options || [])
    .filter(opcion => opcion.option_group_id === groupId && opcion.stock !== 'agotado')
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
)

// ── Datos derivados del negocio ───────────────────────────────────────
const activeProducts = (products: FlowProduct[]): FlowProduct[] =>
  products.filter(item => item.active !== false && String(item.name || '').trim())

// La identidad de una categoría es canónica y sin tildes/puntuación, tanto para
// el dato guardado como para la opción elegida. La etiqueta visible conserva la
// escritura original del catálogo.
const canonicalTag = (value: unknown): string => normalizeText(String(value || ''))

// Las categorías son los tags reales del catálogo; sin tags suficientes se
// listan los productos directo (nada de categorías inventadas)
const categoriesOf = (products: FlowProduct[]): string[] => {
  const seen = new Set<string>()
  const labels: string[] = []
  let untagged = 0
  for (const product of activeProducts(products)) {
    const label = String(product.tags?.[0] || '').trim().toLowerCase()
    const tag = canonicalTag(label)
    if (!tag) { untagged += 1; continue }
    if (!seen.has(tag)) { seen.add(tag); labels.push(capitalize(label)) }
  }
  if (labels.length < 2) return []
  if (untagged > 0) labels.push('Otros')
  return labels
}

const productsInCategory = (products: FlowProduct[], tag: string | null): FlowProduct[] => {
  const list = activeProducts(products)
  if (tag === null) return list
  const canonical = canonicalTag(tag)
  if (canonical === 'otros') {
    return list.filter(item => !canonicalTag(item.tags?.[0]))
  }
  return list.filter(item => canonicalTag(item.tags?.[0]) === canonical)
}

// Rearma el carrito del último pedido con el catálogo VIGENTE. Si un producto
// dejó de existir, se desactivó o se agotó, se omite y se avisa: jamás se
// reutiliza el precio viejo ni se vende algo que ya no está.
const rebuildCartFromLastOrder = (
  input: MenuFlowInput,
): { cart: CartItem[]; skipped: string[] } => {
  const cart: CartItem[] = []
  const skipped: string[] = []
  const available = activeProducts(input.products)
  for (const item of input.lastOrderItems || []) {
    const quantity = Number(item.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) continue
    const wantedName = normalizeText(String(item.product_name || ''))
    const product = available.find(candidate => (
      (item.product_id && candidate.id === item.product_id)
      || (wantedName && normalizeText(String(candidate.name || '')) === wantedName)
    ))
    const cents = product ? priceCentsOf(product) : null
    if (!product || cents === null || product.stock === 'agotado') {
      skipped.push(String(item.product_name || '').trim() || 'un producto')
      continue
    }
    cart.push({
      productId: product.id,
      name: String(product.name).trim(),
      quantity,
      priceCents: cents,
    })
  }
  return { cart, skipped }
}

// El nombre va de título (corto, es lo que se compara) y el precio/stock de
// descripción. Así entra en una fila de lista de WhatsApp y se lee mejor.
const productLabel = (product: FlowProduct): string => String(product.name).trim()

const productOption = (product: FlowProduct): MenuOption => {
  const cents = priceCentsOf(product)
  const detail = [
    cents ? money(cents) : 'precio a confirmar',
    product.stock === 'agotado' ? 'agotado' : '',
  ].filter(Boolean).join(' · ')
  return { title: productLabel(product), description: detail }
}

// ── Modificadores (sabores) ───────────────────────────────────────────
const modifierLabel = (modifier: FlowModifier): string => String(modifier.name || '').trim()

// El sabor va de título y sus ingredientes de descripción, igual que el menú.
const modifierOption = (modifier: FlowModifier): MenuOption => ({
  title: modifierLabel(modifier),
  description: String(modifier.description || '').trim(),
})

// Modificadores activos de una categoría (tag), en orden y con nombre válido.
const modifiersForTag = (input: MenuFlowInput, tag: string): FlowModifier[] =>
  (input.modifiers || []).filter(modifier => (
    modifierLabel(modifier)
    && canonicalTag(modifier.category_tag) === canonicalTag(tag)
  ))

// ── Media de un producto (foto + video) para el paso "Ver fotos y videos" ──
const isHttps = (url: unknown): url is string => typeof url === 'string' && /^https:\/\//i.test(url.trim())

// Producto: su imagen y su video del catálogo (foto primero).
const productMediaList = (product?: FlowProduct | null): FlowMediaItem[] => {
  const items: FlowMediaItem[] = []
  if (isHttps(product?.image_url)) items.push({ url: product!.image_url!.trim(), isVideo: false })
  if (isHttps(product?.video_url)) items.push({ url: product!.video_url!.trim(), isVideo: true })
  return items
}

// Título del mensaje que acompaña a la media enviada ("fotos" / "fotos y el video").
const mediaCaption = (name: string, media: FlowMediaItem[]): string => {
  const hasVideo = media.some(item => item.isVideo)
  const hasPhoto = media.some(item => !item.isVideo)
  const what = hasPhoto && hasVideo ? 'las fotos y el video' : hasVideo ? 'el video' : 'las fotos'
  return `📷 Aquí tienes ${what} de *${name.trim()}* 👇`
}

const personalizarBienvenida = (valor: string, businessName: string): string => valor
  .replace(/\{\{\s*(?:nombre_negocio|negocio)\s*\}\}/gi, businessName)
  .trim()

// La bienvenida la escribe el DUEÑO y se muestra tal cual.
//
// ⚠️ Hasta el 2026-08-21 esto MINABA el prompt de la IA con expresiones
// regulares: buscaba `saludo inicial: "..."` y, si no, la identidad declarada
// («Eres Andrea, la asistente de...») para armar un saludo con ella. Tenía
// sentido mientras el dueño escribía instrucciones para un modelo; retirada la
// IA, escribe el saludo y punto.
//
// El valor por defecto sigue existiendo porque un negocio recién creado no ha
// escrito nada, y quedarse sin saludar sería peor que saludar genérico.
const configuredWelcome = (input: MenuFlowInput): string => {
  const businessName = String(input.business.name || '').trim()
  const escrito = personalizarBienvenida(
    String(input.welcomeMessage || '').trim(), businessName,
  )
  if (escrito) return escrito

  return `¡Hola! 👋 ${businessName ? `Gracias por escribir a ${businessName}` : 'Gracias por escribirnos'} 😊`
}

// ── Menú principal por capacidades reales ─────────────────────────────
const mainOptions = (input: MenuFlowInput): string[] => {
  const options: string[] = []
  const hasProducts = activeProducts(input.products).length > 0
  if (input.business.takes_orders && hasProducts) {
    options.push(OPT_ORDER)
    // Clientes recurrentes: repetir vale más que navegar todo el catálogo
    if (input.lastOrderItems?.length) options.push(OPT_REPEAT)
  }
  if (hasProducts) options.push(OPT_BROWSE)
  options.push(OPT_TEAM)
  return options
}

const welcomeReply = (input: MenuFlowInput): MenuFlowResult => {
  return {
    reply: `${configuredWelcome(input)}\n${PROMPT_CHOOSE}`,
    options: mainOptions(input),
    isWelcome: true,
  }
}

// ── Renderizado de cada vista (reply + opciones deterministas) ────────
const renderView = (view: FlowView, state: FlowState, input: MenuFlowInput): MenuFlowResult => {
  switch (view.kind) {
    case 'main':
      return { reply: `¿En qué te ayudamos? ${PROMPT_CHOOSE}`, options: mainOptions(input) }
    case 'categories': {
      // Paginadas: un negocio puede tener más de 10 categorías y la lista de
      // WhatsApp solo admite 10 filas.
      const all = categoriesOf(input.products)
      const shown = all.slice(view.page * CATEGORY_PAGE_SIZE, (view.page + 1) * CATEGORY_PAGE_SIZE)
      const hasMore = all.length > (view.page + 1) * CATEGORY_PAGE_SIZE
      return {
        reply: view.intent === 'order' ? `¿Qué te gustaría pedir? ${PROMPT_CHOOSE}` : `Estas son nuestras categorías 👇`,
        options: [
          ...shown.map(category => ({
            title: category,
            description: `${productsInCategory(input.products, normalizeText(category)).length} producto(s)`,
          })),
          ...(hasMore ? [OPT_MORE] : []),
          OPT_BACK,
        ],
      }
    }
    case 'modifier': {
      // Sabores de la categoría con sus ingredientes (título + descripción),
      // paginados. Es el primer paso al pedir: sabor → luego el tamaño.
      const mods = modifiersForTag(input, view.tag)
      const groupLabel = String(mods[0]?.group_label || 'opción').toLowerCase()
      const shown = mods.slice(view.page * MODIFIER_PAGE_SIZE, (view.page + 1) * MODIFIER_PAGE_SIZE)
      const hasMore = mods.length > (view.page + 1) * MODIFIER_PAGE_SIZE
      return {
        reply: `Elige el ${groupLabel} 👇`,
        options: [...shown.map(modifierOption), ...(hasMore ? [OPT_MORE] : []), OPT_BACK],
      }
    }
    case 'products': {
      const list = productsInCategory(input.products, view.tag)
      const page = list.slice(view.page * PAGE_SIZE, view.page * PAGE_SIZE + PAGE_SIZE)
      const hasMore = list.length > (view.page + 1) * PAGE_SIZE
      // Al pedir con sabor ya elegido, el paso siguiente es el tamaño.
      const orderPrompt = state.pendingModifier
        ? `Ahora elige el tamaño 👇`
        : `Elige el producto que deseas 👇`
      return {
        reply: view.intent === 'order' ? orderPrompt : `Estos son nuestros productos 👇`,
        options: [...page.map(productOption), ...(hasMore ? [OPT_MORE] : []), OPT_BACK],
      }
    }
    case 'product': {
      const product = input.products.find(item => item.id === view.productId)
      if (!product) return renderView({ kind: 'main' }, state, input)
      const cents = priceCentsOf(product)
      const lines = [
        `*${String(product.name).trim()}*`,
        product.description ? String(product.description).trim() : '',
        cents ? `Precio: ${money(cents)}` : 'Precio: lo confirma nuestro equipo',
        product.stock === 'agotado' ? 'Por ahora está agotado 😔' : '',
      ].filter(Boolean)
      const canOrder = Boolean(input.business.takes_orders) && cents !== null && product.stock !== 'agotado'
      const media = productMediaList(product)
      const canShowMedia = media.length > 0 && !view.mediaShown
      if (canShowMedia) lines.push('¿Quieres ver las fotos y videos? 👇')
      return {
        reply: lines.join('\n'),
        options: [...(canShowMedia ? [OPT_MEDIA] : []), ...(canOrder ? [OPT_ASK] : []), OPT_BACK, OPT_HOME],
      }
    }
    case 'options': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo) return renderView({ kind: 'main' }, state, input)
      const opciones = opcionesDelGrupo(input, grupo.id)
      const producto = input.products.find(item => item.id === view.productId)
      // El recargo se enseña solo cuando lo hay: «Extra queso · +$0.50». Un
      // «+$0.00» pegado a cada línea es ruido que además hace dudar.
      const filas = opciones.map((opcion) => {
        const recargo = Math.round(Number(opcion.price_adjustment || 0) * 100)
        return {
          title: String(opcion.name || '').trim(),
          ...(recargo > 0 ? { description: `+${money(recargo)}` } : {}),
        }
      })
      return {
        reply: `*${String(producto?.name || '').trim()}*\n${String(grupo.name || 'Elige una opción').trim()} 👇`,
        // Un grupo obligatorio no ofrece «Volver»: saltárselo dejaría un
        // pedido que la base va a rechazar, y el cliente no sabría por qué.
        options: [...filas, ...(grupo.required ? [] : [OPT_BACK])],
      }
    }
    case 'quantity': {
      const product = input.products.find(item => item.id === view.productId)
      return {
        reply: `¿Cuántas unidades de *${String(product?.name || '').trim()}* deseas? 👇`,
        options: ['1', '2', '3', OPT_OTHER, OPT_BACK],
      }
    }
    case 'after-add': {
      const categories = categoriesOf(input.products)
      return {
        reply: `¿Deseas algo más? 👇`,
        options: [...(categories.length ? categories : ['🛒 Seguir pidiendo']), OPT_FINISH, OPT_HOME],
      }
    }
    case 'order-confirm': {
      // Lo elegido se enseña agrupado bajo su línea: el cliente tiene que
      // poder comprobar que se entendió su pedido ANTES de confirmarlo.
      const lines = state.cart.map((item) => {
        const elegido = (item.options || []).map(o => o.name).join(', ')
        const detalle = [item.modifier, elegido].filter(Boolean).join(' · ')
        return `• ${item.quantity}x ${item.name}`
          + (detalle ? ` — ${detalle}` : '')
          + ` — ${money(item.priceCents * item.quantity)}`
      })
      const total = state.cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
      return {
        reply: `🧾 Resumen de tu pedido:\n${lines.join('\n')}\n*Total: ${money(total)}*\n¿Lo confirmamos?`,
        options: [OPT_CONFIRM, OPT_EMPTY, OPT_HOME],
      }
    }
  }
  return { reply: `¿En qué te ayudamos? ${PROMPT_CHOOSE}`, options: mainOptions(input) }
}

// ── Estado en memoria por conversación (prototipo del simulador) ──────
const flowStates = new Map<string, FlowState>()

const stateKey = (businessId: string, contact: string): string => `${businessId}:${contact}`

const resetMenuFlow = (businessId: string, contact: string): void => {
  flowStates.delete(stateKey(businessId, contact))
}

// ── Transiciones ──────────────────────────────────────────────────────
const GLOBAL_HOME = new Set(['menu', 'menu principal', 'inicio', 'volver al menu', 'empezar'])
const GLOBAL_TEAM = new Set(['asesor', 'humano', 'una persona', 'persona', 'hablar con el equipo', 'ayuda humana'])

// Un saludo puede llegar acompañado de cortesía o de una frase adicional
// ("Hola buenas tardes", "Buenos días, quisiera información"). En modo menú
// lo recibimos como un nuevo inicio cordial, con el nombre real del negocio,
// en vez de responder "No te entendí".
const isGreeting = (text: string): boolean => (
  /^(?:hola+|holi|buen dia|buenos dias|buenas|muy buenas)(?:\s|$)/.test(text)
)

const goTo = (state: FlowState, view: FlowView, input: MenuFlowInput): MenuFlowResult => {
  state.view = view
  return renderView(view, state, input)
}

const advanceMenuFlow = (input: MenuFlowInput): MenuFlowResult => {
  const key = stateKey(input.business.id, input.contact)
  const now = Date.now()
  let state = flowStates.get(key)
  if (state && now - state.updatedAt > FLOW_TTL_MS) state = undefined

  // Primer contacto (o conversación vencida): bienvenida + menú principal,
  // escriba lo que escriba el cliente — igual que el banco
  if (!state) {
    state = { view: { kind: 'main' }, cart: [], updatedAt: now }
    flowStates.set(key, state)
    return welcomeReply(input)
  }
  state.updatedAt = now

  const text = normalizeText(input.message)
  const view = state.view
  const current = renderView(view, state, input)
  const choice = matchOption(input.message, current.options)

  // Una opción real siempre gana: así un producto cuyo nombre empiece por
  // "Hola" no se confunde con un saludo del cliente.
  if (!choice && isGreeting(text)) {
    state.view = { kind: 'main' }
    return welcomeReply(input)
  }
  if (GLOBAL_HOME.has(text)) return goTo(state, { kind: 'main' }, input)
  if (GLOBAL_TEAM.has(text)) {
    return { ...goTo(state, { kind: 'main' }, input), action: { type: 'handoff' }, reply: '', options: [OPT_HOME] }
  }

  // Opciones globales presentes en varias vistas
  if (choice === OPT_HOME) return goTo(state, { kind: 'main' }, input)
  if (choice === OPT_TEAM) {
    return { ...goTo(state, { kind: 'main' }, input), action: { type: 'handoff' }, reply: '', options: [OPT_HOME] }
  }

  switch (view.kind) {
    case 'main': {
      const categories = categoriesOf(input.products)
      if (choice === OPT_ORDER) {
        return goTo(state, categories.length
          ? { kind: 'categories', intent: 'order', page: 0 }
          : { kind: 'products', intent: 'order', tag: null, page: 0 }, input)
      }
      if (choice === OPT_BROWSE) {
        return goTo(state, categories.length
          ? { kind: 'categories', intent: 'browse', page: 0 }
          : { kind: 'products', intent: 'browse', tag: null, page: 0 }, input)
      }
      if (choice === OPT_REPEAT) {
        const { cart, skipped } = rebuildCartFromLastOrder(input)
        if (!cart.length) {
          return {
            reply: 'No pude rearmar tu pedido anterior porque esos productos ya no están disponibles 🙏 Arma uno nuevo:',
            options: mainOptions(input),
          }
        }
        state.cart = cart
        const summary = goTo(state, { kind: 'order-confirm' }, input)
        const note = skipped.length
          ? `\n⚠️ Ya no tenemos: ${skipped.join(', ')}. Lo quité del pedido.`
          : ''
        return {
          ...summary,
          reply: `Este es tu último pedido con los precios de hoy 👇${note}\n\n${summary.reply}`,
        }
      }
      break
    }
    case 'categories': {
      if (choice === OPT_BACK) return goTo(state, { kind: 'main' }, input)
      if (choice === OPT_MORE) return goTo(state, { ...view, page: view.page + 1 }, input)
      if (choice) {
        const tag = normalizeText(choice)
        // Al pedir, si la categoría tiene modificadores (sabores) se elige
        // primero el sabor y luego el producto/tamaño.
        if (view.intent === 'order' && modifiersForTag(input, tag).length) {
          return goTo(state, { kind: 'modifier', tag, page: 0 }, input)
        }
        return goTo(state, { kind: 'products', intent: view.intent, tag, page: 0 }, input)
      }
      break
    }
    case 'modifier': {
      if (choice === OPT_BACK) {
        state.pendingModifier = undefined
        return goTo(state, categoriesOf(input.products).length
          ? { kind: 'categories', intent: 'order', page: 0 }
          : { kind: 'main' }, input)
      }
      if (choice === OPT_MORE) return goTo(state, { ...view, page: view.page + 1 }, input)
      if (choice) {
        const modifier = modifiersForTag(input, view.tag).find(item => modifierLabel(item) === choice)
        if (modifier) {
          // Sabor elegido: se recuerda y se pasa a elegir el tamaño.
          state.pendingModifier = modifierLabel(modifier)
          return goTo(state, { kind: 'products', intent: 'order', tag: view.tag, page: 0 }, input)
        }
      }
      break
    }
    case 'products': {
      if (choice === OPT_BACK) {
        // Si veníamos de elegir sabor, "Volver" regresa a los sabores
        if (state.pendingModifier && view.tag) {
          state.pendingModifier = undefined
          return goTo(state, { kind: 'modifier', tag: view.tag, page: 0 }, input)
        }
        return goTo(state, categoriesOf(input.products).length
          ? { kind: 'categories', intent: view.intent, page: 0 }
          : { kind: 'main' }, input)
      }
      if (choice === OPT_MORE) {
        return goTo(state, { ...view, page: view.page + 1 }, input)
      }
      if (choice) {
        const list = productsInCategory(input.products, view.tag)
        const product = list.find(item => productLabel(item) === choice)
        if (product) {
          if (view.intent === 'order') {
            // Con fotos/video, o si no se puede pedir directo (agotado / sin
            // precio), se muestra el detalle para que el cliente vea qué va a
            // comprar; si no hay media, va directo a la cantidad (ruta rápida).
            if (productMediaList(product).length || product.stock === 'agotado' || priceCentsOf(product) === null) {
              return goTo(state, { kind: 'product', intent: view.intent, productId: product.id, tag: view.tag, page: view.page }, input)
            }
            // ⚠️ La ruta rápida también tiene que preguntar las opciones. Sin
            // esto, un producto sin fotos se pedía sin su sabor y el pedido
            // salía incompleto — o lo rechazaba la base si el grupo era
            // obligatorio.
            if (exigeLaApp(input, product.id)) {
              return {
                reply: 'Este producto tiene opciones que se eligen mejor en la app 📱\n'
                  + 'Escribe *MENÚ* y te paso el enlace.',
                options: [OPT_BACK, OPT_HOME],
              }
            }
            state.pendingOptions = []
            if (gruposDelProducto(input, product.id).length) {
              return goTo(state, {
                kind: 'options', productId: product.id, tag: view.tag, groupIndex: 0,
              }, input)
            }
            return goTo(state, { kind: 'quantity', productId: product.id }, input)
          }
          return goTo(state, { kind: 'product', intent: view.intent, productId: product.id, tag: view.tag, page: view.page }, input)
        }
      }
      break
    }
    case 'product': {
      const product = input.products.find(item => item.id === view.productId)
      if (choice === OPT_MEDIA && product) {
        const media = productMediaList(product)
        // La lista visible elimina "Ver fotos y videos"; el estado debe guardar
        // lo mismo para que el próximo id numérico 1 sea "Pedirlo", no Media.
        const detail = goTo(state, { ...view, mediaShown: true }, input)
        return {
          reply: mediaCaption(String(product.name || 'este producto'), media),
          options: detail.options,
          media,
        }
      }
      if (choice === OPT_BACK) {
        return goTo(state, { kind: 'products', intent: view.intent, tag: view.tag, page: view.page }, input)
      }
      if (choice === OPT_ASK) {
        // ⚠️ Un producto con un grupo obligatorio que el chat no sabe
        // preguntar (casillas, contadores) no se deja pedir aquí: la base lo
        // rechazaría y el cliente se quedaría sin saber por qué.
        if (exigeLaApp(input, view.productId)) {
          return {
            reply: 'Este producto tiene opciones que se eligen mejor en la app 📱\n'
              + 'Escribe *MENÚ* y te paso el enlace.',
            options: [OPT_BACK, OPT_HOME],
          }
        }
        state.pendingOptions = []
        return gruposDelProducto(input, view.productId).length
          ? goTo(state, { kind: 'options', productId: view.productId, tag: view.tag, groupIndex: 0 }, input)
          : goTo(state, { kind: 'quantity', productId: view.productId }, input)
      }
      break
    }
    case 'options': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo) return goTo(state, { kind: 'quantity', productId: view.productId }, input)
      if (choice === OPT_BACK && !grupo.required) {
        return goTo(state, {
          kind: 'product', intent: 'order', productId: view.productId,
          tag: view.tag, page: 0,
        }, input)
      }
      const elegida = opcionesDelGrupo(input, grupo.id)
        .find(opcion => String(opcion.name || '').trim() === choice)
      if (!elegida) break

      state.pendingOptions = [
        ...(state.pendingOptions || []),
        {
          optionId: elegida.id,
          groupName: String(grupo.name || '').trim(),
          name: String(elegida.name || '').trim(),
        },
      ]
      // Un grupo por mensaje: se pasa al siguiente, y al acabarlos, a la
      // cantidad. Preguntarlos todos de golpe no cabe en una lista.
      const siguiente = view.groupIndex + 1
      return siguiente < grupos.length
        ? goTo(state, { ...view, groupIndex: siguiente }, input)
        : goTo(state, { kind: 'quantity', productId: view.productId }, input)
    }
    case 'quantity': {
      // El número escrito manda: "4" es una cantidad, no la opción 4 de la lista
      const quantity = parseQuantity(input.message, 99)
      if (!quantity && choice === OPT_BACK) return goTo(state, { kind: 'main' }, input)
      if (!quantity && choice === OPT_OTHER) {
        return { reply: `Escríbeme la cantidad (solo el número) ✍️`, options: [OPT_BACK] }
      }
      if (quantity && quantity > 0) {
        const product = input.products.find(item => item.id === view.productId)
        const cents = product ? priceCentsOf(product) : null
        if (product && cents !== null) {
          // El sabor pendiente se pega a esta línea y se limpia.
          const modifier = state.pendingModifier
          const elegidas = state.pendingOptions || []
          state.cart.push({
            productId: product.id,
            name: String(product.name).trim(),
            quantity,
            priceCents: cents,
            ...(modifier ? { modifier } : {}),
            ...(elegidas.length ? { options: elegidas } : {}),
          })
          state.pendingModifier = undefined
          state.pendingOptions = undefined
          const added = { ...goTo(state, { kind: 'after-add' }, input) }
          // Se nombra lo elegido: el cliente acaba de contestar tres
          // preguntas y merece ver que se entendieron, no un «listo» a secas.
          const detalle = [modifier, elegidas.map(o => o.name).join(', ')]
            .filter(Boolean).join(' · ')
          added.reply = `Listo, agregué ${quantity}x ${String(product.name).trim()}${detalle ? ` — ${detalle}` : ''} ✅\n${added.reply}`
          return added
        }
      }
      break
    }
    case 'after-add': {
      if (choice === OPT_FINISH) {
        if (!state.cart.length) return goTo(state, { kind: 'main' }, input)
        return goTo(state, { kind: 'order-confirm' }, input)
      }
      if (choice === '🛒 Seguir pidiendo') {
        return goTo(state, { kind: 'products', intent: 'order', tag: null, page: 0 }, input)
      }
      if (choice) {
        const tag = normalizeText(choice)
        // Misma regla: si la categoría tiene sabores, se elige primero
        if (modifiersForTag(input, tag).length) {
          return goTo(state, { kind: 'modifier', tag, page: 0 }, input)
        }
        return goTo(state, { kind: 'products', intent: 'order', tag, page: 0 }, input)
      }
      break
    }
    case 'order-confirm': {
      if (choice === OPT_CONFIRM) {
        const summaryView = renderView({ kind: 'order-confirm' }, state, input)
        const total = state.cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
        const action: FlowAction = {
          type: 'order',
          summary: summaryView.reply,
          totalCents: total,
          payload: state.cart.map(item => `${item.name} x${item.quantity}`).join('; '),
          // Cada línea con su sabor: el servidor calcula el precio por el
          // producto (tamaño) y pliega el sabor en el nombre visible.
          items: state.cart.map(item => ({
            name: item.name,
            qty: item.quantity,
            note: item.modifier || null,
            productId: item.productId,
            ...(item.options?.length ? { options: item.options } : {}),
          })),
        }
        state.cart = []
        const home = goTo(state, { kind: 'main' }, input)
        return {
          reply: `¡Pedido recibido! 🙌 Nuestro equipo te contactará para coordinar la entrega y el pago.\n${home.reply}`,
          options: home.options,
          action,
        }
      }
      if (choice === OPT_EMPTY) {
        state.cart = []
        return goTo(state, { kind: 'main' }, input)
      }
      break
    }
  }

  // Nada coincidió: fallo cerrado — se repite el menú actual, jamás se inventa
  return { reply: NOT_UNDERSTOOD, options: current.options }
}

/**
 * Igual que `advanceMenuFlow`, pero con el estado FUERA: lo carga y lo guarda
 * el llamador.
 *
 * Existe para el marketplace, donde la conversación vive en
 * `marketplace_conversations.flow_state` y tiene que sobrevivir a un
 * despliegue. El `Map` de arriba nació como «prototipo del simulador» y sigue
 * sirviendo al camino de siempre —un negocio con su propio número—, pero se
 * pierde en cada arranque y con dos instancias lleva dos cuentas del mismo
 * carrito.
 *
 * ⚠️ Presta el `Map` durante la llamada en vez de duplicar las ~230 líneas de
 * la máquina de estados. Es seguro porque `advanceMenuFlow` es **síncrona**:
 * sin un `await` en medio, Node no puede intercalar otra petición entre el
 * préstamo y la devolución, así que ninguna otra conversación llega a ver
 * este estado. Duplicar la máquina sería un segundo sitio donde arreglar cada
 * bug del menú.
 *
 * ⚠️ `updatedAt` se conserva tal cual, no se refresca: el TTL de 30 minutos
 * tiene que seguir venciendo una conversación abandonada igual que antes.
 */
const advanceMenuFlowConEstado = (
  input: MenuFlowInput,
  estadoPrevio: FlowState | null,
): { resultado: MenuFlowResult; estado: FlowState | null } => {
  const key = stateKey(input.business.id, input.contact)
  const prestado = flowStates.get(key)
  if (estadoPrevio) flowStates.set(key, estadoPrevio)
  else flowStates.delete(key)
  try {
    const resultado = advanceMenuFlow(input)
    const estado = flowStates.get(key)
    return { resultado, estado: estado ? { ...estado } : null }
  } finally {
    if (prestado) flowStates.set(key, prestado)
    else flowStates.delete(key)
  }
}

export type { FlowState }
export {
  advanceMenuFlow,
  advanceMenuFlowConEstado,
  optionTitle,
  resetMenuFlow,
}
