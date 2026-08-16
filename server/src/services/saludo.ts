// ¿El mensaje es SOLO un saludo?
//
// Vivía en `bot-menu.ts`, junto al menú guiado, y sobrevivió a su retirada
// porque no era del menú: es lo que decide cuándo el modo mini app manda el
// enlace de la tienda. Solo ante un saludo — quien ya pregunta algo concreto
// no lo quiere, y cada enlace es un mensaje que se paga.
//
// Servicio puro: sin base de datos y sin IA.

// Palabras que, solas o combinadas, forman un saludo o un pedido de menú SIN
// contenido útil ("hola", "buenas tardes", "menú", "info"). Cualquier palabra
// fuera de esta lista significa que el cliente vino a decir algo concreto.
const PALABRAS_DE_SALUDO = new Set([
  'hola', 'holi', 'holis', 'buenas', 'buenos', 'buen', 'dia', 'dias',
  'tardes', 'noches', 'hey', 'hi', 'hello', 'saludos', 'alo',
  'que', 'tal', 'como', 'esta', 'estas', 'estan',
  'info', 'informacion', 'menu', 'principal', 'opciones', 'inicio',
  'empezar', 'comenzar', 'volver', 'al', 'ayuda',
])

const MAX_PALABRAS = 5

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

/**
 * Un mensaje de puros emojis ("👋") también cuenta como saludo: no dice nada
 * concreto, así que el enlace es justo lo que esa persona necesita.
 */
export const esSoloUnSaludo = (text: string): boolean => {
  if (!text.trim()) return false
  const tokens = tokenize(text)
  if (!tokens.length) return true
  if (tokens.length > MAX_PALABRAS) return false
  return tokens.every(token => PALABRAS_DE_SALUDO.has(token))
}
