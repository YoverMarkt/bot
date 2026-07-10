import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'

// ── Horario de atención — para TODOS los negocios (igual que el panel
// viejo): fuera de horario el bot responde la lista UNA vez y calla.
type ScheduleDay = {
  day_of_week: number
  open_time: string
  close_time: string
  slot_duration?: number
  is_active: boolean
}

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
const ORDER = [1, 2, 3, 4, 5, 6, 0]   // Lunes → Domingo

export default function Schedule() {
  const qc = useQueryClient()
  const { data: saved = [], isLoading } = useQuery({
    queryKey: ['schedule'],
    queryFn: () => api<ScheduleDay[]>('/api/client/schedule'),
  })
  const [draft, setDraft] = useState<ScheduleDay[] | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [msg, setMsg] = useState('')

  const days: ScheduleDay[] = draft ?? ORDER.map(d =>
    saved.find(s => s.day_of_week === d) ??
    { day_of_week: d, open_time: '09:00', close_time: '18:00', slot_duration: 60, is_active: false }
  )

  const update = (dow: number, patch: Partial<ScheduleDay>) =>
    setDraft(days.map(d => d.day_of_week === dow ? { ...d, ...patch } : d))

  const dur = duration ?? saved.find(d => d.slot_duration)?.slot_duration ?? 60
  const mSave = useMutation({
    mutationFn: () => api('/api/client/schedule', { method: 'PUT', body: JSON.stringify({ days: days.map(d => ({ ...d, slot_duration: dur })) }) }),
    onSuccess: () => { setMsg('✅ Horario guardado — el bot ya lo usa (incluido el aviso de fuera de horario)'); setDraft(null); qc.invalidateQueries({ queryKey: ['schedule'] }) },
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error al guardar'}`),
  })

  if (isLoading) return <p className="text-muted-foreground">Cargando horario…</p>

  const time = 'rounded border border-input px-2 py-1 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-40'

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Horarios de atención</h1>
        <p className="text-sm text-muted-foreground">Tu horario. El bot avisará a quien escriba fuera de este horario. (En modo "Con citas", además se ofrecen turnos en estas horas.)</p>
      </div>
      <div className="bg-card rounded-xl border p-5 max-w-xl">
        {/* Duración de cada cita (select del viejo) */}
        <div className="mb-4">
          <label className="text-xs font-medium text-muted-foreground block mb-1">Duración de cada cita</label>
          <select value={dur} onChange={e => { setDuration(parseInt(e.target.value)); if (!draft) setDraft(days) }}
            className="rounded-lg border border-input px-3 py-2 text-sm max-w-56 focus:outline-none focus:ring-2 focus:ring-ring">
            <option value={30}>30 minutos</option>
            <option value={45}>45 minutos</option>
            <option value={60}>1 hora</option>
            <option value={90}>1 hora 30 min</option>
            <option value={120}>2 horas</option>
          </select>
        </div>
        {days.map(d => (
          <div key={d.day_of_week} className="flex items-center gap-3 py-2 border-b border-border/40 last:border-0">
            <label className="flex items-center gap-2 w-32 shrink-0 text-sm font-medium text-foreground cursor-pointer">
              <input type="checkbox" checked={d.is_active} onChange={e => update(d.day_of_week, { is_active: e.target.checked })} />
              {DAY_NAMES[d.day_of_week]}
            </label>
            {d.is_active ? (
              <>
                <input type="time" className={time} value={(d.open_time || '').slice(0, 5)} onChange={e => update(d.day_of_week, { open_time: e.target.value })} />
                <span className="text-muted-foreground/80 text-sm">a</span>
                <input type="time" className={time} value={(d.close_time || '').slice(0, 5)} onChange={e => update(d.day_of_week, { close_time: e.target.value })} />
              </>
            ) : (
              <span className="text-sm text-muted-foreground/80">🚫 Cerrado</span>
            )}
          </div>
        ))}
        <div className="flex justify-end mt-4">
          <button onClick={() => mSave.mutate()} disabled={(!draft && duration === null) || mSave.isPending}
            className="rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-semibold px-5 py-2 text-sm">
            {mSave.isPending ? 'Guardando…' : 'Guardar horario'}
          </button>
        </div>
        {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
      </div>
    </div>
  )
}
