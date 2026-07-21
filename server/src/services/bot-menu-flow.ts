// Modo MENÚ (estilo banco): toda la conversación la conduce el CÓDIGO con
// opciones generadas desde los datos reales del negocio. La IA no participa:
// los textos son plantillas mínimas, los precios salen del catálogo, las
// habitaciones del inventario y las citas de la agenda. Si el cliente escribe
// algo fuera del menú, se le vuelve a mostrar el menú (fallo cerrado) o se
// deriva al equipo. Los totales y cotizaciones los calcula SIEMPRE el servidor.

interface FlowBusiness {
  id: string
  name?: string | null
  takes_orders?: boolean | null
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
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
  active?: boolean | null
}

interface FlowRoomType {
  id: string
  name?: string | null
  description?: string | null
  amenities?: string[] | null
  base_rate?: number | string | null
  pricing_model?: string | null
  max_guests?: number | null
  media_urls?: string[] | null
}

interface FlowSlots {
  [date: string]: { label?: string; slots?: string[] }
}

interface CartItem {
  productId: string
  name: string
  quantity: number
  priceCents: number
}

type FlowView =
  | { kind: 'main' }
  | { kind: 'categories'; intent: 'order' | 'browse' }
  | { kind: 'products'; intent: 'order' | 'browse'; tag: string | null; page: number }
  | { kind: 'product'; intent: 'order' | 'browse'; productId: string; tag: string | null; page: number }
  | { kind: 'quantity'; productId: string }
  | { kind: 'after-add' }
  | { kind: 'order-confirm' }
  | { kind: 'rooms' }
  | { kind: 'room'; roomTypeId: string }
  | { kind: 'stay'; step: 'dates' | 'adults' | 'children'; roomTypeId?: string; checkIn?: string; checkOut?: string; adults?: number }
  | { kind: 'stay-request' }
  | { kind: 'booking'; step: 'date' | 'time' | 'name'; date?: string; time?: string }

interface FlowState {
  view: FlowView
  cart: CartItem[]
  // Última cotización emitida: permite "Solicitar esta habitación" después
  lastStay?: { roomTypeId?: string; checkIn: string; checkOut: string }
  updatedAt: number
}

type FlowAction =
  | { type: 'handoff' }
  | { type: 'order'; summary: string; totalCents: number }
  | { type: 'stay_quote'; quote: { checkIn: string; checkOut: string; roomsCount: number; adults: number; children: number; roomTypeId?: string } }
  | { type: 'stay_request'; roomTypeId: string; contactName: string }
  | { type: 'booking'; date: string; time: string; name: string }

export interface MenuFlowInput {
  business: FlowBusiness
  contact: string
  message: string
  products: FlowProduct[]
  roomTypes?: FlowRoomType[]
  availableSlots?: FlowSlots
}

export interface MenuFlowResult {
  reply: string
  options: string[]
  image?: string | null
  action?: FlowAction
}

// ── Etiquetas fijas del menú (el cliente ve exactamente estos textos) ──
const OPT_ORDER = '🛒 Hacer un pedido'
const OPT_BROWSE = '📋 Ver productos y precios'
const OPT_ROOMS = '🛏️ Ver habitaciones'
const OPT_STAY = '📅 Cotizar estadía'
const OPT_STAY_AGAIN = '📅 Cotizar otras fechas'
const STAY_REQUEST_OPTION = '🛎️ Solicitar esta habitación'
const OPT_BOOK = '📅 Agendar una cita'
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
const FLOW_TTL_MS = 30 * 60 * 1000
const PROMPT_CHOOSE = 'Elige una opción del menú 👇'
const NOT_UNDERSTOOD = `🙏 No te entendí. ${PROMPT_CHOOSE}`

// ── Utilidades de texto y fechas (deterministas, zona Ecuador) ────────
const DAY_MS = 86_400_000
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const

const normalizeText = (value: string): string => value
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{M}+/gu, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const todayEcuador = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })

const addDays = (iso: string, days: number): string => new Date(
  new Date(`${iso}T12:00:00Z`).getTime() + days * DAY_MS,
).toISOString().slice(0, 10)

const nextWeekday = (fromIso: string, weekday: number, strictlyAfter = false): string => {
  const current = new Date(`${fromIso}T12:00:00Z`).getUTCDay()
  let delta = ((weekday - current) % 7 + 7) % 7
  if (delta === 0 && strictlyAfter) delta = 7
  return addDays(fromIso, delta)
}

// "viernes 24 de julio" legible para el huésped, con el calendario real
const formatDateEs = (iso: string): string => new Date(`${iso}T12:00:00Z`)
  .toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

const validIsoDate = (year: number, month: number, day: number): string | null => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null
}

// ── Rango de estadía escrito por el huésped ───────────────────────────
// El huésped escribe llegada y salida en UN mensaje y el MES es obligatorio
// ("del 24 al 26 de julio"): "del 24 al 26" a secas se rechaza pidiendo el
// mes. También se aceptan "del 24 de julio al 2 de agosto", días de semana
// ("del lunes al miércoles") y "de hoy a mañana" — todo lo resuelve el
// calendario real, nunca se adivina.
type StayRange =
  | { ok: true; checkIn: string; checkOut: string }
  | { ok: false; reason: 'sin_mes' | 'falta_salida' | 'rango' | 'no_entendi' }

interface DateToken {
  special?: string
  weekday?: number
  day?: number
  month?: number
  explicitYear?: number
  // Mes escrito suelto ("20 al 22 de de julio"): se ata luego al día pelado
  looseMonth?: number
}

// Conserva "/" y "-" para poder leer "24/07" (la normalización general los borra)
const normalizeDateText = (value: string): string => value
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{M}+/gu, '')
  .replace(/[^a-z0-9/\s-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const DATE_TOKEN_PATTERN = new RegExp(
  `\\b(pasado manana|manana|hoy)\\b`
  + `|\\b(${WEEKDAYS.join('|')})\\b`
  + `|\\b(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?\\b`
  // El conector "de" puede venir repetido o faltar: "22 de julio", "22 julio", "22 de de julio"
  + `|\\b(\\d{1,2})(?:\\s*(?:de\\s+)*(${MONTHS.join('|')}))?\\b`
  + `|\\b(${MONTHS.join('|')})\\b`,
  'g',
)

const isoParts = (iso: string): { year: number; month: number } => (
  { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) }
)

const parseStayRange = (message: string, today: string): StayRange => {
  // "24-26" con la segunda cifra > 12 es un rango de días, no día-mes
  const text = normalizeDateText(message)
    .replace(/\b(\d{1,2})\s*-\s*(1[3-9]|2\d|3[01])\b/g, '$1 al $2')
  const tokens: DateToken[] = []
  for (const match of text.matchAll(DATE_TOKEN_PATTERN)) {
    if (match[1]) tokens.push({ special: match[1] })
    else if (match[2]) tokens.push({ weekday: WEEKDAYS.indexOf(match[2] as typeof WEEKDAYS[number]) })
    else if (match[3]) {
      tokens.push({
        day: Number(match[3]),
        month: Number(match[4]),
        explicitYear: match[5] ? Number(match[5].length === 2 ? `20${match[5]}` : match[5]) : undefined,
      })
    } else if (match[6]) {
      const month = match[7] ? MONTHS.indexOf(match[7] as typeof MONTHS[number]) + 1 : undefined
      tokens.push({ day: Number(match[6]), month })
    } else if (match[8]) {
      tokens.push({ looseMonth: MONTHS.indexOf(match[8] as typeof MONTHS[number]) + 1 })
    }
  }

  // Mes suelto por typos o separación ("20 al 22 de de julio", "julio 20 al
  // 22"): se ata al día pelado más cercano hacia ATRÁS (formato español
  // "X al Y de MES") o, si no hay, hacia adelante. El resto lo resuelve la
  // herencia de mes normal.
  for (let index = 0; index < tokens.length; index += 1) {
    const loose = tokens[index]
    if (loose.looseMonth == null) continue
    let target = -1
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = tokens[back]
      if (candidate.day != null && candidate.month == null) { target = back; break }
    }
    if (target < 0) {
      for (let ahead = index + 1; ahead < tokens.length; ahead += 1) {
        const candidate = tokens[ahead]
        if (candidate.day != null && candidate.month == null) { target = ahead; break }
      }
    }
    if (target >= 0) tokens[target] = { ...tokens[target], month: loose.looseMonth }
  }
  const dateTokens = tokens.filter(token => token.looseMonth == null)

  // Con números de día presentes, los días de semana son decoración
  // ("el viernes 24 de julio" → cuenta el 24 de julio)
  const hasDayNumbers = dateTokens.some(token => token.day != null)
  const relevant = hasDayNumbers ? dateTokens.filter(token => token.weekday == null) : dateTokens
  if (!relevant.length) return { ok: false, reason: 'no_entendi' }
  if (relevant.length < 2) return { ok: false, reason: 'falta_salida' }
  const [first, second] = relevant

  // La regla del dueño: números de día sin mes en NINGUNO de los dos → pedir el mes
  if (first.day != null && first.month == null && second.day != null && second.month == null) {
    return { ok: false, reason: 'sin_mes' }
  }

  const year = Number(today.slice(0, 4))
  const absolute = (token: DateToken): string | null => {
    if (token.special === 'hoy') return today
    if (token.special === 'manana') return addDays(today, 1)
    if (token.special === 'pasado manana') return addDays(today, 2)
    if (token.day != null && token.month != null && token.month >= 1 && token.month <= 12) {
      const candidate = validIsoDate(token.explicitYear ?? year, token.month, token.day)
      return candidate && !token.explicitYear && candidate < today
        ? validIsoDate(year + 1, token.month, token.day)
        : candidate
    }
    return null
  }

  // Llegada
  let checkIn = absolute(first)
  if (!checkIn && first.weekday != null) checkIn = nextWeekday(today, first.weekday)

  // Salida (puede heredar el mes de la llegada, o al revés)
  let checkOut = absolute(second)
  if (!checkOut && second.weekday != null) {
    checkOut = checkIn ? nextWeekday(checkIn, second.weekday, true) : null
  }
  if (!checkOut && second.day != null && second.month == null && checkIn) {
    // "del 24 de julio al 26": la salida hereda el mes; si queda antes, es el mes siguiente
    const parts = isoParts(checkIn)
    checkOut = validIsoDate(parts.year, parts.month, second.day)
    if (checkOut && checkOut <= checkIn) {
      checkOut = parts.month === 12
        ? validIsoDate(parts.year + 1, 1, second.day)
        : validIsoDate(parts.year, parts.month + 1, second.day)
    }
  }
  if (!checkIn && first.day != null && first.month == null && checkOut) {
    // "del 24 al 26 de julio": la llegada hereda el mes de la salida; si queda
    // después, era el mes anterior
    const parts = isoParts(checkOut)
    checkIn = validIsoDate(parts.year, parts.month, first.day)
    if (checkIn && checkIn >= checkOut) {
      checkIn = parts.month === 1
        ? validIsoDate(parts.year - 1, 12, first.day)
        : validIsoDate(parts.year, parts.month - 1, first.day)
    }
  }

  if (!checkIn || !checkOut) return { ok: false, reason: 'no_entendi' }
  if (checkOut <= checkIn || checkIn < today) return { ok: false, reason: 'rango' }
  const nights = Math.round((new Date(`${checkOut}T12:00:00Z`).getTime() - new Date(`${checkIn}T12:00:00Z`).getTime()) / DAY_MS)
  if (nights > 60) return { ok: false, reason: 'rango' }
  return { ok: true, checkIn, checkOut }
}

const STAY_RANGE_EXAMPLE = '"del 24 al 26 de julio"'
const STAY_RANGE_ERRORS: Record<'sin_mes' | 'falta_salida' | 'rango' | 'no_entendi', string> = {
  sin_mes: `Para no equivocarme con las fechas, escríbeme también el MES 🙏 Por ejemplo: ${STAY_RANGE_EXAMPLE} ✍️`,
  falta_salida: `Me falta una de las dos fechas 🙏 Escríbeme la llegada y la salida juntas, por ejemplo: ${STAY_RANGE_EXAMPLE} ✍️`,
  rango: `Esas fechas no me cuadran (la salida debe ser después de la llegada y desde hoy en adelante) 🙏 Inténtalo de nuevo, por ejemplo: ${STAY_RANGE_EXAMPLE} ✍️`,
  no_entendi: `No entendí las fechas 🙏 Escríbeme la llegada y la salida con el mes, por ejemplo: ${STAY_RANGE_EXAMPLE} ✍️`,
}

const parseQuantity = (message: string, max: number): number | null => {
  const match = normalizeText(message).match(/^(\d{1,3})\b/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null
}

// El cliente puede tocar la opción (llega el texto exacto) o escribir su
// número de lista, como en el banco ("1", "2", …)
const matchOption = (message: string, options: string[]): string | null => {
  const text = normalizeText(message)
  if (!text) return null
  const byLabel = options.find(option => normalizeText(option) === text)
  if (byLabel) return byLabel
  if (/^\d{1,2}$/.test(text)) {
    const index = Number(text) - 1
    if (index >= 0 && index < options.length) return options[index]
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

// ── Datos derivados del negocio ───────────────────────────────────────
const activeProducts = (products: FlowProduct[]): FlowProduct[] =>
  products.filter(item => item.active !== false && String(item.name || '').trim())

// Las categorías son los tags reales del catálogo; sin tags suficientes se
// listan los productos directo (nada de categorías inventadas)
const categoriesOf = (products: FlowProduct[]): string[] => {
  const seen = new Set<string>()
  const labels: string[] = []
  let untagged = 0
  for (const product of activeProducts(products)) {
    const tag = String(product.tags?.[0] || '').trim().toLowerCase()
    if (!tag) { untagged += 1; continue }
    if (!seen.has(tag)) { seen.add(tag); labels.push(capitalize(tag)) }
  }
  if (labels.length < 2) return []
  if (untagged > 0) labels.push('Otros')
  return labels
}

const productsInCategory = (products: FlowProduct[], tag: string | null): FlowProduct[] => {
  const list = activeProducts(products)
  if (tag === null) return list
  if (tag === 'otros') return list.filter(item => !String(item.tags?.[0] || '').trim())
  return list.filter(item => String(item.tags?.[0] || '').trim().toLowerCase() === tag)
}

const productLabel = (product: FlowProduct): string => {
  const cents = priceCentsOf(product)
  const soldOut = product.stock === 'agotado' ? ' (agotado)' : ''
  return `${String(product.name).trim()}${cents ? ` — ${money(cents)}` : ''}${soldOut}`
}

// Toda habitación muestra su precio: exacto si es por unidad, "desde" si la
// tarifa depende de las personas (el total oficial lo da la cotización)
const roomRateText = (room: FlowRoomType): string | null => {
  const rate = Number(room.base_rate)
  if (!Number.isFinite(rate) || rate <= 0) return null
  const desde = room.pricing_model === 'per_unit' ? '' : 'desde '
  return `${desde}${money(Math.round(rate * 100))}/noche`
}

const roomLabel = (room: FlowRoomType): string => {
  const rate = roomRateText(room)
  return `${String(room.name || '').trim()}${rate ? ` — ${rate}` : ''}`
}

// ── Menú principal por capacidades reales ─────────────────────────────
const mainOptions = (input: MenuFlowInput): string[] => {
  const options: string[] = []
  const hasProducts = activeProducts(input.products).length > 0
  if (input.business.lodging_enabled) {
    // Decisión del dueño (2026-07-19): el hostal recibe con las habitaciones
    // al frente; cotizar aparece DESPUÉS de elegir habitación y el equipo
    // sigue disponible escribiendo "asesor" o tras la cotización
    options.push(OPT_ROOMS)
    if (input.business.takes_orders && hasProducts) options.push(OPT_ORDER)
    if (hasProducts) options.push(OPT_BROWSE)
    return options
  }
  if (input.business.takes_orders && hasProducts) options.push(OPT_ORDER)
  if (hasProducts) options.push(OPT_BROWSE)
  if (input.business.takes_bookings && Object.keys(input.availableSlots || {}).length > 0) {
    options.push(OPT_BOOK)
  }
  options.push(OPT_TEAM)
  return options
}

const welcomeReply = (input: MenuFlowInput): MenuFlowResult => {
  const name = String(input.business.name || '').trim()
  return {
    reply: `¡Hola! 👋 ${name ? `Gracias por escribir a ${name}` : 'Gracias por escribirnos'} 😊\n${PROMPT_CHOOSE}`,
    options: mainOptions(input),
  }
}

// ── Renderizado de cada vista (reply + opciones deterministas) ────────
const renderView = (view: FlowView, state: FlowState, input: MenuFlowInput): MenuFlowResult => {
  switch (view.kind) {
    case 'main':
      return { reply: `¿En qué te ayudamos? ${PROMPT_CHOOSE}`, options: mainOptions(input) }
    case 'categories':
      return {
        reply: view.intent === 'order' ? `¿Qué te gustaría pedir? ${PROMPT_CHOOSE}` : `Estas son nuestras categorías 👇`,
        options: [...categoriesOf(input.products), OPT_BACK],
      }
    case 'products': {
      const list = productsInCategory(input.products, view.tag)
      const page = list.slice(view.page * PAGE_SIZE, view.page * PAGE_SIZE + PAGE_SIZE)
      const hasMore = list.length > (view.page + 1) * PAGE_SIZE
      return {
        reply: view.intent === 'order' ? `Elige el producto que deseas 👇` : `Estos son nuestros productos 👇`,
        options: [...page.map(productLabel), ...(hasMore ? [OPT_MORE] : []), OPT_BACK],
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
      return {
        reply: lines.join('\n'),
        options: [...(canOrder ? [OPT_ASK] : []), OPT_BACK, OPT_HOME],
        image: product.image_url || null,
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
      const lines = state.cart.map(item => `• ${item.quantity}x ${item.name} — ${money(item.priceCents * item.quantity)}`)
      const total = state.cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
      return {
        reply: `🧾 Resumen de tu pedido:\n${lines.join('\n')}\n*Total: ${money(total)}*\n¿Lo confirmamos?`,
        options: [OPT_CONFIRM, OPT_EMPTY, OPT_HOME],
      }
    }
    case 'rooms': {
      const rooms = (input.roomTypes || []).filter(room => String(room.name || '').trim())
      if (!rooms.length) {
        return { reply: `Por ahora no tengo habitaciones cargadas para mostrarte 🙏`, options: [OPT_TEAM, OPT_HOME] }
      }
      return { reply: `Estas son nuestras habitaciones 👇`, options: [...rooms.map(roomLabel), OPT_BACK] }
    }
    case 'room': {
      const room = (input.roomTypes || []).find(item => item.id === view.roomTypeId)
      if (!room) return renderView({ kind: 'rooms' }, state, input)
      const amenities = (room.amenities || []).map(item => String(item).trim()).filter(Boolean)
      const rate = roomRateText(room)
      const lines = [
        `*${String(room.name || '').trim()}*`,
        room.description ? String(room.description).trim() : '',
        amenities.length ? `✨ Incluye: ${amenities.join(', ')}` : '',
        room.max_guests ? `👥 Capacidad: hasta ${room.max_guests} persona(s)` : '',
        rate ? `💵 Tarifa: ${rate}` : '',
        `¿Te gustó? Cotiza tus fechas aquí mismo y te doy el total oficial 👇`,
      ].filter(Boolean)
      return {
        reply: lines.join('\n'),
        options: [OPT_STAY, OPT_BACK, OPT_HOME],
        image: room.media_urls?.[0] || null,
      }
    }
    case 'stay':
      switch (view.step) {
        case 'dates': {
          // La habitación ya está elegida; las que necesite el grupo las
          // calcula el servidor según capacidad — no se le pregunta al cliente
          const chosen = (input.roomTypes || []).find(item => item.id === view.roomTypeId)
          const prefix = chosen ? `¡Buena elección! *${String(chosen.name || '').trim()}* 🙌\n` : ''
          return {
            reply: `${prefix}¿Qué días deseas hospedarte? Escríbeme la llegada y la salida CON EL MES, por ejemplo: ${STAY_RANGE_EXAMPLE} ✍️`,
            options: [OPT_BACK],
          }
        }
        case 'adults':
          return { reply: `¿Cuántos adultos se hospedarán? 👇`, options: ['1', '2', '3', '4'] }
        case 'children':
          return { reply: `¿Cuántos niños? 👇`, options: ['0', '1', '2'] }
      }
      break
    case 'stay-request':
      return { reply: `¿A nombre de quién registro la solicitud? ✍️`, options: [OPT_HOME] }
    case 'booking':
      switch (view.step) {
        case 'date': {
          const days = Object.entries(input.availableSlots || {}).slice(0, 6)
          if (!days.length) {
            return { reply: `Por ahora no tengo horarios disponibles para agendar 🙏`, options: [OPT_TEAM, OPT_HOME] }
          }
          return { reply: `¿Para qué día quieres tu cita? 👇`, options: [...days.map(([date, value]) => value.label || date), OPT_BACK] }
        }
        case 'time': {
          const slots = (input.availableSlots?.[view.date || ''] || {}).slots || []
          return { reply: `¿A qué hora? 👇`, options: [...slots.slice(0, 8), OPT_BACK] }
        }
        case 'name':
          return { reply: `¿A nombre de quién agendo la cita? ✍️`, options: [] }
      }
      break
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
const GLOBAL_HOME = new Set(['menu', 'menu principal', 'inicio', 'volver al menu', 'hola', 'buenas', 'empezar'])
const GLOBAL_TEAM = new Set(['asesor', 'humano', 'una persona', 'persona', 'hablar con el equipo', 'ayuda humana'])

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
  if (GLOBAL_HOME.has(text)) return goTo(state, { kind: 'main' }, input)
  if (GLOBAL_TEAM.has(text)) {
    return { ...goTo(state, { kind: 'main' }, input), action: { type: 'handoff' }, reply: '', options: [OPT_HOME] }
  }

  const view = state.view
  const current = renderView(view, state, input)
  const choice = matchOption(input.message, current.options)

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
          ? { kind: 'categories', intent: 'order' }
          : { kind: 'products', intent: 'order', tag: null, page: 0 }, input)
      }
      if (choice === OPT_BROWSE) {
        return goTo(state, categories.length
          ? { kind: 'categories', intent: 'browse' }
          : { kind: 'products', intent: 'browse', tag: null, page: 0 }, input)
      }
      if (choice === OPT_ROOMS) return goTo(state, { kind: 'rooms' }, input)
      if (choice === OPT_STAY || normalizeText(OPT_STAY_AGAIN) === text) {
        return goTo(state, { kind: 'stay', step: 'dates' }, input)
      }
      // Ofrecida tras una cotización con habitación elegida
      if (normalizeText(STAY_REQUEST_OPTION) === text && state.lastStay?.roomTypeId) {
        return goTo(state, { kind: 'stay-request' }, input)
      }
      if (choice === OPT_BOOK) return goTo(state, { kind: 'booking', step: 'date' }, input)
      break
    }
    case 'categories': {
      if (choice === OPT_BACK) return goTo(state, { kind: 'main' }, input)
      if (choice) {
        return goTo(state, { kind: 'products', intent: view.intent, tag: normalizeText(choice), page: 0 }, input)
      }
      break
    }
    case 'products': {
      if (choice === OPT_BACK) {
        return goTo(state, categoriesOf(input.products).length
          ? { kind: 'categories', intent: view.intent }
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
            if (product.stock === 'agotado' || priceCentsOf(product) === null) {
              return goTo(state, { kind: 'product', intent: view.intent, productId: product.id, tag: view.tag, page: view.page }, input)
            }
            return goTo(state, { kind: 'quantity', productId: product.id }, input)
          }
          return goTo(state, { kind: 'product', intent: view.intent, productId: product.id, tag: view.tag, page: view.page }, input)
        }
      }
      break
    }
    case 'product': {
      if (choice === OPT_BACK) {
        return goTo(state, { kind: 'products', intent: view.intent, tag: view.tag, page: view.page }, input)
      }
      if (choice === OPT_ASK) return goTo(state, { kind: 'quantity', productId: view.productId }, input)
      break
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
          state.cart.push({ productId: product.id, name: String(product.name).trim(), quantity, priceCents: cents })
          const added = { ...goTo(state, { kind: 'after-add' }, input) }
          added.reply = `Listo, agregué ${quantity}x ${String(product.name).trim()} ✅\n${added.reply}`
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
        return goTo(state, { kind: 'products', intent: 'order', tag: normalizeText(choice), page: 0 }, input)
      }
      break
    }
    case 'order-confirm': {
      if (choice === OPT_CONFIRM) {
        const summaryView = renderView({ kind: 'order-confirm' }, state, input)
        const total = state.cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
        const action: FlowAction = { type: 'order', summary: summaryView.reply, totalCents: total }
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
    case 'rooms': {
      if (choice === OPT_BACK) return goTo(state, { kind: 'main' }, input)
      if (choice) {
        const room = (input.roomTypes || []).find(item => roomLabel(item) === choice)
        if (room) return goTo(state, { kind: 'room', roomTypeId: room.id }, input)
      }
      break
    }
    case 'room': {
      if (choice === OPT_BACK) return goTo(state, { kind: 'rooms' }, input)
      if (choice === OPT_STAY) {
        // La habitación elegida acompaña a la cotización
        return goTo(state, { kind: 'stay', step: 'dates', roomTypeId: view.roomTypeId }, input)
      }
      break
    }
    case 'stay': {
      if (view.step === 'dates') {
        if (choice === OPT_BACK) return goTo(state, { kind: 'rooms' }, input)
        const range = parseStayRange(input.message, todayEcuador())
        if (!range.ok) return { reply: STAY_RANGE_ERRORS[range.reason], options: [OPT_BACK] }
        // Se confirma la interpretación con el calendario real antes de seguir
        const next = goTo(state, { ...view, step: 'adults', checkIn: range.checkIn, checkOut: range.checkOut }, input)
        return {
          ...next,
          reply: `¡Perfecto! Del ${formatDateEs(range.checkIn)} al ${formatDateEs(range.checkOut)} 🙌\n${next.reply}`,
        }
      }
      if (view.step === 'adults') {
        const adults = parseQuantity(input.message, 20)
        if (adults && adults > 0) return goTo(state, { ...view, step: 'children', adults }, input)
        break
      }
      if (view.step === 'children') {
        const children = parseQuantity(input.message, 10)
        if (children !== null && view.checkIn && view.checkOut && view.adults) {
          const action: FlowAction = {
            type: 'stay_quote',
            quote: {
              checkIn: view.checkIn,
              checkOut: view.checkOut,
              // El servidor calcula solas las habitaciones que necesita el
              // grupo (greatest(1, ceil(huéspedes/capacidad)) en la RPC)
              roomsCount: 1,
              adults: view.adults,
              children,
              roomTypeId: view.roomTypeId,
            },
          }
          state.lastStay = { roomTypeId: view.roomTypeId, checkIn: view.checkIn, checkOut: view.checkOut }
          state.view = { kind: 'main' }
          const followUps = view.roomTypeId
            ? [STAY_REQUEST_OPTION, OPT_STAY_AGAIN, OPT_TEAM, OPT_HOME]
            : [OPT_STAY_AGAIN, OPT_ROOMS, OPT_TEAM, OPT_HOME]
          return { reply: '', options: followUps, action }
        }
        break
      }
      break
    }
    case 'stay-request': {
      const contactName = input.message.trim()
      if (/[a-záéíóúñ]{2,}/i.test(contactName) && state.lastStay?.roomTypeId) {
        const room = (input.roomTypes || []).find(item => item.id === state.lastStay?.roomTypeId)
        const action: FlowAction = {
          type: 'stay_request',
          roomTypeId: state.lastStay.roomTypeId,
          contactName,
        }
        const stayDates = `del ${formatDateEs(state.lastStay.checkIn)} al ${formatDateEs(state.lastStay.checkOut)}`
        const home = goTo(state, { kind: 'main' }, input)
        return {
          reply: `¡Listo, ${contactName}! 🙌 Registré tu solicitud para *${String(room?.name || 'la habitación').trim()}* ${stayDates}. Nuestro equipo te la confirma en breve.\n${home.reply}`,
          options: home.options,
          action,
        }
      }
      return { reply: `Escríbeme el nombre completo para la solicitud, por favor ✍️`, options: [OPT_HOME] }
    }
    case 'booking': {
      if (view.step === 'date') {
        if (choice === OPT_BACK) return goTo(state, { kind: 'main' }, input)
        if (choice) {
          const day = Object.entries(input.availableSlots || {})
            .find(([date, value]) => (value.label || date) === choice)
          if (day) return goTo(state, { kind: 'booking', step: 'time', date: day[0] }, input)
        }
        break
      }
      if (view.step === 'time') {
        if (choice === OPT_BACK) return goTo(state, { kind: 'booking', step: 'date' }, input)
        if (choice) return goTo(state, { kind: 'booking', step: 'name', date: view.date, time: choice }, input)
        break
      }
      if (view.step === 'name') {
        const name = input.message.trim()
        if (/[a-záéíóúñ]{2,}/i.test(name) && view.date && view.time) {
          const action: FlowAction = { type: 'booking', date: view.date, time: view.time, name }
          const home = goTo(state, { kind: 'main' }, input)
          return {
            reply: `¡Listo, ${name}! 🙌 Registré tu solicitud de cita para el ${view.date} a las ${view.time}. Nuestro equipo te la confirma en breve.\n${home.reply}`,
            options: home.options,
            action,
          }
        }
        return { reply: `Escríbeme el nombre para la cita, por favor ✍️`, options: [OPT_BACK] }
      }
      break
    }
  }

  // Nada coincidió: fallo cerrado — se repite el menú actual, jamás se inventa
  return { reply: NOT_UNDERSTOOD, options: current.options }
}

export { advanceMenuFlow, parseStayRange, resetMenuFlow, STAY_REQUEST_OPTION }
