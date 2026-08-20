import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { Ban } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { Label } from '@botpanel/ui/components/label'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// ── Horario de atención ───────────────────────────────────────────────────
// Decide DOS cosas, y por eso sobrevivió a la retirada de la agenda: si la
// tienda acepta pedidos y si el bot atiende o contesta que está cerrado. Fuera
// de horario el bot responde la lista UNA vez y calla.
//
// `slot_duration` sigue en la tabla —era la duración de cada cita— pero ya no
// se pinta ni se envía: reescribir esas filas no aporta nada.
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

  const days: ScheduleDay[] = draft ?? ORDER.map(d =>
    saved.find(s => s.day_of_week === d) ??
    // `slot_duration` viaja aunque el panel ya no lo pinte: la columna es
    // NOT NULL y un día construido aquí sin ella haría fallar el upsert.
    { day_of_week: d, open_time: '09:00', close_time: '18:00', slot_duration: 60, is_active: false }
  )

  const update = (dow: number, patch: Partial<ScheduleDay>) =>
    setDraft(days.map(d => d.day_of_week === dow ? { ...d, ...patch } : d))

  const mSave = useMutation({
    mutationFn: () => api('/api/client/schedule', { method: 'PUT', body: JSON.stringify({ days }) }),
    onSuccess: () => { toast.success('Horario guardado — el bot ya lo usa (incluido el aviso de fuera de horario)'); setDraft(null); qc.invalidateQueries({ queryKey: ['schedule'] }) },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error al guardar'),
  })

  if (isLoading) return (
    <div>
      <div className="mb-5 space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Card className="p-5 max-w-xl gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </Card>
    </div>
  )

  const time = 'w-24'

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Horarios de atención</h1>
        <p className="text-sm text-muted-foreground">Tu horario de atención. Fuera de estas horas la tienda no acepta pedidos y el bot lo avisa.</p>
      </div>
      <Card className="p-5 max-w-xl gap-0">
        {days.map(d => (
          <div key={d.day_of_week} className="flex items-center gap-3 py-2 border-b border-border/40 last:border-0">
            <Label htmlFor={`schedule-day-${d.day_of_week}-active`} className="mb-0 flex items-center gap-2 w-32 shrink-0 text-sm font-medium text-foreground cursor-pointer">
              <Checkbox id={`schedule-day-${d.day_of_week}-active`} checked={d.is_active} onCheckedChange={v => update(d.day_of_week, { is_active: v === true })} />
              {DAY_NAMES[d.day_of_week]}
            </Label>
            {d.is_active ? (
              <>
                <Input id={`schedule-day-${d.day_of_week}-open`} aria-label={`Hora de apertura del ${DAY_NAMES[d.day_of_week]}`} type="time" className={time} value={(d.open_time || '').slice(0, 5)} onChange={e => update(d.day_of_week, { open_time: e.target.value })} />
                <span className="text-muted-foreground/80 text-sm">a</span>
                <Input id={`schedule-day-${d.day_of_week}-close`} aria-label={`Hora de cierre del ${DAY_NAMES[d.day_of_week]}`} type="time" className={time} value={(d.close_time || '').slice(0, 5)} onChange={e => update(d.day_of_week, { close_time: e.target.value })} />
              </>
            ) : (
              <span className="text-sm text-muted-foreground/80 inline-flex items-center gap-1"><Ban className="w-3.5 h-3.5" /> Cerrado</span>
            )}
          </div>
        ))}
        <div className="flex justify-end mt-4">
          <Button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}>
            {mSave.isPending ? 'Guardando…' : 'Guardar horario'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
