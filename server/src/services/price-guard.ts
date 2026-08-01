// Vigilante de precios en las respuestas de la IA.
//
// Regla inviolable #8 del proyecto: «la IA conversa, el CÓDIGO calcula». Los
// montos oficiales salen de `money.ts` y de las RPC; la IA solo debería repetir
// precios que ya están en los datos del negocio. Este módulo comprueba que sea
// así: extrae cada monto que la IA escribe y lo confronta con el catálogo real.
//
// ⚠️ ARRANCA EN MODO OBSERVACIÓN A PROPÓSITO. Un validador que descarta mensajes
// desde el primer día haría más daño que el problema que resuelve: bastaría un
// caso legítimo no contemplado para cortarle la conversación a un cliente real.
// Primero se recoge evidencia con `PRICE_GUARD_MODE=observar` (el valor por
// defecto) y solo cuando los datos digan que no hay falsos positivos se pasa a
// `bloquear`.

/** Cuántas unidades de un mismo producto se consideran un total plausible. */
const MAX_UNIDADES = 99

/** Céntimos de margen para absorber redondeos. */
const TOLERANCIA = 0.011

export type PriceGuardMode = 'observar' | 'bloquear'

export interface PriceGuardResult {
  /** true si todos los montos citados se explican con los datos del negocio. */
  ok: boolean
  /** Montos que la IA escribió y no se corresponden con ningún dato real. */
  invented: number[]
  /** Todos los montos detectados en el texto. */
  quoted: number[]
}

/**
 * Solo se miran cifras con moneda explícita. Sin este filtro, «3 noches»,
 * «10:00» o «2 personas» se leerían como precios y el vigilante sería inútil
 * de puro ruidoso.
 */
const PATRONES: RegExp[] = [
  /\$\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g,
  /(\d+(?:[.,]\d{1,2})?)\s*(?:usd|dólares|dolares)\b/gi,
  /\busd\s*(\d+(?:[.,]\d{1,2})?)/gi,
]

/** Convierte «1.234,50» y «1,234.50» al número que representan. */
function parseAmount(raw: string): number | null {
  let texto = raw.trim()
  const tieneComa = texto.includes(',')
  const tienePunto = texto.includes('.')
  if (tieneComa && tienePunto) {
    // El último separador es el decimal; el otro agrupa millares.
    texto = texto.lastIndexOf(',') > texto.lastIndexOf('.')
      ? texto.replace(/\./g, '').replace(',', '.')
      : texto.replace(/,/g, '')
  } else if (tieneComa) {
    // Una coma sola: decimal si deja 1-2 dígitos detrás, si no son millares.
    const [, decimales = ''] = texto.split(',')
    texto = decimales.length <= 2 ? texto.replace(',', '.') : texto.replace(/,/g, '')
  }
  const valor = Number.parseFloat(texto)
  return Number.isFinite(valor) ? Math.round(valor * 100) / 100 : null
}

/** Extrae los montos con moneda que aparecen en un texto. */
export function extractQuotedAmounts(text: unknown): number[] {
  const contenido = typeof text === 'string' ? text : ''
  const montos: number[] = []
  for (const patron of PATRONES) {
    for (const match of contenido.matchAll(patron)) {
      const valor = parseAmount(match[1] || '')
      if (valor !== null && valor > 0) montos.push(valor)
    }
  }
  return [...new Set(montos)]
}

const cerca = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCIA

/**
 * ¿Se explica este monto con los datos reales del negocio?
 *
 * Vale como explicación: coincidir con un precio del catálogo, ser un múltiplo
 * entero de uno (2 noches × $95 = $190), o coincidir con un monto que el propio
 * servidor ya calculó en este turno —el total oficial de un pedido o de una
 * cotización, que la IA puede estar repitiendo legítimamente—.
 */
function seExplica(monto: number, permitidos: number[]): boolean {
  for (const permitido of permitidos) {
    if (permitido <= 0) continue
    if (cerca(monto, permitido)) return true
    const unidades = Math.round(monto / permitido)
    if (unidades >= 2 && unidades <= MAX_UNIDADES && cerca(monto, permitido * unidades)) {
      return true
    }
  }
  return false
}

/**
 * Comprueba los montos de una respuesta contra los datos reales del negocio.
 * `allowedAmounts` debe traer los precios del catálogo, las tarifas vigentes y
 * cualquier cifra que el servidor haya calculado en este turno.
 */
export function checkQuotedPrices(input: {
  text: unknown
  allowedAmounts: Array<number | string | null | undefined>
}): PriceGuardResult {
  const permitidos = input.allowedAmounts
    .map(valor => (typeof valor === 'number' ? valor : Number.parseFloat(String(valor ?? ''))))
    .filter(valor => Number.isFinite(valor) && valor > 0)
  const quoted = extractQuotedAmounts(input.text)
  // Sin catálogo con precios no hay contra qué contrastar: acusar de inventar
  // sería adivinar, y este vigilante no adivina.
  const invented = permitidos.length
    ? quoted.filter(monto => !seExplica(monto, permitidos))
    : []
  return { ok: invented.length === 0, invented, quoted }
}

/**
 * Modo de operación. Por defecto observa: registra el hallazgo sin tocar la
 * conversación. Solo con `PRICE_GUARD_MODE=bloquear` descarta el mensaje.
 */
export function priceGuardMode(env: NodeJS.ProcessEnv = process.env): PriceGuardMode {
  return String(env.PRICE_GUARD_MODE || '').trim().toLowerCase() === 'bloquear'
    ? 'bloquear'
    : 'observar'
}
