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

/**
 * Los estados de pedido que hacen sonar la alarma.
 *
 * ⚠️ Aquí estaba el fallo del 2026-08-08, y no falló nada al compilar: la
 * alarma vigilaba solo `pendiente`, pero desde el día anterior quien paga por
 * transferencia nace en `esperando_pago` y, al subir su comprobante, pasa a
 * `pago_en_revision`. Ninguno de los dos era `pendiente`, así que el negocio
 * no se enteraba de un pedido pagado.
 *
 * `esperando_pago` NO entra a propósito: el dueño no puede hacer nada mientras
 * el cliente no pague, y una alarma que suena cuando no hay nada que hacer
 * enseña a ignorarla. Ese pedido sí se ve en la lista, con su etiqueta.
 */
export const VIGILADOS = ['pendiente', 'pago_en_revision'] as const

export function useAttention(opts: {
  watchSessions: boolean
  watchBookings: boolean
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
  // Un pedido no puede esperar a que el dueño vuelva a la pestaña: es el único
  // vigilado que sigue consultando con la pestaña en segundo plano. Se pide ya
  // filtrado por estado, así que el pago en datos es mínimo.
  const { data: orders = [], isSuccess: ordersLoaded } = useQuery({
    queryKey: ['orders-watch'],
    queryFn: () => api<AttentionOrder[]>(
      `/api/client/orders?status=${VIGILADOS.join(',')}`,
    ),
    refetchInterval: 12_000,
    refetchIntervalInBackground: true,
    enabled: opts.watchOrders === true,
  })

  const manual = sessions.filter((session) => session.manual_mode && session.unread_owner)
  const pending = bookings.filter((booking) => booking.status === 'pending')
  // La alarma vive en el Layout: si la respuesta no fuera una lista, el dueño
  // perdería el panel entero, no solo los pedidos.
  //
  // Se vuelve a filtrar por los MISMOS estados que se pidieron: la consulta ya
  // llega filtrada, pero una respuesta con otro estado —una versión vieja del
  // servidor— haría sonar la alarma por algo que no la merece.
  const pendingOrders = Array.isArray(orders)
    ? orders.filter(order => (VIGILADOS as readonly string[]).includes(order.status))
    : []

  // `ordersLoaded` distingue «todavía no cargó» de «cargó y no hay ninguno»:
  // sin él, el primer pedido que entra con la lista vacía no se avisaría.
  return {
    sessions, bookings,
    manual, pending, pendingOrders, ordersLoaded,
  }
}
