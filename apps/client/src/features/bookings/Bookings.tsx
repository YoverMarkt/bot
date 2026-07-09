import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'

// ── Tipos (tablas bookings y business_schedule del server) ──
type Booking = {
  id: string
  contact_name: string | null
  contact_phone: string
  service: string | null
  booking_date: string
  booking_time: string
  duration_minutes: number | null
  status: 'pending' | 'confirmed' | 'cancelled' | 'no_show'
  notes: string | null
}

type ScheduleDay = {
  day_of_week: number
  open_time: string
  close_time: string
  slot_duration?: number
  is_active: boolean
}

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
const ORDER = [1, 2, 3, 4, 5, 6, 0]   // Lunes → Domingo

const STATUS_BADGE: Record<Booking['status'], { label: string; cls: string }> = {
  pending:   { label: '⏳ Pendiente',  cls: 'bg-amber-50 text-amber-700' },
  confirmed: { label: '✅ Confirmada', cls: 'bg-green-50 text-green-700' },
  cancelled: { label: '❌ Cancelada',  cls: 'bg-stone-100 text-stone-500' },
  no_show:   { label: '👻 No asistió', cls: 'bg-red-50 text-red-600' },
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

export default function Bookings() {
  const [tab, setTab] = useState<'agenda' | 'horarios'>('agenda')
  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">Citas</h1>
          <p className="text-sm text-stone-500">Reservas que el bot agenda + tu horario de atención</p>
        </div>
        <div className="flex gap-1 bg-white border border-stone-200 rounded-lg p-1">
          {([['agenda', '📅 Agenda'], ['horarios', '🕐 Horarios']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setTab(v)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === v ? 'bg-green-600 text-white' : 'text-stone-600 hover:bg-stone-50'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {tab === 'agenda' ? <Agenda /> : <Schedule />}
    </div>
  )
}

// ── Agenda de reservas (confirmar / cancelar avisa al cliente por su canal) ──
function Agenda() {
  const qc = useQueryClient()
  const today = new Date()
  const [from, setFrom] = useState(iso(today))
  const [to, setTo] = useState(iso(new Date(today.getTime() + 30 * 86400000)))

  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ['bookings', from, to],
    queryFn: () => api<Booking[]>(`/api/client/bookings?from=${from}&to=${to}`),
    refetchInterval: 15_000,
  })

  const mStatus = useMutation({
    mutationFn: (v: { id: string; status: Booking['status'] }) =>
      api(`/api/client/bookings/${v.id}/status`, { method: 'PUT', body: JSON.stringify({ status: v.status }) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['bookings'] }),
  })

  const input = 'rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <label className="text-sm text-stone-600">Del</label>
        <input type="date" className={input} value={from} onChange={e => setFrom(e.target.value)} />
        <label className="text-sm text-stone-600">al</label>
        <input type="date" className={input} value={to} onChange={e => setTo(e.target.value)} />
      </div>

      {isLoading ? <p className="text-stone-500">Cargando agenda…</p> :
        bookings.length === 0 ? (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
            <div className="text-3xl mb-2">📅</div>
            <p className="text-stone-700 font-medium">Sin citas en este rango.</p>
            <p className="text-sm text-stone-500 mt-1">Cuando el bot agende una, aparece aquí para que la confirmes.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {bookings.map(b => (
              <div key={b.id} className="bg-white rounded-xl border border-stone-200 p-4 flex items-center gap-4 flex-wrap">
                <div className="text-center shrink-0 bg-stone-50 rounded-lg px-3 py-2">
                  <div className="text-xs text-stone-500">{b.booking_date}</div>
                  <div className="font-bold text-stone-900">{(b.booking_time || '').slice(0, 5)}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-stone-900 truncate">{b.contact_name || b.contact_phone}</div>
                  <div className="text-xs text-stone-500">
                    {b.service || 'Servicio no indicado'}{b.duration_minutes ? ` · ${b.duration_minutes} min` : ''} · {b.contact_phone}
                  </div>
                </div>
                <span className={`text-[11px] font-semibold rounded px-2 py-0.5 shrink-0 ${STATUS_BADGE[b.status].cls}`}>{STATUS_BADGE[b.status].label}</span>
                {b.status === 'pending' && (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => mStatus.mutate({ id: b.id, status: 'confirmed' })}
                      className="rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-1.5">✅ Confirmar</button>
                    <button onClick={() => { if (confirm('¿Cancelar la cita? Se le avisará al cliente.')) mStatus.mutate({ id: b.id, status: 'cancelled' }) }}
                      className="rounded-lg border border-red-200 text-red-600 text-xs font-semibold px-3 py-1.5 hover:bg-red-50">Cancelar</button>
                  </div>
                )}
                {b.status === 'confirmed' && (
                  <button onClick={() => mStatus.mutate({ id: b.id, status: 'no_show' })}
                    className="rounded-lg border border-stone-200 text-stone-500 text-xs px-3 py-1.5 hover:bg-stone-50 shrink-0">Marcar no asistió</button>
                )}
              </div>
            ))}
          </div>
        )}
      <p className="text-xs text-stone-400 mt-3">Confirmar o cancelar le avisa automáticamente al cliente por su canal (WhatsApp/Telegram).</p>
    </div>
  )
}

// ── Horario de atención (fuera de horario el bot responde con esta lista) ──
function Schedule() {
  const qc = useQueryClient()
  const { data: saved = [], isLoading } = useQuery({
    queryKey: ['schedule'],
    queryFn: () => api<ScheduleDay[]>('/api/client/schedule'),
  })
  const [draft, setDraft] = useState<ScheduleDay[] | null>(null)
  const [msg, setMsg] = useState('')

  // Editor con los 7 días (rellena los que falten con default inactivo)
  const days: ScheduleDay[] = draft ?? ORDER.map(d =>
    saved.find(s => s.day_of_week === d) ??
    { day_of_week: d, open_time: '09:00', close_time: '18:00', slot_duration: 60, is_active: false }
  )

  const update = (dow: number, patch: Partial<ScheduleDay>) =>
    setDraft(days.map(d => d.day_of_week === dow ? { ...d, ...patch } : d))

  const mSave = useMutation({
    mutationFn: () => api('/api/client/schedule', { method: 'PUT', body: JSON.stringify({ days }) }),
    onSuccess: () => { setMsg('✅ Horario guardado — el bot ya lo usa (incluido el aviso de fuera de horario)'); setDraft(null); qc.invalidateQueries({ queryKey: ['schedule'] }) },
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error al guardar'}`),
  })

  if (isLoading) return <p className="text-stone-500">Cargando horario…</p>

  const time = 'rounded border border-stone-300 px-2 py-1 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-40'

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-xl">
      {days.map(d => (
        <div key={d.day_of_week} className="flex items-center gap-3 py-2 border-b border-stone-50 last:border-0">
          <label className="flex items-center gap-2 w-32 shrink-0 text-sm font-medium text-stone-800 cursor-pointer">
            <input type="checkbox" checked={d.is_active} onChange={e => update(d.day_of_week, { is_active: e.target.checked })} />
            {DAY_NAMES[d.day_of_week]}
          </label>
          {d.is_active ? (
            <>
              <input type="time" className={time} value={(d.open_time || '').slice(0, 5)} onChange={e => update(d.day_of_week, { open_time: e.target.value })} />
              <span className="text-stone-400 text-sm">a</span>
              <input type="time" className={time} value={(d.close_time || '').slice(0, 5)} onChange={e => update(d.day_of_week, { close_time: e.target.value })} />
            </>
          ) : (
            <span className="text-sm text-stone-400">🚫 Cerrado</span>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between mt-4">
        <p className="text-xs text-stone-400 max-w-[280px]">Fuera de este horario, el bot informa los horarios UNA vez y guarda silencio hasta la reapertura.</p>
        <button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}
          className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
          {mSave.isPending ? 'Guardando…' : 'Guardar horario'}
        </button>
      </div>
      {msg && <p className="text-sm text-stone-600 mt-3">{msg}</p>}
    </div>
  )
}
