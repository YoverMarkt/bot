const UNCERTAINTY_PHRASES = [
  'déjame verificar', 'dejame verificar', 'te confirmo en breve',
  'no tengo información', 'no tengo informacion', 'no cuento con esa información',
  'no está en mi información', 'no encuentro', 'no puedo confirmar',
  'consultar directamente', 'no lo sé', 'no lo se', 'no estoy seguro',
  'no tengo ese dato', 'no tengo ese detalle',
] as const

const INSULT_WORDS = new Set([
  'idiota', 'idiotas', 'imbecil', 'imbeciles', 'estupido', 'estupida', 'estupidos',
  'estupidas', 'estupidez', 'maldito', 'maldita', 'malditos', 'malditas', 'inutil',
  'inutiles', 'pendejo', 'pendeja', 'pendejos', 'cabron', 'cabrona', 'cabrones',
  'puta', 'puto', 'putas', 'putos', 'hijueputa', 'hijoputa', 'hdp', 'hpta',
  'malparido', 'malparida', 'gonorrea', 'basura', 'porqueria', 'mierda', 'callate',
  'tarado', 'tarada', 'marica', 'maricon', 'maricón', 'verga', 'culero', 'culiao',
  'joder', 'jodete', 'pinche', 'zorra', 'perra', 'estafador', 'estafadores',
  'estafa', 'ladron', 'ladrones', 'ratero', 'sinverguenza', 'asqueroso',
  'asquerosa', 'fuck', 'fucking', 'bitch', 'idiot', 'asshole', 'stupid', 'shit',
  'wtf', 'damn',
])

const INSULT_PHRASES = [
  'te odio', 'los odio', 'me fastidias', 'me tienes harto', 'me tienes harta',
  'no sirves', 'no sirven', 'son una estafa', 'son unos', 'eres un idiota',
  'eres una', 'vete a la', 'andate a la', 'vayan a la', 'que mierda',
  'una mierda', 'de mierda',
] as const

const SALE_PHRASES = [
  'gracias por tu compra', 'gracias por su compra', 'gracias por tu pedido',
  'gracias por su pedido', 'felicidades por tu compra', 'felicidades por su compra',
  'felicitaciones por tu compra', 'felicitaciones por su compra',
  'coordinar la entrega', 'coordinaremos la entrega', 'para la entrega',
  'su pedido está listo', 'tu pedido está listo', 'confirmar su pedido',
  'confirmar tu pedido', 'compra realizada', 'pedido confirmado',
  'gracias por su pedido', 'queda anotado su pedido', 'queda apartado',
  'tu compra quedó registrada', 'su compra quedó registrada',
] as const

export interface BookingTag {
  contactName: string
  bookingDateRaw: string
  bookingTimeRaw: string
  service: string
  bookingDate: string | null
  bookingTime: string | null
}

export interface LodgingQuoteTag {
  checkInRaw: string
  checkOutRaw: string
  roomsRaw: string
  adultsRaw: string
  childrenRaw: string
  checkIn: string | null
  checkOut: string | null
  roomsCount: number | null
  adults: number | null
  children: number | null
}

export interface LodgingRequestTag {
  roomTypeIdOrName: string
  contactName: string
}

export interface ParsedBotOutput {
  finalText: string
  booking: BookingTag | null
  orderPayload: string | null
  lodgingQuote: LodgingQuoteTag | null
  lodgingRequest: LodgingRequestTag | null
  hasSale: boolean
  hasHandoffTag: boolean
  isUncertain: boolean
  hasActionConflict: boolean
}

function strictDate(value: string): string | null {
  const normalized = value.trim()
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? normalized
    : null
}

function strictPeople(value: string, minimum: number): number | null {
  const normalized = value.trim()
  if (!/^\d{1,3}$/.test(normalized)) return null
  const parsed = Number(normalized)
  return parsed >= minimum && parsed <= 100 ? parsed : null
}

function normalizeWords(text: unknown): string[] {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean)
}

function isInsultMessage(text: unknown): boolean {
  const words = normalizeWords(text)
  if (words.some(word => INSULT_WORDS.has(word))) return true
  const normalized = words.join(' ')
  return INSULT_PHRASES.some(phrase => (
    normalized.includes(phrase.normalize('NFD').replace(/[̀-ͯ]/g, ''))
  ))
}

function detectMediaRequest(text: unknown): { wantsImage: boolean; wantsVideo: boolean } {
  const value = String(text || '')
  return {
    wantsImage: /imagen|im[aá]genes|foto|fotos|mu[eé]strame|muestrame|ens[eé][ñn]ame|ensename|c[oó]mo se ve|como se ve/i.test(value),
    wantsVideo: /v[íi]deos?/i.test(value),
  }
}

function parseBotOutput(reply: unknown): ParsedBotOutput {
  let finalText = String(reply || '')
    .replace(/##IMG##[\s\S]*?(##|$)/g, '')
    .replace(/##CATALOG##/g, '')
    .replace(/\[IMAGE:[^\]]*\]/gi, '')
    .replace(/https?:\/\/res\.cloudinary\.com\/\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  let booking: BookingTag | null = null
  const bookingMatch = finalText.match(/##BOOK:([^|]+)\|([^|]+)\|([^|]+)\|([^#]+)##/)
  if (bookingMatch) {
    finalText = finalText.replace(bookingMatch[0], '').trim()
    const [, contactName, bookingDateRaw, bookingTimeRaw, service] = bookingMatch
    booking = {
      contactName,
      bookingDateRaw,
      bookingTimeRaw,
      service,
      bookingDate: bookingDateRaw.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null,
      bookingTime: bookingTimeRaw.match(/\d{1,2}:\d{2}/)?.[0] || null,
    }
  }

  finalText = finalText.replace('##BOOKING##', '').trim()

  let orderPayload: string | null = null
  const orderMatch = finalText.match(/##\s*PEDIDO\s*:\s*([^#]+)##/i)
  if (orderMatch) {
    orderPayload = orderMatch[1].trim()
    finalText = finalText.replace(orderMatch[0], '').trim()
  }

  const hasSimpleSaleTag = /##\s*(venta|pedido)\s*##/i.test(finalText)
  finalText = finalText.replace(/##\s*(venta|pedido)\s*##/gi, '').trim()

  let lodgingQuote: LodgingQuoteTag | null = null
  const quoteMatch = finalText.match(
    /##\s*STAY_QUOTE\s*:\s*([^|#]*)\|([^|#]*)\|([^|#]*)\|([^|#]*)\|([^|#]*)##/i,
  )
  if (quoteMatch) {
    const [, checkInRaw, checkOutRaw, roomsRaw, adultsRaw, childrenRaw] = quoteMatch
    lodgingQuote = {
      checkInRaw: checkInRaw.trim(),
      checkOutRaw: checkOutRaw.trim(),
      roomsRaw: roomsRaw.trim(),
      adultsRaw: adultsRaw.trim(),
      childrenRaw: childrenRaw.trim(),
      checkIn: strictDate(checkInRaw),
      checkOut: strictDate(checkOutRaw),
      roomsCount: strictPeople(roomsRaw, 1),
      adults: strictPeople(adultsRaw, 1),
      children: strictPeople(childrenRaw, 0),
    }
  }
  finalText = finalText
    .replace(/##\s*STAY_QUOTE\s*:[\s\S]*?##/gi, '')
    .trim()

  let lodgingRequest: LodgingRequestTag | null = null
  const requestMatch = finalText.match(
    /##\s*STAY_REQUEST\s*:\s*([^|#]+)\|([^|#]+)##/i,
  )
  if (requestMatch) {
    lodgingRequest = {
      roomTypeIdOrName: requestMatch[1].trim(),
      contactName: requestMatch[2].trim(),
    }
  }
  finalText = finalText
    .replace(/##\s*STAY_REQUEST\s*:[\s\S]*?##/gi, '')
    .trim()

  const normalizedSaleText = finalText.toLowerCase()
  const hasSale = hasSimpleSaleTag
    || Boolean(orderPayload)
    || SALE_PHRASES.some(phrase => normalizedSaleText.includes(phrase))

  const normalizedReply = finalText.toLowerCase()
  const hasHandoffTag = /##\s*handoff\s*##/i.test(finalText)
  const isUncertain = hasHandoffTag
    || UNCERTAINTY_PHRASES.some(phrase => normalizedReply.includes(phrase))

  const hasLodgingAction = Boolean(lodgingQuote) || Boolean(lodgingRequest)
  const hasActionConflict = hasLodgingAction && [
    Boolean(booking),
    Boolean(orderPayload),
    hasSimpleSaleTag,
    Boolean(lodgingQuote && lodgingRequest),
    hasHandoffTag,
  ].some(Boolean)

  return {
    finalText,
    booking,
    orderPayload,
    lodgingQuote,
    lodgingRequest,
    hasSale,
    hasHandoffTag,
    isUncertain,
    hasActionConflict,
  }
}

export { detectMediaRequest, isInsultMessage, normalizeWords, parseBotOutput }
