import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Session } from '../features/conversations/api'

export type AttentionBooking = {
  id: string
  contact_name: string | null
  contact_phone: string
  service: string | null
  booking_date: string
  booking_time: string
  status: string
}

export type AttentionLodgingRequest = {
  id: string
  contact_name: string | null
  contact_phone: string
  room_type_name: string | null
  check_in: string
  check_out: string
  status: string
}

// Pedido esperando al negocio. El total lo calculó el servidor; aquí solo se
// muestra (regla inviolable #8: el panel nunca recalcula dinero).
export type AttentionOrder = {
  id: string
  contact_name: string | null
  contact_phone: string
  total: number | string
  currency?: string
  status: string
  created_at: string
}

export function useAttention(opts: {
  watchSessions: boolean
  watchBookings: boolean
  watchLodging?: boolean
  watchOrders?: boolean
}) {
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions-watch'],
    queryFn: () => api<Session[]>('/api/client/sessions'),
    refetchInterval: 12_000,
    enabled: opts.watchSessions,
  })
  const { data: bookings = [] } = useQuery({
    queryKey: ['bookings-watch'],
    queryFn: () => api<AttentionBooking[]>('/api/client/bookings'),
    refetchInterval: 12_000,
    enabled: opts.watchBookings,
  })
  const { data: lodgingRequests = [] } = useQuery({
    queryKey: ['lodging-requests-watch'],
    queryFn: () => api<AttentionLodgingRequest[]>('/api/client/lodging/requests?status=pending_owner'),
    refetchInterval: 12_000,
    enabled: opts.watchLodging === true,
  })

  // Un pedido no puede esperar a que el dueño vuelva a la pestaña: es el único
  // vigilado que sigue consultando con la pestaña en segundo plano. Se pide ya
  // filtrado por estado, así que el pago en datos es mínimo.
  const { data: orders = [], isSuccess: ordersLoaded } = useQuery({
    queryKey: ['orders-watch'],
    queryFn: () => api<AttentionOrder[]>('/api/client/orders?status=pendiente'),
    refetchInterval: 12_000,
    refetchIntervalInBackground: true,
    enabled: opts.watchOrders === true,
  })

  const manual = sessions.filter((session) => session.manual_mode && session.unread_owner)
  const pending = bookings.filter((booking) => booking.status === 'pending')
  const pendingLodging = lodgingRequests.filter(request => request.status === 'pending_owner')
  // La alarma vive en el Layout: si la respuesta no fuera una lista, el dueño
  // perdería el panel entero, no solo los pedidos.
  const pendingOrders = Array.isArray(orders)
    ? orders.filter(order => order.status === 'pendiente')
    : []

  // `ordersLoaded` distingue «todavía no cargó» de «cargó y no hay ninguno»:
  // sin él, el primer pedido que entra con la lista vacía no se avisaría.
  return {
    sessions, bookings, lodgingRequests,
    manual, pending, pendingLodging, pendingOrders, ordersLoaded,
  }
}
