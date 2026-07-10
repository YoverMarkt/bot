// ── ALARMA INSISTENTE (port fiel del panel viejo) ───────────────────
// Suena mientras haya pendientes SIN ATENDER (estado en BD):
//  · chats en modo manual con unread_owner  · reservas pendientes
// Con: banner fijo, badges, notificación del navegador para reservas
// nuevas, silencio temporal (2 min), tope de 3 min por tanda y
// parpadeo del título de la pestaña.
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import * as snd from '../lib/alarm'
import type { Session } from '../features/conversations/api'

type Booking = {
  id: string; contact_name: string | null; contact_phone: string
  service: string | null; booking_date: string; booking_time: string; status: string
}

const ALARM_MAX_MS = 180_000     // 3 minutos seguidos máximo por tanda
const SILENCE_MS = 120_000       // silenciar = callar 2 minutos

export function useAttention(opts: { watchSessions: boolean; watchBookings: boolean }) {
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions-watch'],
    queryFn: () => api<Session[]>('/api/client/sessions'),
    refetchInterval: 12_000,
    enabled: opts.watchSessions,
  })
  const { data: bookings = [] } = useQuery({
    queryKey: ['bookings-watch'],
    queryFn: () => api<Booking[]>('/api/client/bookings'),
    refetchInterval: 12_000,
    enabled: opts.watchBookings,
  })

  const manual = sessions.filter(s => s.manual_mode && s.unread_owner)
  const pending = bookings.filter(b => b.status === 'pending')
  return { sessions, bookings, manual, pending }
}

export function AlarmBanner({ manual, pending, bookings }: {
  manual: Session[]; pending: { id: string }[]; bookings: Booking[]
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [ringing, setRinging] = useState(false)
  const [toast, setToast] = useState('')
  const silencedUntil = useRef(0)
  const startedAt = useRef(0)
  const beepTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const knownIds = useRef<Set<string> | null>(null)

  const shouldRing = manual.length > 0 || pending.length > 0

  // Desbloquear audio con la primera interacción + pedir permiso de notificaciones
  useEffect(() => {
    const unlock = () => snd.unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
    const onVisible = () => { if (!document.hidden) snd.unlockAudio() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener('pointerdown', unlock); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // Detección de reservas NUEVAS → notificación del navegador (primera carga no notifica)
  useEffect(() => {
    if (!bookings.length && knownIds.current === null) return
    const ids = new Set(bookings.map(b => b.id))
    if (knownIds.current === null) { knownIds.current = ids; return }
    const nuevos = bookings.filter(b => !knownIds.current!.has(b.id) && b.status !== 'cancelled')
    knownIds.current = ids
    for (const b of nuevos) {
      const txt = `${b.contact_name || b.contact_phone} · ${b.service || 'cita'} · ${b.booking_date} ${(b.booking_time || '').slice(0, 5)}`
      if ('Notification' in window && Notification.permission === 'granted') new Notification('🔔 Nueva reserva', { body: txt })
    }
  }, [bookings])

  // Motor de la alarma: arranca/para según el estado real en BD
  useEffect(() => {
    const stop = () => {
      if (beepTimer.current) clearInterval(beepTimer.current)
      beepTimer.current = null
      snd.stopAlarmSound()
      snd.stopTitleFlash()
      setRinging(false)
    }
    if (!shouldRing || Date.now() < silencedUntil.current) { stop(); return }
    if (beepTimer.current) return   // ya sonando
    startedAt.current = Date.now()
    setRinging(true)
    snd.playAlarm()
    snd.startTitleFlash()
    beepTimer.current = setInterval(() => {
      if (Date.now() - startedAt.current > ALARM_MAX_MS || Date.now() < silencedUntil.current) { stop(); return }
      snd.webBeep()
    }, 2500)
    return stop
  }, [shouldRing])

  // El dueño atendió lo manual → marcar leído en BD (calla de forma persistente)
  async function attend() {
    silencedUntil.current = Date.now() + 10_000   // gracia mientras el server confirma
    setRinging(false); snd.stopAlarmSound(); snd.stopTitleFlash()
    if (beepTimer.current) { clearInterval(beepTimer.current); beepTimer.current = null }
    await Promise.all(manual.map(s =>
      api(`/api/client/sessions/${encodeURIComponent(s.contact_phone)}/read`, { method: 'PUT' }).catch(() => {})
    ))
    qc.invalidateQueries({ queryKey: ['sessions-watch'] })
    // Llevar a lo que necesita atención
    navigate(manual.length ? '/conversations' : '/bookings')
  }

  function silence() {
    silencedUntil.current = Date.now() + SILENCE_MS
    setRinging(false); snd.stopAlarmSound(); snd.stopTitleFlash()
    if (beepTimer.current) { clearInterval(beepTimer.current); beepTimer.current = null }
  }

  function test() {
    snd.testAlarmSound(
      () => { setToast('🔊 Sonando… (se detiene en 3s)'); setTimeout(() => setToast(''), 3200) },
      (m) => { setToast(`⚠️ Audio bloqueado por el navegador: ${m}`); setTimeout(() => setToast(''), 4000) },
    )
  }

  const title = manual.length && pending.length ? '🔔 ¡Tienes pendientes!'
    : manual.length ? '🙋 ¡Atiende a un cliente!'
    : '🗓️ ¡Nueva reserva!'
  const parts = []
  if (manual.length) parts.push(`${manual.length} cliente${manual.length !== 1 ? 's' : ''} esperando respuesta`)
  if (pending.length) parts.push(`${pending.length} cita${pending.length !== 1 ? 's' : ''} por confirmar/cancelar`)

  return (
    <>
      {ringing && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white rounded-2xl shadow-2xl px-5 py-3 flex items-center gap-4 animate-pulse">
          <div>
            <div className="font-bold text-sm">{title}</div>
            <div className="text-xs opacity-90">{parts.join(' · ') || 'Tienes pendientes por atender'}</div>
          </div>
          <button onClick={attend} className="rounded-lg bg-white text-red-700 font-bold text-xs px-3 py-2">✅ Atender</button>
          <button onClick={silence} className="rounded-lg border border-white/50 text-white text-xs px-3 py-2">🔕 Silenciar 2 min</button>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-stone-900 text-white text-sm rounded-xl px-4 py-2.5 shadow-xl">{toast}</div>
      )}
      {/* Botón discreto para probar el sonido (desbloquea el audio del navegador) */}
      <button onClick={test} title="Probar sonido de alarma"
        className="fixed bottom-4 right-4 z-40 rounded-full bg-card border shadow w-9 h-9 text-sm hover:bg-muted/50"
        style={{ display: toast ? 'none' : undefined }}>🔔</button>
    </>
  )
}
