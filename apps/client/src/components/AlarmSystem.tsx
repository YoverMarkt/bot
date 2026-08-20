// ── ALARMA INSISTENTE (port fiel del panel viejo) ───────────────────
// Suena mientras haya pendientes SIN ATENDER (estado en BD):
//  · chats en modo manual con unread_owner
//  · pedidos por aceptar Y comprobantes por revisar (ver VIGILADOS)
// Con: banner fijo, badges, notificación del navegador para pedidos nuevos,
// silencio temporal (2 min), tope de 3 min por tanda y parpadeo del título de
// la pestaña.
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { Bell, BellOff, Check, Hand, ShoppingBag } from 'lucide-react'
import * as snd from '../lib/alarm'
import type { Session } from '../features/conversations/api'
import type { AttentionOrder } from '../hooks/useAttention'
import { toast as sonnerToast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'

const ALARM_MAX_MS = 180_000     // 3 minutos seguidos máximo por tanda
const SILENCE_MS = 120_000       // silenciar = callar 2 minutos

export function AlarmBanner({
  manual, ordersPending, ordersLoaded,
}: {
  manual: Session[]
  // Ya llegan filtrados a los estados de `VIGILADOS`: la misma lista suena y
  // avisa. Son DOS —un pedido por aceptar y un comprobante por revisar—, así
  // que aquí no se puede dar por hecho que todos sean lo mismo.
  ordersPending: AttentionOrder[]
  ordersLoaded: boolean
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [ringing, setRinging] = useState(false)
  const [alarmEpoch, setAlarmEpoch] = useState(0)
  const silencedUntil = useRef(0)
  const startedAt = useRef(0)
  const beepTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const knownOrderIds = useRef<Set<string> | null>(null)

  const shouldRing = manual.length > 0 || ordersPending.length > 0

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

  // Detección de pedidos NUEVOS → notificación del navegador.
  // La base se fija en cuanto la consulta responde, AUNQUE venga vacía: lo
  // normal es no tener pedidos pendientes, y el primero que entre debe avisar.
  useEffect(() => {
    if (!ordersLoaded) return
    const ids = new Set(ordersPending.map(order => order.id))
    if (knownOrderIds.current === null) { knownOrderIds.current = ids; return }
    const newOrders = ordersPending.filter(order => !knownOrderIds.current!.has(order.id))
    knownOrderIds.current = ids
    for (const order of newOrders) {
      const amount = `$${(Number(order.total) || 0).toFixed(2)}`
      const text = `${order.contact_name || order.contact_phone} · ${amount}`
      if ('Notification' in window && Notification.permission === 'granted') {
        // Un comprobante que llega NO es un pedido nuevo: el pedido ya estaba
        // ahí y lo que cambió es que el cliente pagó. Son dos trabajos
        // distintos —uno se acepta, el otro se revisa— y el dueño decide si
        // vale la pena mirar el panel según cuál sea.
        new Notification(
          order.status === 'pago_en_revision' ? '🏦 Comprobante recibido' : '🛒 Nuevo pedido',
          { body: text },
        )
      }
    }
  }, [ordersPending, ordersLoaded])

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
    // Llevar a lo que necesita atención. El pedido sigue «pendiente» en BD
    // hasta que el dueño lo confirme allí: la alarma insiste a propósito.
    navigate(manual.length ? '/conversations' : '/orders')
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

  // Los pedidos que suenan son de dos clases y se cuentan por separado: uno
  // hay que aceptarlo, el otro hay que mirarle el comprobante.
  const porRevisar = ordersPending.filter(order => order.status === 'pago_en_revision')
  const porAceptar = ordersPending.filter(order => order.status !== 'pago_en_revision')

  const title = manual.length && ordersPending.length
    ? '¡Tienes pendientes!'
    : manual.length ? '¡Atiende a un cliente!'
    : porRevisar.length && !porAceptar.length ? '¡Comprobante por revisar!'
    : '¡Nuevo pedido!'
  const parts = []
  if (manual.length) parts.push(`${manual.length} cliente${manual.length !== 1 ? 's' : ''} esperando respuesta`)
  if (porAceptar.length) parts.push(`${porAceptar.length} pedido${porAceptar.length !== 1 ? 's' : ''} por confirmar`)
  if (porRevisar.length) parts.push(`${porRevisar.length} comprobante${porRevisar.length !== 1 ? 's' : ''} por revisar`)

  return (
    <>
      {ringing && (
        <div className="fixed inset-x-3 bottom-4 z-50 mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-3 rounded-2xl bg-red-600 px-4 py-3 text-white shadow-2xl animate-pulse motion-reduce:animate-none sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:flex-nowrap sm:px-5">
          {manual.length ? <Hand className="w-5 h-5" /> : <ShoppingBag className="w-5 h-5" />}
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
