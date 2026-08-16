// `mode` describe si el tipo pedía agenda. La agenda se retiró el 2026-08-16
// y el campo ya no decide nada; se conserva hasta que la fase 5 borre los
// tipos que no son de comida ni retail, que es cuando desaparece con ellos.
export type BusinessMode = 'normal' | 'citas'
export type BusinessSalesMode = 'vende' | 'informa'

export const CUSTOM_BUSINESS_TYPE = '__custom__'

export const BUSINESS_TYPE_OPTIONS = [
  { value: 'negocio', label: 'Otro / negocio genérico', mode: 'normal', sales: 'informa' },
  { value: 'pizzería', label: 'Pizzería', mode: 'normal', sales: 'vende' },
  { value: 'restaurante', label: 'Restaurante', mode: 'normal', sales: 'vende' },
  { value: 'cafetería', label: 'Cafetería', mode: 'normal', sales: 'vende' },
  // ── Comida ────────────────────────────────────────────────────────────────
  // Es el grueso del mercado real y hasta ahora solo cabían en «restaurante».
  // Cada uno trae su plantilla de categorías y grupos en el servidor
  // (`services/business-templates.ts`), así que el tipo elegido aquí decide
  // con qué catálogo NACE el negocio.
  { value: 'hamburguesería', label: 'Hamburguesería', mode: 'normal', sales: 'vende' },
  { value: 'comida rápida', label: 'Comida rápida', mode: 'normal', sales: 'vende' },
  { value: 'almuerzos', label: 'Almuerzos', mode: 'normal', sales: 'vende' },
  { value: 'menú ejecutivo', label: 'Menú ejecutivo', mode: 'normal', sales: 'vende' },
  { value: 'comida típica', label: 'Comida típica', mode: 'normal', sales: 'vende' },
  { value: 'desayunos', label: 'Desayunos', mode: 'normal', sales: 'vende' },
  { value: 'asadero', label: 'Asadero', mode: 'normal', sales: 'vende' },
  { value: 'parrillada', label: 'Parrillada', mode: 'normal', sales: 'vende' },
  { value: 'pollo asado', label: 'Pollo asado / broaster', mode: 'normal', sales: 'vende' },
  { value: 'marisquería', label: 'Marisquería / cevichería', mode: 'normal', sales: 'vende' },
  { value: 'sushi', label: 'Sushi / comida japonesa', mode: 'normal', sales: 'vende' },
  { value: 'comida mexicana', label: 'Comida mexicana', mode: 'normal', sales: 'vende' },
  { value: 'comida china', label: 'Comida china', mode: 'normal', sales: 'vende' },
  { value: 'comida saludable', label: 'Comida saludable', mode: 'normal', sales: 'vende' },
  { value: 'heladería', label: 'Heladería', mode: 'normal', sales: 'vende' },
  { value: 'pastelería', label: 'Pastelería', mode: 'normal', sales: 'vende' },
  { value: 'postres', label: 'Postres', mode: 'normal', sales: 'vende' },
  { value: 'batidos', label: 'Batidos / smoothies', mode: 'normal', sales: 'vende' },
  { value: 'jugos', label: 'Jugos naturales', mode: 'normal', sales: 'vende' },
  { value: 'carnicería', label: 'Carnicería / preparados', mode: 'normal', sales: 'vende' },
  { value: 'emprendimiento de comida', label: 'Emprendimiento de comida', mode: 'normal', sales: 'vende' },
  { value: 'tienda', label: 'Tienda', mode: 'normal', sales: 'vende' },
  { value: 'perfumería', label: 'Perfumería', mode: 'normal', sales: 'vende' },
  { value: 'farmacia', label: 'Farmacia', mode: 'normal', sales: 'vende' },
  { value: 'ferretería', label: 'Ferretería', mode: 'normal', sales: 'vende' },
  { value: 'panadería', label: 'Panadería', mode: 'normal', sales: 'vende' },
  { value: 'supermercado', label: 'Supermercado', mode: 'normal', sales: 'vende' },
  { value: 'inmobiliaria', label: 'Inmobiliaria', mode: 'normal', sales: 'informa' },
  { value: 'taller automotriz', label: 'Taller automotriz', mode: 'normal', sales: 'informa' },
  { value: 'servicios profesionales', label: 'Servicios profesionales', mode: 'normal', sales: 'informa' },
  { value: 'hotel', label: 'Hotel', mode: 'normal', sales: 'informa' },
  { value: 'hostal', label: 'Hostal', mode: 'normal', sales: 'informa' },
  { value: 'alojamiento', label: 'Alojamiento', mode: 'normal', sales: 'informa' },
  { value: 'complejo turístico', label: 'Complejo turístico', mode: 'normal', sales: 'informa' },
  { value: 'resort', label: 'Resort', mode: 'normal', sales: 'informa' },
  { value: 'cabañas', label: 'Cabañas', mode: 'normal', sales: 'informa' },
  { value: 'barbería', label: 'Barbería', mode: 'citas', sales: 'informa' },
  { value: 'peluquería', label: 'Peluquería', mode: 'citas', sales: 'informa' },
  { value: 'salón de belleza', label: 'Salón de belleza', mode: 'citas', sales: 'informa' },
  { value: 'spa', label: 'Spa', mode: 'citas', sales: 'informa' },
  { value: 'centro de estética', label: 'Centro de estética', mode: 'citas', sales: 'informa' },
  { value: 'clínica', label: 'Clínica', mode: 'citas', sales: 'informa' },
  { value: 'consultorio', label: 'Consultorio', mode: 'citas', sales: 'informa' },
  { value: 'odontología', label: 'Odontología', mode: 'citas', sales: 'informa' },
  { value: 'psicología', label: 'Psicología', mode: 'citas', sales: 'informa' },
  { value: 'fisioterapia', label: 'Fisioterapia', mode: 'citas', sales: 'informa' },
  { value: 'gimnasio', label: 'Gimnasio / entrenamiento', mode: 'citas', sales: 'informa' },
  { value: 'masajes', label: 'Masajes', mode: 'citas', sales: 'informa' },
] as const satisfies ReadonlyArray<{
  value: string
  label: string
  mode: BusinessMode
  sales: BusinessSalesMode
}>

function normalizeBusinessType(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

const LODGING_KEYWORDS = [
  'hotel',
  'hostal',
  'alojamiento',
  'complejo turistico',
  'resort',
  'cabana',
  'cabanas',
  'apart hotel',
]

export function recommendedSalesForBusinessType(type: string): BusinessSalesMode {
  const normalized = normalizeBusinessType(type)
  if (LODGING_KEYWORDS.some(keyword => normalized.includes(keyword))) return 'informa'
  return BUSINESS_TYPE_OPTIONS.some(option => (
    option.sales === 'vende' && normalized.includes(normalizeBusinessType(option.value))
  )) ? 'vende' : 'informa'
}

// ¿A este negocio le sirve una mini app?
//
// La regla no es el tamaño del negocio sino cuánto TARDA el cliente en decidir.
// La comida se elige con calma, mirando fotos y comparando: ahí una tienda
// vende más que una conversación. Una barbería se resuelve en dos mensajes
// ("¿mañana a las 4?") y montarle una app sería peor experiencia.
//
// Como el resto, esto solo PROPONE al crear: `storefront_enabled` persistido
// manda siempre y jamás se le sobrescribe a un negocio existente.
//
// ⚠️ Hasta el 2026-08-16 los tipos de alojamiento también recomendaban tienda,
// porque la mini app tenía un flujo de estadías. Con hospedaje retirado, un
// hotel solo informa y `ClientModal` ya no le deja encenderla: recomendarla
// dejaría el desplegable diciendo «sí» y el guardado poniendo «no».
export function recommendedStorefrontForBusinessType(type: string): boolean {
  return recommendedSalesForBusinessType(type) === 'vende'
}

export type BusinessChatMode = 'menu' | 'ai' | 'miniapp'

// ⚠️ Aquí vivía AI_FIRST_KEYWORDS: los negocios donde el cliente no explora un
// catálogo (farmacia, supermercado, consultoría) y el menú de botones frustra.
// Distinguía 'ai' de 'menu', y con la agenda fuera ya nadie recomienda 'menu',
// así que las dos ramas devolvían lo mismo. La fase 3 retira el modo menú
// entero y con él la última razón de esta lista.

// El tipo solo PROPONE el modo al crear un negocio. `chat_mode` persistido
// manda siempre y nunca se sobrescribe a un negocio existente.
//
// La regla de fondo: un negocio que tiene mini app atiende en modo 'miniapp',
// porque la app YA es donde se pide. Antes esos negocios salían en modo menú y
// recibían el menú de botones Y el enlace a la vez — dos formas de hacer lo
// mismo compitiendo en el mismo chat.
//
// El modo 'menu' dejó de recomendarse el 2026-08-16: lo pedían las barberías y
// los consultorios por su lista corta de servicios, y esos negocios salieron
// con la agenda.
export function recommendedChatModeForBusinessType(type: string): BusinessChatMode {
  const normalized = normalizeBusinessType(type)
  if (!normalized) return 'ai'
  // Con tienda (restaurante, tienda, hotel) el pedido va por la app y la IA
  // se queda para resolver dudas.
  if (recommendedStorefrontForBusinessType(type)) return 'miniapp'
  return 'ai'
}

export function businessTypeChoice(type: string): string {
  return BUSINESS_TYPE_OPTIONS.some(option => option.value === type)
    ? type
    : CUSTOM_BUSINESS_TYPE
}
