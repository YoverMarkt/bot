// Menú guiado de bienvenida: las opciones las escribe el CÓDIGO con las
// capacidades reales del negocio, nunca la IA. Tocar una opción solo envía ese
// texto al flujo normal del bot, así que el cliente siempre puede ignorar el
// menú y escribir libre. Servicio puro: sin base de datos y sin IA.

interface MenuBusiness {
  name?: string | null
  takes_orders?: boolean | null
  takes_bookings?: boolean | null
  lodging_enabled?: boolean | null
}

interface WelcomeMenu {
  text: string
  options: string[]
}

// Palabras que, solas o combinadas, forman un saludo o un pedido explícito de
// menú SIN contenido útil para la IA ("hola", "buenas tardes", "menú", "info").
// Cualquier palabra fuera de esta lista manda el mensaje al flujo normal.
const GREETING_WORDS = new Set([
  'hola', 'holi', 'holis', 'buenas', 'buenos', 'buen', 'dia', 'dias',
  'tardes', 'noches', 'hey', 'hi', 'hello', 'saludos', 'alo',
  'que', 'tal', 'como', 'esta', 'estas', 'estan',
  'info', 'informacion', 'menu', 'principal', 'opciones', 'inicio',
  'empezar', 'comenzar', 'volver', 'al', 'ayuda',
])

const MAX_GREETING_WORDS = 5

// Minúsculas sin acentos, sin emojis/puntuación y con letras repetidas
// colapsadas ("Holaaa!! 👋" → ["hola"]).
const tokenize = (text: string): string[] => text
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{M}+/gu, '')
  .replace(/[^a-z]+/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map(token => token.replace(/(.)\1{2,}/g, '$1'))

// ¿El mensaje es solo un saludo o un pedido de menú? Un mensaje de puros
// emojis ("👋") también cuenta: no le aporta nada a la IA.
const wantsWelcomeMenu = (text: string): boolean => {
  if (!text.trim()) return false
  const tokens = tokenize(text)
  if (!tokens.length) return true
  if (tokens.length > MAX_GREETING_WORDS) return false
  return tokens.every(token => GREETING_WORDS.has(token))
}

// Arma el menú según las capacidades reales del negocio. Las opciones son el
// texto exacto que se enviará como mensaje del cliente al tocarlas.
const buildWelcomeMenu = (business: MenuBusiness, productCount: number): WelcomeMenu => {
  const options: string[] = []
  if (business.takes_orders) options.push('🛒 Hacer un pedido')
  if (business.takes_bookings) options.push('📅 Agendar una cita')
  if (business.lodging_enabled) options.push('🛏️ Cotizar hospedaje')
  if (productCount > 0) options.push('📋 Ver productos y precios')
  options.push('💬 Otra consulta')

  const name = String(business.name || '').trim()
  const text = [
    name ? `¡Hola! 👋 Gracias por escribir a ${name} 😊` : '¡Hola! 👋 Gracias por escribirnos 😊',
    '¿En qué te puedo ayudar hoy? Elige una opción o escríbeme tu consulta 👇',
  ].join('\n')
  return { text, options }
}

// Versión para el historial: el texto más las opciones ofrecidas, para que la
// IA sepa en el siguiente turno qué se le mostró al cliente.
const menuAsHistory = (menu: WelcomeMenu): string =>
  `${menu.text}\n\n${menu.options.map(option => `• ${option}`).join('\n')}`

export { buildWelcomeMenu, menuAsHistory, wantsWelcomeMenu }
export type { MenuBusiness, WelcomeMenu }
