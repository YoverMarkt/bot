export type BusinessMode = 'normal' | 'citas'
export type BusinessSalesMode = 'vende' | 'informa'

export const CUSTOM_BUSINESS_TYPE = '__custom__'

export const BUSINESS_TYPE_OPTIONS = [
  { value: 'negocio', label: 'Otro / negocio genérico', mode: 'normal', sales: 'informa' },
  { value: 'pizzería', label: 'Pizzería', mode: 'normal', sales: 'vende' },
  { value: 'restaurante', label: 'Restaurante', mode: 'normal', sales: 'vende' },
  { value: 'cafetería', label: 'Cafetería', mode: 'normal', sales: 'vende' },
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

const BOOKING_KEYWORDS = BUSINESS_TYPE_OPTIONS
  .filter(option => option.mode === 'citas')
  .map(option => normalizeBusinessType(option.value))

export function recommendedModeForBusinessType(type: string): BusinessMode {
  const normalized = normalizeBusinessType(type)
  if (LODGING_KEYWORDS.some(keyword => normalized.includes(keyword))) return 'normal'
  return BOOKING_KEYWORDS.some(keyword => normalized.includes(keyword)) ? 'citas' : 'normal'
}

export function recommendedSalesForBusinessType(type: string): BusinessSalesMode {
  const normalized = normalizeBusinessType(type)
  if (LODGING_KEYWORDS.some(keyword => normalized.includes(keyword))) return 'informa'
  return BUSINESS_TYPE_OPTIONS.some(option => (
    option.sales === 'vende' && normalized.includes(normalizeBusinessType(option.value))
  )) ? 'vende' : 'informa'
}

export function isLodgingBusinessType(type: string): boolean {
  const normalized = normalizeBusinessType(type)
  return LODGING_KEYWORDS.some(keyword => normalized.includes(keyword))
}

// El tipo solo propone una configuración inicial. La capacidad persistida
// `lodging_enabled` sigue siendo la fuente de verdad y puede activarse también
// para complejos turísticos con un tipo personalizado.
export function recommendedLodgingForBusinessType(type: string): boolean {
  return isLodgingBusinessType(type)
}

export type BusinessChatMode = 'menu' | 'ai'

// Negocios donde el cliente NO explora un catálogo, sino que pregunta o manda
// su lista: catálogos enormes (farmacia, supermercado), consultoría y
// cotización a medida. Ahí el menú frustra y conviene la IA.
const AI_FIRST_KEYWORDS = [
  'farmacia',
  'supermercado',
  'inmobiliaria',
  'taller automotriz',
  'servicios profesionales',
  'distribuidora',
  'mayorista',
  'consultoria',
]

// El tipo solo PROPONE el modo al crear un negocio. `chat_mode` persistido
// manda siempre y nunca se sobrescribe a un negocio existente.
export function recommendedChatModeForBusinessType(type: string): BusinessChatMode {
  const normalized = normalizeBusinessType(type)
  if (!normalized) return 'ai'
  if (AI_FIRST_KEYWORDS.some(keyword => normalized.includes(keyword))) return 'ai'
  // Alojamiento, citas y venta con catálogo acotado: el cliente explora → menú
  if (isLodgingBusinessType(type)) return 'menu'
  if (BOOKING_KEYWORDS.some(keyword => normalized.includes(keyword))) return 'menu'
  return recommendedSalesForBusinessType(type) === 'vende' ? 'menu' : 'ai'
}

export function businessTypeChoice(type: string): string {
  return BUSINESS_TYPE_OPTIONS.some(option => option.value === type)
    ? type
    : CUSTOM_BUSINESS_TYPE
}
