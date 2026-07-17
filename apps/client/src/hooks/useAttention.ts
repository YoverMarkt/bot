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

export function useAttention(opts: {
  watchSessions: boolean
  watchBookings: boolean
  watchLodging?: boolean
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

  const manual = sessions.filter((session) => session.manual_mode && session.unread_owner)
  const pending = bookings.filter((booking) => booking.status === 'pending')
  const pendingLodging = lodgingRequests.filter(request => request.status === 'pending_owner')

  return { sessions, bookings, lodgingRequests, manual, pending, pendingLodging }
}
