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
  const [msg, setMsg] = useState('')

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
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-stone-900">Horarios de atención</h1>
        <p className="text-sm text-stone-500">Fuera de este horario, el bot informa los horarios UNA vez y guarda silencio hasta la reapertura.</p>
      </div>
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
        <div className="flex justify-end mt-4">
          <button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}
            className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
            {mSave.isPending ? 'Guardando…' : 'Guardar horario'}
          </button>
        </div>
        {msg && <p className="text-sm text-stone-600 mt-3">{msg}</p>}
      </div>
    </div>
  )
}
