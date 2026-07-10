// ── Tipo de negocio (misma lógica del panel viejo) ──────────────────
// Los negocios "de citas" muestran Reservas y usan wording "Servicios".
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export type BusinessInfo = {
  id: string; name: string; type: string | null
  slogan: string | null; description: string | null; hours: string | null
  address: string | null; phone: string | null; social: string | null
  payment_methods: string | null; suspended: boolean; bot_active: boolean
}

// Misma lista del panel viejo (BOOKING_BIZ_TYPES)
const BOOKING_BIZ_TYPES = [
  'barbería', 'peluquería', 'salón de belleza', 'spa', 'restaurante', 'clínica',
  'odontología', 'psicología', 'gym', 'barberia', 'peluqueria', 'salon de belleza',
  'clinica', 'odontologia', 'psicologia',
]

export const isBookingBiz = (type?: string | null) =>
  BOOKING_BIZ_TYPES.some(t => (type ?? '').toLowerCase().includes(t))

// Wording del viejo: negocios de servicios dicen "Servicios", el resto "Catálogo"
export const isServiceBiz = isBookingBiz

export function useBusinessInfo() {
  return useQuery({
    queryKey: ['business'],
    queryFn: () => api<BusinessInfo>('/api/client/business'),
    staleTime: 5 * 60_000,
  })
}
