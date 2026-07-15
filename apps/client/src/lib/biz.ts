// ── Capacidades y tipo de negocio ─────────────────────────────────
// Reservas es una capacidad explícita del negocio. El nombre del catálogo,
// en cambio, depende de si el tipo describe productos o servicios.
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export type BusinessInfo = {
  id: string; name: string; type: string | null
  slogan: string | null; description: string | null; hours: string | null
  address: string | null; phone: string | null; social: string | null
  payment_methods: string | null; suspended: boolean; bot_active: boolean
  takes_bookings: boolean; takes_orders: boolean
  lodging_enabled: boolean
}

// El flag persistido es la única fuente de verdad. El tipo puede recomendar el
// modo durante el alta, pero nunca habilita Reservas por sí solo en el cliente.
export const isBookingBiz = (
  _type?: string | null,
  takesBookings?: boolean | null,
) => takesBookings === true

export const isLodgingBiz = (lodgingEnabled?: boolean | null) => lodgingEnabled === true

const normalizeBusinessType = (type?: string | null) => (type ?? '')
  .toLocaleLowerCase('es')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

// Categorías de servicios comunes y textos personalizados del superadmin.
// Se comparan ya sin acentos para cubrir, por ejemplo, "clínica"/"clinica".
const SERVICE_BIZ_PATTERNS = [
  /\bservicios?\b/,
  /\bhoteles?\b/, /\bhostales?\b/, /\balojamientos?\b/,
  /\bcomplejos? turisticos?\b/, /\bresorts?\b/, /\bcabanas?\b/,
  /\bbarberias?\b/, /\bpeluquerias?\b/, /\bsalones? de belleza\b/,
  /\bspa\b/, /\bestetica\b/, /\bmasajes?\b/, /\bunas\b/, /\bmaquillaje\b/,
  /\bclinicas?\b/, /\bconsultorios?\b/, /\bmedic(?:o|a|os|as)\b/,
  /\bodontolog(?:ia|os?|as?)\b/,
  /\bdentistas?\b/, /\bpsicolog(?:ia|os?|as?)\b/, /\bfisioterapia\b/,
  /\bveterinari(?:a|o|as|os)\b/,
  /\bgimnasios?\b/, /\bgym\b/, /\bentrenadores?\b/, /\byoga\b/, /\bpilates\b/,
  /\btaller(?:es)?\b/, /\binmobiliarias?\b/,
  /\bconsultor(?:ia|ios?|as?)?\b/, /\basesor(?:ia|es|as?)?\b/,
  /\babogad(?:o|a|os|as)\b/, /\bestudio (?:juridico|contable)\b/,
  /\bagencias?\b/, /\bacademias?\b/, /\bescuelas?\b/,
] as const

// Los negocios de servicios dicen "Servicios" aunque no manejen reservas.
export const isServiceBiz = (type?: string | null) => {
  const normalized = normalizeBusinessType(type)
  return normalized.length > 0
    && SERVICE_BIZ_PATTERNS.some(pattern => pattern.test(normalized))
}

export function useBusinessInfo() {
  return useQuery({
    queryKey: ['business'],
    queryFn: () => api<BusinessInfo>('/api/client/business'),
    staleTime: 5 * 60_000,
  })
}
