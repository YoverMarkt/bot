// Umbani reparte comida y producto a domicilio. El desplegable ofrece SOLO eso.
//
// Hasta el 2026-08-20 había 52 tipos y 21 eran de otro producto: hospedaje y
// turismo, servicios profesionales, y salud y belleza. Se fueron con la fase 5
// —después de que las citas (fase 2) y el hospedaje (fase 1) dejaran de
// existir—, porque ofrecer «Clínica» en el alta prometía un producto que la
// plataforma ya no sabe atender.
//
// Con ellos se fue `BusinessMode`, que describía si el tipo pedía agenda: era
// un campo muerto desde que salieron las citas y nadie lo leía.
export type BusinessSalesMode = 'vende' | 'informa'

export const CUSTOM_BUSINESS_TYPE = '__custom__'

export const BUSINESS_TYPE_OPTIONS = [
  { value: 'negocio', label: 'Otro / negocio genérico', sales: 'informa' },
  { value: 'pizzería', label: 'Pizzería', sales: 'vende' },
  { value: 'restaurante', label: 'Restaurante', sales: 'vende' },
  { value: 'cafetería', label: 'Cafetería', sales: 'vende' },
  // ── Comida ────────────────────────────────────────────────────────────────
  // Es el grueso del mercado real y hasta ahora solo cabían en «restaurante».
  // Cada uno trae su plantilla de categorías y grupos en el servidor
  // (`services/business-templates.ts`), así que el tipo elegido aquí decide
  // con qué catálogo NACE el negocio.
  { value: 'hamburguesería', label: 'Hamburguesería', sales: 'vende' },
  { value: 'comida rápida', label: 'Comida rápida', sales: 'vende' },
  { value: 'almuerzos', label: 'Almuerzos', sales: 'vende' },
  { value: 'menú ejecutivo', label: 'Menú ejecutivo', sales: 'vende' },
  { value: 'comida típica', label: 'Comida típica', sales: 'vende' },
  { value: 'desayunos', label: 'Desayunos', sales: 'vende' },
  { value: 'asadero', label: 'Asadero', sales: 'vende' },
  { value: 'parrillada', label: 'Parrillada', sales: 'vende' },
  { value: 'pollo asado', label: 'Pollo asado / broaster', sales: 'vende' },
  { value: 'marisquería', label: 'Marisquería / cevichería', sales: 'vende' },
  { value: 'sushi', label: 'Sushi / comida japonesa', sales: 'vende' },
  { value: 'comida mexicana', label: 'Comida mexicana', sales: 'vende' },
  { value: 'comida china', label: 'Comida china', sales: 'vende' },
  { value: 'comida saludable', label: 'Comida saludable', sales: 'vende' },
  { value: 'heladería', label: 'Heladería', sales: 'vende' },
  { value: 'pastelería', label: 'Pastelería', sales: 'vende' },
  { value: 'postres', label: 'Postres', sales: 'vende' },
  { value: 'batidos', label: 'Batidos / smoothies', sales: 'vende' },
  { value: 'jugos', label: 'Jugos naturales', sales: 'vende' },
  { value: 'carnicería', label: 'Carnicería / preparados', sales: 'vende' },
  { value: 'emprendimiento de comida', label: 'Emprendimiento de comida', sales: 'vende' },
  { value: 'tienda', label: 'Tienda', sales: 'vende' },
  { value: 'perfumería', label: 'Perfumería', sales: 'vende' },
  { value: 'farmacia', label: 'Farmacia', sales: 'vende' },
  { value: 'ferretería', label: 'Ferretería', sales: 'vende' },
  { value: 'panadería', label: 'Panadería', sales: 'vende' },
  { value: 'supermercado', label: 'Supermercado', sales: 'vende' },
] as const satisfies ReadonlyArray<{
  value: string
  label: string
  sales: BusinessSalesMode
}>

function normalizeBusinessType(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// Un tipo escrito a mano hereda el modo del tipo conocido que lo contenga:
// «pizzería artesanal» vende porque contiene «pizzería».
//
// ⚠️ Hasta el 2026-08-20 había además una lista de palabras de alojamiento que
// forzaba «informa» —hotel, hostal, resort, cabañas…—. Se fue con los tipos:
// ninguna de esas palabras contiene un tipo que venda, así que sin la lista
// caen igualmente en «informa». Lo único que cambia es un caso de esquina que
// ahora acierta más: «hostal con restaurante» pasa a proponerse como que vende,
// que es lo correcto en una plataforma de domicilios.
export function recommendedSalesForBusinessType(type: string): BusinessSalesMode {
  const normalized = normalizeBusinessType(type)
  return BUSINESS_TYPE_OPTIONS.some(option => (
    option.sales === 'vende' && normalized.includes(normalizeBusinessType(option.value))
  )) ? 'vende' : 'informa'
}

// ¿A este negocio le sirve una mini app?
//
// Con el desplegable reducido a comida y retail la respuesta es «sí» para todo
// lo que vende, que es casi todo. Queda como función y no como constante porque
// el superadmin puede escribir un tipo a mano: «Otro / negocio genérico» y lo
// tecleado libremente siguen pudiendo salir en «informa», y a esos no se les
// propone tienda.
//
// Como el resto, esto solo PROPONE al crear: `storefront_enabled` persistido
// manda siempre y jamás se le sobrescribe a un negocio existente.
export function recommendedStorefrontForBusinessType(type: string): boolean {
  return recommendedSalesForBusinessType(type) === 'vende'
}

export type BusinessChatMode = 'menu' | 'miniapp'

// El tipo solo PROPONE el modo al crear un negocio. `chat_mode` persistido
// manda siempre y nunca se sobrescribe a un negocio existente.
//
// La regla de fondo: un negocio que tiene mini app atiende en modo 'miniapp',
// porque la app YA es donde se pide. Antes esos negocios salían en modo menú y
// recibían el menú de botones Y el enlace a la vez — dos formas de hacer lo
// mismo compitiendo en el mismo chat.
//
// El modo 'menu' no se RECOMIENDA automáticamente, pero sigue disponible: lo
// elige a mano el superadmin para el negocio que quiere pedir sin IA y sin
// mini app. Dejó de proponerse solo cuando salieron las citas, que eran los
// negocios con la lista corta de servicios donde encajaba.
/**
 * Los tipos cuyo catálogo típico NO cabe en una lista de WhatsApp.
 *
 * Se lista la EXCEPCIÓN y no la regla: son ocho frente a veintidós, y así
 * añadir un tipo de comida nuevo cae solo en el lado correcto sin que nadie
 * tenga que acordarse de clasificarlo.
 *
 * El criterio es cuántos PRODUCTOS distintos maneja el negocio, no cuántas
 * opciones: los diecinueve sabores de una pizzería son opciones de un mismo
 * producto, así que una pizzería tiene catálogo corto aunque su carta parezca
 * larga. Un supermercado tiene cientos de productos de verdad.
 */
const CATALOGO_LARGO = [
  // Retail: cientos de SKU, imposible de recorrer hablando.
  'tienda', 'perfumería', 'farmacia', 'ferretería', 'supermercado',
  'panadería',
  // Comida de carta larga.
  'restaurante', 'pastelería', 'sushi', 'comida china', 'marisquería',
]

/**
 * Con qué modo NACE un negocio. Solo PROPONE al crear: `chat_mode` persistido
 * manda siempre y jamás se sobrescribe a un negocio existente.
 *
 * ⚠️ Hasta el 2026-08-21 esto era `vende ? 'miniapp' : 'menu'`, o sea que
 * TODO lo que vendía nacía en mini app — y con el desplegable reducido a
 * comida y retail, eso era todo menos el genérico. Una almuercería con cuatro
 * platos del día salía «Mini app», que es justo al revés de lo que conviene:
 * cuatro opciones se eligen mejor en el chat que abriendo un enlace.
 *
 * ⚠️ Es una RECOMENDACIÓN, no la última palabra. Dentro del marketplace, lo
 * que decide de verdad es el catálogo REAL contado al elegir el local (la
 * regla de los 20): un tipo mal clasificado aquí se corrige solo en cuanto
 * el negocio tiene productos. Esto solo evita que el alta muestre un valor
 * que contradice lo que va a pasar después.
 */
export function recommendedChatModeForBusinessType(type: string): BusinessChatMode {
  // Sin pedidos no hay menú de compra que conducir: el genérico y lo que se
  // teclee a mano caen aquí.
  if (recommendedSalesForBusinessType(type) !== 'vende') return 'menu'

  const normalized = normalizeBusinessType(type)
  const largo = CATALOGO_LARGO.some(candidato => (
    normalized.includes(normalizeBusinessType(candidato))
  ))
  return largo ? 'miniapp' : 'menu'
}

export function businessTypeChoice(type: string): string {
  return BUSINESS_TYPE_OPTIONS.some(option => option.value === type)
    ? type
    : CUSTOM_BUSINESS_TYPE
}
