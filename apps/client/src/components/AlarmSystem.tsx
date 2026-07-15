// ── ALARMA INSISTENTE (port fiel del panel viejo) ───────────────────
// Suena mientras haya pendientes SIN ATENDER (estado en BD):
//  · chats en modo manual con unread_owner  · reservas pendientes
// Con: banner fijo, badges, notificación del navegador para reservas
// nuevas, silencio temporal (2 min), tope de 3 min por tanda y
// parpadeo del título de la pestaña.
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { BedDouble, Bell, BellOff, Check, Hand, CalendarPlus } from 'lucide-react'
import * as snd from '../lib/alarm'
import type { Session } from '../features/conversations/api'
import type { AttentionBooking, AttentionLodgingRequest } from '../hooks/useAttention'
import { toast as sonnerToast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'

const ALARM_MAX_MS = 180_000     // 3 minutos seguidos máximo por tanda
const SILENCE_MS = 120_000       // silenciar = callar 2 minutos

export function AlarmBanner({ manual, pending, bookings, lodgingPending, lodgingRequests }: {
  manual: Session[]
  pending: { id: string }[]
  bookings: AttentionBooking[]
  lodgingPending: { id: string }[]
  lodgingRequests: AttentionLodgingRequest[]
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [ringing, setRinging] = useState(false)
  const [alarmEpoch, setAlarmEpoch] = useState(0)
  const silencedUntil = useRef(0)
  const startedAt = useRef(0)
  const beepTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const knownIds = useRef<Set<string> | null>(null)
  const knownLodgingIds = useRef<Set<string> | null>(null)

  const shouldRing = manual.length > 0 || pending.length > 0 || lodgingPending.length > 0

  function recheckAfter(milliseconds: number) {
    if (wakeTimer.current) clearTimeout(wakeTimer.current)
    wakeTimer.current = setTimeout(() => {
      wakeTimer.current = null
      setAlarmEpoch(value => value + 1)
    }, milliseconds + 50)
  }

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

  useEffect(() => {
    const ids = new Set(lodgingRequests.map(request => request.id))
    if (knownLodgingIds.current === null) { knownLodgingIds.current = ids; return }
    const newRequests = lodgingRequests.filter(request => (
      !knownLodgingIds.current!.has(request.id) && request.status === 'pending_owner'
    ))
    knownLodgingIds.current = ids
    for (const request of newRequests) {
      const text = `${request.contact_name || request.contact_phone} · ${request.room_type_name || 'hospedaje'} · ${request.check_in} → ${request.check_out}`
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('🏨 Nueva solicitud de hospedaje', { body: text })
      }
    }
  }, [lodgingRequests])

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
  }, [shouldRing, alarmEpoch])

  useEffect(() => () => {
    if (wakeTimer.current) clearTimeout(wakeTimer.current)
  }, [])

  // El dueño atendió lo manual → marcar leído en BD (calla de forma persistente)
  async function attend() {
    silencedUntil.current = Date.now() + 10_000   // gracia mientras el server confirma
    recheckAfter(10_000)
    setRinging(false); snd.stopAlarmSound(); snd.stopTitleFlash()
    if (beepTimer.current) { clearInterval(beepTimer.current); beepTimer.current = null }
    await Promise.all(manual.map(s =>
      api(`/api/client/sessions/${encodeURIComponent(s.contact_phone)}/read`, { method: 'PUT' }).catch(() => {})
    ))
    qc.invalidateQueries({ queryKey: ['sessions-watch'] })
    // Llevar a lo que necesita atención
    navigate(manual.length ? '/conversations' : lodgingPending.length ? '/lodging' : '/bookings')
  }

  function silence() {
    silencedUntil.current = Date.now() + SILENCE_MS
    recheckAfter(SILENCE_MS)
    setRinging(false); snd.stopAlarmSound(); snd.stopTitleFlash()
    if (beepTimer.current) { clearInterval(beepTimer.current); beepTimer.current = null }
  }

  function test() {
    snd.testAlarmSound(
      () => sonnerToast.info('Sonando… (se detiene en 3s)'),
      (m) => sonnerToast.warning(`Audio bloqueado por el navegador: ${m}`),
    )
  }

  const title = [manual.length, pending.length, lodgingPending.length].filter(Boolean).length > 1
    ? '¡Tienes pendientes!'
    : manual.length ? '¡Atiende a un cliente!'
    : lodgingPending.length ? '¡Nueva solicitud de hospedaje!'
    : '¡Nueva reserva!'
  const parts = []
  if (manual.length) parts.push(`${manual.length} cliente${manual.length !== 1 ? 's' : ''} esperando respuesta`)
  if (pending.length) parts.push(`${pending.length} cita${pending.length !== 1 ? 's' : ''} por confirmar/cancelar`)
  if (lodgingPending.length) parts.push(`${lodgingPending.length} estadía${lodgingPending.length !== 1 ? 's' : ''} por confirmar`)

  return (
    <>
      {ringing && (
        <div className="fixed inset-x-3 bottom-4 z-50 mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-3 rounded-2xl bg-red-600 px-4 py-3 text-white shadow-2xl animate-pulse motion-reduce:animate-none sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:flex-nowrap sm:px-5">
          {manual.length
            ? <Hand className="w-5 h-5" />
            : lodgingPending.length
              ? <BedDouble className="w-5 h-5" />
              : <CalendarPlus className="w-5 h-5" />}
          <div>
            <div className="font-bold text-sm">{title}</div>
            <div className="text-xs opacity-90">{parts.join(' · ') || 'Tienes pendientes por atender'}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={attend}><Check /> Atender</Button>
          <Button variant="outline" size="sm" className="border-white/60 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={silence}><BellOff /> Silenciar 2 min</Button>
        </div>
      )}
      {/* Botón discreto para probar el sonido (desbloquea el audio del navegador) */}
      <Button variant="outline" size="icon" onClick={test} title="Probar sonido de alarma" aria-label="Probar sonido de alarma" className="fixed bottom-4 right-4 z-40"><Bell className="w-4 h-4" /></Button>
    </>
  )
}
