import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { Ban } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Label } from '@botpanel/ui/components/label'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { isBookingBiz, useBusinessInfo } from '../../lib/biz'

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
  const { data: business } = useBusinessInfo()
  const bookingBiz = isBookingBiz(business?.type, business?.takes_bookings)
  const { data: saved = [], isLoading } = useQuery({
    queryKey: ['schedule'],
    queryFn: () => api<ScheduleDay[]>('/api/client/schedule'),
  })
  const [draft, setDraft] = useState<ScheduleDay[] | null>(null)
  const [duration, setDuration] = useState<number | null>(null)

  const days: ScheduleDay[] = draft ?? ORDER.map(d =>
    saved.find(s => s.day_of_week === d) ??
    { day_of_week: d, open_time: '09:00', close_time: '18:00', slot_duration: 60, is_active: false }
  )

  const update = (dow: number, patch: Partial<ScheduleDay>) =>
    setDraft(days.map(d => d.day_of_week === dow ? { ...d, ...patch } : d))

  const dur = duration ?? saved.find(d => d.slot_duration)?.slot_duration ?? 60
  const mSave = useMutation({
    mutationFn: () => api('/api/client/schedule', { method: 'PUT', body: JSON.stringify({ days: days.map(d => ({ ...d, slot_duration: dur })) }) }),
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
        <p className="text-sm text-muted-foreground">{bookingBiz
          ? 'Tu horario de atención y las horas en que el bot puede ofrecer reservas o citas.'
          : 'Tu horario de atención. El bot avisará a quien escriba fuera de estas horas.'}</p>
      </div>
      <Card className="p-5 max-w-xl gap-0">
        {/* Duración de cada cita (select del viejo) */}
        {bookingBiz && <div className="mb-4">
          <Label htmlFor="schedule-duration">Duración de cada cita</Label>
          <Select value={String(dur)} onValueChange={v => { setDuration(parseInt(v)); if (!draft) setDraft(days) }}>
            <SelectTrigger id="schedule-duration" className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 minutos</SelectItem>
              <SelectItem value="45">45 minutos</SelectItem>
              <SelectItem value="60">1 hora</SelectItem>
              <SelectItem value="90">1 hora 30 min</SelectItem>
              <SelectItem value="120">2 horas</SelectItem>
            </SelectContent>
          </Select>
        </div>}
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
          <Button onClick={() => mSave.mutate()} disabled={(!draft && duration === null) || mSave.isPending}>
            {mSave.isPending ? 'Guardando…' : 'Guardar horario'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
