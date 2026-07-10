import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { Check, X, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ── RESERVAS (solo negocios de citas) — port fiel del panel viejo:
// calendario MENSUAL con chips por día + detalle del día + vista lista.
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

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

const STATUS_BADGE: Record<Booking['status'], { label: string; cls: string }> = {
  pending:   { label: 'Pendiente',  cls: 'bg-amber-50 text-amber-700' },
  confirmed: { label: 'Confirmada', cls: 'bg-primary/10 text-primary' },
  cancelled: { label: 'Cancelada',  cls: 'bg-muted text-muted-foreground' },
  no_show:   { label: 'No asistió', cls: 'bg-red-50 text-destructive' },
}

export default function Bookings() {
  const [tab, setTab] = useState<'calendario' | 'lista'>('calendario')
  const qc = useQueryClient()

  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ['bookings-all'],
    queryFn: () => api<Booking[]>('/api/client/bookings'),
    refetchInterval: 15_000,
  })

  const mStatus = useMutation({
    mutationFn: (v: { id: string; status: Booking['status'] }) =>
      api(`/api/client/bookings/${v.id}/status`, { method: 'PUT', body: JSON.stringify({ status: v.status }) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['bookings-all'] })
      qc.invalidateQueries({ queryKey: ['bookings-watch'] })
    },
  })

  const pending = bookings.filter(b => b.status === 'pending').length

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reservas {pending > 0 && <span className="text-sm font-semibold bg-amber-100 text-amber-800 rounded-full px-2 py-0.5 align-middle">{pending} por confirmar</span>}</h1>
          <p className="text-sm text-muted-foreground">Citas que agenda el bot. Confirmar o cancelar avisa al cliente por su canal.</p>
        </div>
        <div className="flex gap-1 bg-card border rounded-lg p-1">
          {([['calendario', 'Calendario'], ['lista', 'Lista']] as const).map(([v, l]) => (
            <Button variant="ghost" key={v} onClick={() => setTab(v)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>
              {l}
            </Button>
          ))}
        </div>
      </div>
      {isLoading ? <p className="text-muted-foreground">Cargando reservas…</p> :
        tab === 'calendario'
          ? <Calendar bookings={bookings} onStatus={(id, status) => mStatus.mutate({ id, status })} />
          : <Lista bookings={bookings} onStatus={(id, status) => mStatus.mutate({ id, status })} />}
    </div>
  )
}

// ── Calendario mensual (igual que el viejo: chips por día + detalle) ──
function Calendar({ bookings, onStatus }: { bookings: Booking[]; onStatus: (id: string, s: Booking['status']) => void }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [selected, setSelected] = useState<string | null>(null)

  const prev = () => { if (month === 0) { setMonth(11); setYear(y => y - 1) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setMonth(0); setYear(y => y + 1) } else setMonth(m => m + 1) }

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const byDate: Record<string, Booking[]> = {}
  for (const b of bookings) (byDate[b.booking_date] ??= []).push(b)

  const dayBookings = selected ? (byDate[selected] ?? []) : []

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <Button variant="ghost" onClick={prev} className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm hover:bg-muted/50">←</Button>
        <span className="font-semibold text-foreground min-w-40 text-center">{MONTHS[month]} {year}</span>
        <Button variant="ghost" onClick={next} className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm hover:bg-muted/50">→</Button>
      </div>

      <div className="bg-card rounded-xl border p-3 overflow-x-auto">
        <div className="grid grid-cols-7 gap-1 min-w-[560px]">
          {['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map(d => (
            <div key={d} className="text-center text-[11px] uppercase tracking-wide text-muted-foreground/80 py-1">{d}</div>
          ))}
          {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
            const isToday = now.getFullYear() === year && now.getMonth() === month && now.getDate() === d
            const dayBk = (byDate[dateStr] ?? []).filter(b => b.status !== 'cancelled')
            const allConfirmed = dayBk.length > 0 && dayBk.every(b => b.status === 'confirmed')
            const firstB = dayBk.slice().sort((a, b) => (a.booking_time || '').localeCompare(b.booking_time || ''))[0]
            return (
              <button key={d} onClick={() => setSelected(dateStr)}
                className={`text-left rounded-lg border p-1.5 min-h-16 align-top transition-colors ${
                  selected === dateStr ? 'border-green-500 ring-1 ring-green-500' :
                  isToday ? 'border-green-300 bg-primary/10/50' : 'border-border/60 hover:border-stone-300'}`}>
                <div className={`text-xs font-semibold ${isToday ? 'text-primary' : 'text-muted-foreground'}`}>{d}</div>
                {dayBk.length > 0 && (
                  <div className={`mt-1 text-[10px] font-semibold rounded px-1 py-0.5 truncate ${allConfirmed ? 'bg-green-100 text-primary' : 'bg-amber-100 text-amber-800'}`}>
                    {dayBk.length} cita{dayBk.length > 1 ? 's' : ''}
                  </div>
                )}
                {firstB && (
                  <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {(firstB.booking_time || '').slice(0, 5)} {(firstB.contact_name || '').split(' ')[0]}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Detalle del día seleccionado */}
      {selected && dayBookings.length > 0 && (
        <div className="bg-card rounded-xl border p-4 mt-4">
          <h3 className="font-semibold text-foreground mb-3">
            {selected.split('-').reverse().join('/')} — {dayBookings.length} cita(s)
          </h3>
          <div className="space-y-2">
            {dayBookings.map(b => <BookingCard key={b.id} b={b} onStatus={onStatus} />)}
          </div>
        </div>
      )}
      {selected && dayBookings.length === 0 && (
        <p className="text-sm text-muted-foreground mt-3">Sin citas el {selected.split('-').reverse().join('/')}.</p>
      )}
    </div>
  )
}

// ── Vista de lista (rango de fechas, como la Agenda anterior) ──
function Lista({ bookings, onStatus }: { bookings: Booking[]; onStatus: (id: string, s: Booking['status']) => void }) {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const today = new Date()
  const [from, setFrom] = useState(iso(today))
  const [to, setTo] = useState(iso(new Date(today.getTime() + 30 * 86400000)))
  const input = 'rounded-lg border border-input px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

  const filtered = bookings
    .filter(b => b.booking_date >= from && b.booking_date <= to)
    .sort((a, b) => (a.booking_date + a.booking_time).localeCompare(b.booking_date + b.booking_time))

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <label className="text-sm text-muted-foreground">Del</label>
        <Input type="date" className={input} value={from} onChange={e => setFrom(e.target.value)} />
        <label className="text-sm text-muted-foreground">al</label>
        <Input type="date" className={input} value={to} onChange={e => setTo(e.target.value)} />
      </div>
      {filtered.length === 0 ? (
        <div className="bg-card rounded-xl border p-8 text-center">
          <div className="text-3xl mb-2">📅</div>
          <p className="text-foreground/90 font-medium">Sin citas en este rango.</p>
          <p className="text-sm text-muted-foreground mt-1">Cuando el bot agende una, aparece aquí para que la confirmes.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(b => <BookingCard key={b.id} b={b} onStatus={onStatus} withDate />)}
        </div>
      )}
    </div>
  )
}

function BookingCard({ b, onStatus, withDate }: { b: Booking; onStatus: (id: string, s: Booking['status']) => void; withDate?: boolean }) {
  return (
    <div className="bg-card rounded-xl border p-4 flex items-center gap-4 flex-wrap">
      <div className="text-center shrink-0 bg-muted/50 rounded-lg px-3 py-2">
        {withDate && <div className="text-xs text-muted-foreground">{b.booking_date}</div>}
        <div className="font-bold text-foreground"><Clock className="w-3.5 h-3.5 inline mr-1" />{(b.booking_time || '').slice(0, 5)}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-foreground truncate">{b.contact_name || b.contact_phone}</div>
        <div className="text-xs text-muted-foreground">
          {b.service || 'Servicio no indicado'}{b.duration_minutes ? ` · ${b.duration_minutes} min` : ''} · {b.contact_phone}
        </div>
      </div>
      <span className={`text-[11px] font-semibold rounded px-2 py-0.5 shrink-0 ${STATUS_BADGE[b.status].cls}`}>{STATUS_BADGE[b.status].label}</span>
      {b.status === 'pending' && (
        <div className="flex gap-2 shrink-0">
          <Button variant="ghost" onClick={() => onStatus(b.id, 'confirmed')}
            className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold px-3 py-1.5"><span className="inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Confirmar</span></Button>
          <Button variant="ghost" onClick={() => { if (confirm('¿Cancelar la cita? Se le avisará al cliente.')) onStatus(b.id, 'cancelled') }}
            className="rounded-lg border border-destructive/30 text-destructive text-xs font-semibold px-3 py-1.5 hover:bg-destructive/10"><span className="inline-flex items-center gap-1"><X className="w-3.5 h-3.5" /> Cancelar</span></Button>
        </div>
      )}
      {b.status === 'confirmed' && (
        <div className="flex gap-2 shrink-0">
          <Button variant="ghost" onClick={() => onStatus(b.id, 'no_show')}
            className="rounded-lg border border-border text-muted-foreground text-xs px-3 py-1.5 hover:bg-muted/50">Marcar no asistió</Button>
          <Button variant="ghost" onClick={() => { if (confirm('¿Cancelar la cita? Se le avisará al cliente.')) onStatus(b.id, 'cancelled') }}
            className="rounded-lg border border-destructive/30 text-destructive text-xs px-3 py-1.5 hover:bg-destructive/10"><span className="inline-flex items-center gap-1"><X className="w-3.5 h-3.5" /> Cancelar</span></Button>
        </div>
      )}
    </div>
  )
}
