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

// ⚠️ Aquí vivían `PEDIDO_SIMPLE`, `BusinessChatMode` y
// `recommendedChatModeForBusinessType`, y se fueron el 2026-09-16.
//
// `PEDIDO_SIMPLE` clasificaba qué tipos «se piden bien dentro del chat»: una
// almuercería sí, una pizzería no. Fue un criterio útil y del dueño, pero dejó
// de ser verdad el 2026-09-15, cuando TODO local pasó a pedir por su mini app.
// Mantenerlo era peor que borrarlo: la prueba que lo vigilaba seguía fijando
// que «una almuercería pide por el CHAT», que ya es falso, y el alta podía
// acabar proponiendo un modo que el sistema no cumple — que es exactamente
// cómo nació el fallo del número.
//
// Su hermano gemelo en la base, `marketplace_category_types.pide_en_chat`, se
// retiró ayer por lo mismo.

/** Cómo se le explica al superadmin, en una línea. */
export function chatModeSummary(type: string): string {
  if (recommendedSalesForBusinessType(type) !== 'vende') {
    return 'Responderá consultas por el chat; no crea pedidos.'
  }
  // ⚠️ Una sola frase desde el 2026-09-15: el pedido por chat se retiró y TODO
  // local pide por su mini app. Antes esto decía «pedirá por el chat» a una
  // almuercería, y habría sido mentirle al superadmin en el alta.
  return 'Pedirá por su mini app: el chat le lleva el enlace.'
}

export function businessTypeChoice(type: string): string {
  return BUSINESS_TYPE_OPTIONS.some(option => option.value === type)
    ? type
    : CUSTOM_BUSINESS_TYPE
}
