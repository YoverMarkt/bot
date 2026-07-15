import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BedDouble,
  CalendarRange,
  Check,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  MessageSquare,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@botpanel/ui/components/alert'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@botpanel/ui/components/tabs'
import { Textarea } from '@botpanel/ui/components/textarea'
import { useNavigate } from 'react-router-dom'
import { session } from '../../api/client'
import * as lodging from './api'
import type {
  LodgingBlock,
  LodgingPricingModel,
  LodgingRateOverride,
  LodgingRequest,
  LodgingRequestStatus,
  LodgingRoomType,
  LodgingRoomTypePayload,
  LodgingSettings,
} from './api'
import { fmtMB, MEDIA_LIMITS, uploadMedia } from '../catalog/api'

const DEFAULT_SETTINGS: LodgingSettings = {
  currency: 'USD',
  check_in_time: '15:00',
  check_out_time: '11:00',
  quote_expiry_minutes: 15,
  hold_minutes: 45,
  tax_rate: 0,
  service_fee: 0,
  prices_include_tax: true,
}

const CURRENCIES = [
  ['USD', 'dólar estadounidense'],
  ['EUR', 'euro'],
  ['COP', 'peso colombiano'],
  ['PEN', 'sol peruano'],
  ['MXN', 'peso mexicano'],
  ['BRL', 'real brasileño'],
  ['CLP', 'peso chileno'],
  ['ARS', 'peso argentino'],
] as const

const EMPTY_ROOM: LodgingRoomTypePayload = {
  name: '',
  description: '',
  amenities: [],
  media_urls: [],
  total_units: 1,
  max_guests: 2,
  pricing_model: 'per_unit',
  base_occupancy: 2,
  base_rate: 0,
  weekend_rate: null,
  extra_adult_rate: 0,
  child_rate: 0,
  active: true,
}

const PRICING_LABELS: Record<LodgingPricingModel, string> = {
  per_unit: 'Por habitación / noche',
  per_person: 'Por persona / noche',
  base_plus_extra: 'Base + huéspedes extra',
  manual: 'Cotización manual',
}

const PRICING_HELP: Record<LodgingPricingModel, string> = {
  per_unit: 'La tarifa se multiplica por la cantidad de habitaciones y noches.',
  per_person: 'Configura una tarifa por adulto y otra por niño; ambas se multiplican por las noches.',
  base_plus_extra: 'Cada habitación incluye una cantidad de adultos; los adultos adicionales y todos los niños usan sus tarifas configuradas.',
  manual: 'El bot recopila fechas y personas, muestra la habitación y deriva al equipo sin inventar un total.',
}

const REQUEST_BADGES: Record<LodgingRequestStatus, { label: string; className: string }> = {
  pending_owner: { label: 'Por confirmar', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  confirmed: { label: 'Confirmada', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  rejected: { label: 'Rechazada', className: 'bg-destructive/10 text-destructive' },
  cancelled: { label: 'Cancelada', className: 'bg-muted text-muted-foreground' },
  expired: { label: 'Expirada', className: 'bg-muted text-muted-foreground' },
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value: number | string | null | undefined, currency = 'USD'): string {
  if (value == null) return 'Cotización manual'
  try {
    return new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(numeric(value))
  } catch {
    return `${numeric(value).toFixed(2)} ${currency}`
  }
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'No se pudo completar la operación'
}

export default function Lodging() {
  const roomsQuery = useQuery({ queryKey: ['lodging-room-types'], queryFn: lodging.getRoomTypes })
  const [tab, setTab] = useState('requests')
  const needsConfiguration = roomsQuery.isSuccess && roomsQuery.data.length === 0

  useEffect(() => {
    if (needsConfiguration) setTab('rooms')
  }, [needsConfiguration])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground"><BedDouble className="h-6 w-6" /> Hospedaje</h1>
        <p className="text-sm text-muted-foreground">Habitaciones, tarifas, cupos y solicitudes de estadía.</p>
      </div>

      <Alert className="border-primary/30 bg-primary/5">
        <ShieldCheck />
        <AlertTitle>El bot cotiza; el equipo confirma</AlertTitle>
        <AlertDescription>
          Consultar precios no reserva. Cuando el huésped elige una opción, el sistema retiene el cupo temporalmente y calcula el total oficial; el dueño o un empleado autorizado decide si confirma o rechaza.
        </AlertDescription>
      </Alert>

      {needsConfiguration && (
        <Alert>
          <BedDouble />
          <AlertTitle>Completa la configuración inicial</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Agrega al menos un tipo de habitación con capacidad, cupos y tarifa. Hasta entonces el bot no ofrecerá disponibilidad ni inventará precios.</span>
            <Button size="sm" onClick={() => setTab('rooms')}>Configurar habitaciones</Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="requests">Solicitudes</TabsTrigger>
          <TabsTrigger value="rooms">Habitaciones</TabsTrigger>
          <TabsTrigger value="availability">Disponibilidad</TabsTrigger>
          <TabsTrigger value="settings">Configuración</TabsTrigger>
        </TabsList>
        <TabsContent value="requests" className="mt-4"><RequestsPanel /></TabsContent>
        <TabsContent value="rooms" className="mt-4"><RoomsPanel /></TabsContent>
        <TabsContent value="availability" className="mt-4"><AvailabilityPanel /></TabsContent>
        <TabsContent value="settings" className="mt-4"><SettingsPanel /></TabsContent>
      </Tabs>
    </div>
  )
}

function SettingsPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['lodging-settings'], queryFn: lodging.getLodgingSettings })
  const [draft, setDraft] = useState<LodgingSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    if (query.data) setDraft({ ...DEFAULT_SETTINGS, ...query.data })
  }, [query.data])

  const save = useMutation({
    mutationFn: () => lodging.saveLodgingSettings(draft),
    onSuccess: data => {
      queryClient.setQueryData(['lodging-settings'], data)
      toast.success('Configuración de hospedaje guardada')
    },
    onError: error => toast.error(errorText(error)),
  })

  if (query.isLoading) return <PanelSkeleton />
  if (query.isError) return <QueryError onRetry={() => { void query.refetch() }} />

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Reglas generales</CardTitle>
        <CardDescription>Estos valores se aplican a todas las cotizaciones. Las tarifas de cada habitación se configuran por separado.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Moneda" htmlFor="lodging-currency">
            <Select value={draft.currency} onValueChange={currency => setDraft({ ...draft, currency })}>
              <SelectTrigger id="lodging-currency" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map(([value, label]) => <SelectItem key={value} value={value}>{value} — {label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Hora de entrada" htmlFor="lodging-check-in"><Input id="lodging-check-in" type="time" value={draft.check_in_time} onChange={event => setDraft({ ...draft, check_in_time: event.target.value })} /></Field>
          <Field label="Hora de salida" htmlFor="lodging-check-out"><Input id="lodging-check-out" type="time" value={draft.check_out_time} onChange={event => setDraft({ ...draft, check_out_time: event.target.value })} /></Field>
          <Field label="Cotización vigente (minutos)" htmlFor="lodging-quote-expiry"><Input id="lodging-quote-expiry" type="number" min={1} max={1440} value={draft.quote_expiry_minutes} onChange={event => setDraft({ ...draft, quote_expiry_minutes: numeric(event.target.value) })} /></Field>
          <Field label="Retener por (minutos)" htmlFor="lodging-hold"><Input id="lodging-hold" type="number" min={5} max={1440} value={draft.hold_minutes} onChange={event => setDraft({ ...draft, hold_minutes: numeric(event.target.value) })} /></Field>
          <Field label="Impuesto (%)" htmlFor="lodging-tax"><Input id="lodging-tax" type="number" min={0} max={100} step="0.01" value={draft.tax_rate * 100} onChange={event => setDraft({ ...draft, tax_rate: numeric(event.target.value) / 100 })} /></Field>
          <Field label="Tasa fija por estadía" htmlFor="lodging-fee"><Input id="lodging-fee" type="number" min={0} step="0.01" value={draft.service_fee} onChange={event => setDraft({ ...draft, service_fee: numeric(event.target.value) })} /></Field>
        </div>
        <Label htmlFor="lodging-tax-included" className="mb-0 flex cursor-pointer items-center gap-2">
          <Checkbox id="lodging-tax-included" checked={draft.prices_include_tax} onCheckedChange={checked => setDraft({ ...draft, prices_include_tax: checked === true })} />
          Las tarifas publicadas ya incluyen impuestos
        </Label>
        <div className="flex justify-end"><Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar reglas'}</Button></div>
      </CardContent>
    </Card>
  )
}

function RoomsPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['lodging-room-types'], queryFn: lodging.getRoomTypes })
  const settingsQuery = useQuery({ queryKey: ['lodging-settings'], queryFn: lodging.getLodgingSettings })
  const [editing, setEditing] = useState<LodgingRoomType | 'new' | null>(null)

  const remove = useMutation({
    mutationFn: lodging.deleteRoomType,
    onSuccess: () => {
      toast.success('Tipo de habitación archivado')
      void queryClient.invalidateQueries({ queryKey: ['lodging-room-types'] })
    },
    onError: error => toast.error(errorText(error)),
  })

  if (query.isLoading || settingsQuery.isLoading) return <PanelSkeleton />
  if (query.isError || settingsQuery.isError) return <QueryError onRetry={() => { void query.refetch(); void settingsQuery.refetch() }} />
  const rooms = query.data ?? []
  const currency = settingsQuery.data?.currency || 'USD'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-semibold">Tipos de habitación</h2><p className="text-sm text-muted-foreground">Cada tipo tiene su propio cupo, capacidad y forma de cobrar.</p></div>
        <Button onClick={() => setEditing('new')}><Plus /> Agregar tipo</Button>
      </div>
      {rooms.length === 0 ? (
        <EmptyState icon={BedDouble} title="Todavía no hay habitaciones" description="Agrega el primer tipo para que el bot pueda consultar cupos y precios." action={<Button onClick={() => setEditing('new')}><Plus /> Agregar habitación</Button>} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {rooms.map(room => (
            <Card key={room.id} className={!room.active ? 'opacity-65' : ''}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex flex-wrap items-center gap-2">{room.name}<Badge variant="secondary">{room.total_units} unidad{room.total_units === 1 ? '' : 'es'}</Badge>{!room.active && <Badge variant="outline">Oculta</Badge>}</CardTitle>
                  <CardDescription>{room.description || 'Sin descripción'}</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="icon" aria-label={`Editar ${room.name}`} onClick={() => setEditing(room)}><Pencil /></Button>
                  <ConfirmAction
                    trigger={<Button variant="outline" size="icon" aria-label={`Eliminar ${room.name}`}><Trash2 /></Button>}
                    title={`Archivar ${room.name}`}
                    description="Dejará de mostrarse y cotizarse, pero las solicitudes y bloqueos anteriores se conservan para auditoría. Puedes reactivarla desde Editar."
                    confirmLabel="Archivar tipo"
                    onConfirm={() => remove.mutate(room.id)}
                  />
                </div>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                <Info label="Capacidad" value={`Hasta ${room.max_guests} huésped${room.max_guests === 1 ? '' : 'es'}`} />
                <Info label="Precio" value={room.pricing_model === 'manual' ? 'Cotización manual' : `${money(room.base_rate, currency)} · ${PRICING_LABELS[room.pricing_model]}`} />
                {room.amenities.length > 0 && <div className="sm:col-span-2"><p className="text-xs text-muted-foreground">Servicios</p><div className="mt-1 flex flex-wrap gap-1">{room.amenities.map(item => <Badge variant="outline" key={item}>{item}</Badge>)}</div></div>}
                {room.media_urls.length > 0 && <Info label="Multimedia" value={`${room.media_urls.length} enlace${room.media_urls.length === 1 ? '' : 's'} para el bot`} />}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing && <RoomDialog room={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RoomDialog({ room, onClose }: { room: LodgingRoomType | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<LodgingRoomTypePayload>(() => room ? {
    name: room.name,
    description: room.description ?? '',
    amenities: room.amenities ?? [],
    media_urls: room.media_urls ?? [],
    total_units: room.total_units,
    max_guests: room.max_guests,
    pricing_model: room.pricing_model,
    base_occupancy: room.base_occupancy,
    base_rate: room.base_rate,
    weekend_rate: room.weekend_rate,
    extra_adult_rate: room.extra_adult_rate,
    child_rate: room.child_rate,
    active: room.active,
  } : { ...EMPTY_ROOM })
  const [amenities, setAmenities] = useState(form.amenities.join(', '))
  const [media, setMedia] = useState(form.media_urls.join('\n'))
  const [uploading, setUploading] = useState(false)

  const handleMediaUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const isVideo = file.type.startsWith('video/')
    const limit = isVideo ? MEDIA_LIMITS.video : MEDIA_LIMITS.image
    if ((!file.type.startsWith('image/') && !isVideo) || file.size > limit) {
      toast.error(file.size > limit
        ? `El archivo pesa ${fmtMB(file.size)} y supera el límite de ${fmtMB(limit)}.`
        : 'Selecciona una imagen o un video.')
      event.target.value = ''
      return
    }
    setUploading(true)
    try {
      const uploaded = await uploadMedia(file)
      setMedia(current => [current.trim(), uploaded.url].filter(Boolean).join('\n'))
      toast.success('Archivo subido y agregado a la habitación')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        ...(form.pricing_model === 'manual' ? {
          base_rate: null,
          weekend_rate: null,
          extra_adult_rate: null,
          child_rate: null,
        } : {}),
        amenities: splitList(amenities),
        media_urls: splitList(media),
      }
      return room ? lodging.updateRoomType(room.id, payload) : lodging.createRoomType(payload)
    },
    onSuccess: () => {
      toast.success(room ? 'Habitación actualizada' : 'Habitación agregada')
      void queryClient.invalidateQueries({ queryKey: ['lodging-room-types'] })
      onClose()
    },
    onError: error => toast.error(errorText(error)),
  })

  const setNumber = (key: 'total_units' | 'max_guests' | 'base_occupancy' | 'base_rate' | 'weekend_rate' | 'extra_adult_rate' | 'child_rate') =>
    (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value === '' ? null : numeric(event.target.value) })
  const canSave = form.name.trim().length > 0
    && numeric(form.total_units) >= 1
    && numeric(form.max_guests) >= 1
    && numeric(form.base_occupancy) >= 1
    && numeric(form.base_occupancy) <= numeric(form.max_guests)
    && (form.pricing_model === 'manual' || numeric(form.base_rate) > 0)
    && (form.weekend_rate == null || numeric(form.weekend_rate) > 0)
    && numeric(form.extra_adult_rate) >= 0
    && numeric(form.child_rate) >= 0

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{room ? 'Editar habitación' : 'Agregar tipo de habitación'}</DialogTitle><DialogDescription>Configura cómo se muestra, cuántas unidades existen y cómo se calcula cada noche.</DialogDescription></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); if (canSave && !save.isPending && !uploading) save.mutate() }}>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <Field label="Nombre *" htmlFor="room-name"><Input id="room-name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Ej: Cabaña familiar" /></Field>
          <Field label="Forma de cobrar" htmlFor="room-pricing">
            <Select value={form.pricing_model} onValueChange={value => setForm({ ...form, pricing_model: value as LodgingPricingModel })}>
              <SelectTrigger id="room-pricing" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(PRICING_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">{PRICING_HELP[form.pricing_model]}</p>
          </Field>
          <Field label="Cantidad total" htmlFor="room-units"><Input id="room-units" type="number" min={1} value={form.total_units} onChange={setNumber('total_units')} /></Field>
          <Field label="Máximo de huéspedes por unidad" htmlFor="room-guests"><Input id="room-guests" type="number" min={1} value={form.max_guests} onChange={setNumber('max_guests')} /></Field>
          {form.pricing_model !== 'manual' && <>
            <Field label={form.pricing_model === 'per_person' ? 'Tarifa por adulto / noche' : 'Tarifa base / noche'} htmlFor="room-rate"><Input id="room-rate" type="number" min="0.01" step="0.01" value={form.base_rate ?? ''} onChange={setNumber('base_rate')} /></Field>
            <Field label="Tarifa de fin de semana (opcional)" htmlFor="room-weekend"><Input id="room-weekend" type="number" min="0.01" step="0.01" value={form.weekend_rate ?? ''} onChange={setNumber('weekend_rate')} placeholder="Usa la tarifa base si queda vacío" /></Field>
          </>}
          {form.pricing_model === 'per_person' && <Field label="Tarifa por niño / noche" htmlFor="room-child-per-person"><Input id="room-child-per-person" type="number" min={0} step="0.01" value={form.child_rate ?? ''} onChange={setNumber('child_rate')} /></Field>}
          {form.pricing_model === 'base_plus_extra' && <>
            <Field label="Adultos incluidos por unidad" htmlFor="room-occupancy"><Input id="room-occupancy" type="number" min={1} max={form.max_guests} value={form.base_occupancy} onChange={setNumber('base_occupancy')} /></Field>
            <Field label="Adulto extra / noche" htmlFor="room-extra-adult"><Input id="room-extra-adult" type="number" min={0} step="0.01" value={form.extra_adult_rate ?? ''} onChange={setNumber('extra_adult_rate')} /></Field>
            <Field label="Niño / noche" htmlFor="room-child"><Input id="room-child" type="number" min={0} step="0.01" value={form.child_rate ?? ''} onChange={setNumber('child_rate')} /></Field>
          </>}
          <div className="sm:col-span-2"><Field label="Descripción" htmlFor="room-description"><Textarea id="room-description" rows={3} value={form.description ?? ''} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="Vista, tamaño, tipo de camas y cualquier condición importante" /></Field></div>
          <div className="sm:col-span-2"><Field label="Servicios incluidos (separados por coma)" htmlFor="room-amenities"><Input id="room-amenities" value={amenities} onChange={event => setAmenities(event.target.value)} placeholder="Wi-Fi, desayuno, baño privado, piscina" /></Field></div>
          <div className="space-y-3 sm:col-span-2">
            <Field label="Subir una foto o video" htmlFor="room-media-file"><Input id="room-media-file" type="file" accept="image/*,video/*" disabled={uploading} onChange={handleMediaUpload} /></Field>
            {uploading && <p className="text-xs text-muted-foreground">Subiendo a Cloudinary…</p>}
            <Field label="Archivos de la habitación (una URL por línea)" htmlFor="room-media"><Textarea id="room-media" rows={3} value={media} onChange={event => setMedia(event.target.value)} placeholder={'https://…/foto.jpg\nhttps://…/video.mp4'} /></Field>
            <p className="text-xs text-muted-foreground">Puedes subir varios archivos uno por uno o pegar URLs HTTPS. El bot enviará hasta tres al presentar la cotización.</p>
          </div>
          <Label htmlFor="room-active" className="mb-0 flex cursor-pointer items-center gap-2"><Checkbox id="room-active" checked={form.active} onCheckedChange={checked => setForm({ ...form, active: checked === true })} /> Mostrar y cotizar este tipo</Label>
          {!canSave && <p className="text-sm text-destructive sm:col-span-2" role="alert">Completa el nombre, usa cupos y capacidades válidos y configura una tarifa base mayor que cero, salvo en cotización manual.</p>}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={!canSave || save.isPending || uploading}>{save.isPending ? 'Guardando…' : 'Guardar habitación'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AvailabilityPanel() {
  const queryClient = useQueryClient()
  const roomsQuery = useQuery({ queryKey: ['lodging-room-types'], queryFn: lodging.getRoomTypes })
  const settingsQuery = useQuery({ queryKey: ['lodging-settings'], queryFn: lodging.getLodgingSettings })
  const blocksQuery = useQuery({ queryKey: ['lodging-blocks'], queryFn: lodging.getLodgingBlocks })
  const ratesQuery = useQuery({ queryKey: ['lodging-rates'], queryFn: lodging.getRateOverrides })
  const [search, setSearch] = useState({ check_in: '', check_out: '', rooms: 1, adults: 2, children: 0 })
  const [block, setBlock] = useState({ room_type_id: '', check_in: '', check_out: '', units: 1, kind: 'external' as LodgingBlock['kind'], notes: '' })
  const [rate, setRate] = useState({ room_type_id: '', rate_date: '', base_rate: '', extra_adult_rate: '', child_rate: '', closed: false })

  const availability = useMutation({ mutationFn: lodging.checkAvailability, onError: error => toast.error(errorText(error)) })
  const clearAvailability = () => availability.reset()
  const addBlock = useMutation({
    mutationFn: () => lodging.createLodgingBlock({ ...block, notes: block.notes || null }),
    onSuccess: () => { toast.success('Bloqueo agregado'); clearAvailability(); setBlock({ room_type_id: '', check_in: '', check_out: '', units: 1, kind: 'external', notes: '' }); void queryClient.invalidateQueries({ queryKey: ['lodging-blocks'] }) },
    onError: error => toast.error(errorText(error)),
  })
  const removeBlock = useMutation({ mutationFn: lodging.deleteLodgingBlock, onSuccess: () => { clearAvailability(); void queryClient.invalidateQueries({ queryKey: ['lodging-blocks'] }) }, onError: error => toast.error(errorText(error)) })
  const addRate = useMutation({
    mutationFn: () => lodging.saveRateOverride({ room_type_id: rate.room_type_id, rate_date: rate.rate_date, base_rate: rate.base_rate === '' ? null : numeric(rate.base_rate), extra_adult_rate: rate.extra_adult_rate === '' ? null : numeric(rate.extra_adult_rate), child_rate: rate.child_rate === '' ? null : numeric(rate.child_rate), closed: rate.closed }),
    onSuccess: () => { toast.success('Tarifa especial guardada'); clearAvailability(); setRate({ room_type_id: '', rate_date: '', base_rate: '', extra_adult_rate: '', child_rate: '', closed: false }); void queryClient.invalidateQueries({ queryKey: ['lodging-rates'] }) },
    onError: error => toast.error(errorText(error)),
  })
  const removeRate = useMutation({ mutationFn: lodging.deleteRateOverride, onSuccess: () => { clearAvailability(); void queryClient.invalidateQueries({ queryKey: ['lodging-rates'] }) }, onError: error => toast.error(errorText(error)) })

  if (roomsQuery.isLoading || settingsQuery.isLoading || blocksQuery.isLoading || ratesQuery.isLoading) return <PanelSkeleton />
  if (roomsQuery.isError || settingsQuery.isError || blocksQuery.isError || ratesQuery.isError) return <QueryError onRetry={() => { void roomsQuery.refetch(); void settingsQuery.refetch(); void blocksQuery.refetch(); void ratesQuery.refetch() }} />
  const rooms = (roomsQuery.data ?? []).filter(room => room.active)
  const currency = settingsQuery.data?.currency || 'USD'
  const validAvailability = Boolean(search.check_in && search.check_out && search.check_out > search.check_in && search.rooms >= 1 && search.adults >= 1 && search.children >= 0)
  const validBlock = Boolean(block.room_type_id && block.check_in && block.check_out && block.check_out > block.check_in && block.units >= 1)
  const validRate = Boolean(rate.room_type_id && rate.rate_date && (rate.closed || numeric(rate.base_rate) > 0))

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Search className="h-5 w-5" /> Probar una cotización</CardTitle><CardDescription>Usa el mismo cálculo oficial de cupos y dinero que el bot, sin crear ni retener una solicitud.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Entrada" htmlFor="availability-in"><Input id="availability-in" type="date" value={search.check_in} onChange={event => { clearAvailability(); setSearch({ ...search, check_in: event.target.value }) }} /></Field>
            <Field label="Salida" htmlFor="availability-out"><Input id="availability-out" type="date" value={search.check_out} onChange={event => { clearAvailability(); setSearch({ ...search, check_out: event.target.value }) }} /></Field>
            <Field label="Habitaciones" htmlFor="availability-rooms"><Input id="availability-rooms" type="number" min={1} value={search.rooms} onChange={event => { clearAvailability(); setSearch({ ...search, rooms: numeric(event.target.value) }) }} /></Field>
            <Field label="Adultos" htmlFor="availability-adults"><Input id="availability-adults" type="number" min={1} value={search.adults} onChange={event => { clearAvailability(); setSearch({ ...search, adults: numeric(event.target.value) }) }} /></Field>
            <Field label="Niños" htmlFor="availability-children"><Input id="availability-children" type="number" min={0} value={search.children} onChange={event => { clearAvailability(); setSearch({ ...search, children: numeric(event.target.value) }) }} /></Field>
          </div>
          <Button onClick={() => availability.mutate(search)} disabled={!validAvailability || availability.isPending}>{availability.isPending ? 'Consultando…' : 'Consultar disponibilidad'}</Button>
          {search.check_in && search.check_out && search.check_out <= search.check_in && <p className="text-sm text-destructive" role="alert">La salida debe ser posterior a la entrada.</p>}
          {availability.data && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {availability.data.options.length === 0 && <p className="text-sm text-muted-foreground">No hay opciones para esas fechas y cantidad de huéspedes.</p>}
              {availability.data.options.map(option => <Card key={option.roomTypeId} className="gap-2 p-4"><p className="font-semibold">{option.roomTypeName}</p><p className="text-sm text-muted-foreground">{option.availableUnits} disponibles · necesita {option.unitsRequired} · {availability.data.nights} noche(s)</p><p className="text-lg font-bold">{money(option.total, option.currency)}</p><p className="text-xs text-muted-foreground">Esta consulta no retiene el cupo.</p></Card>)}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Bloqueos manuales o externos</CardTitle><CardDescription>Registra Booking, Airbnb, mantenimiento o cierres cargados fuera del bot para no sobre-vender.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <RoomSelect id="block-room" rooms={rooms} value={block.room_type_id} onChange={room_type_id => setBlock({ ...block, room_type_id })} />
              <Field label="Origen" htmlFor="block-kind"><Select value={block.kind} onValueChange={kind => setBlock({ ...block, kind: kind as LodgingBlock['kind'] })}><SelectTrigger id="block-kind" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="external">Reserva externa</SelectItem><SelectItem value="maintenance">Mantenimiento</SelectItem><SelectItem value="manual">Bloqueo del equipo</SelectItem></SelectContent></Select></Field>
              <Field label="Desde" htmlFor="block-in"><Input id="block-in" type="date" value={block.check_in} onChange={event => setBlock({ ...block, check_in: event.target.value })} /></Field>
              <Field label="Hasta (salida)" htmlFor="block-out"><Input id="block-out" type="date" value={block.check_out} onChange={event => setBlock({ ...block, check_out: event.target.value })} /></Field>
              <Field label="Unidades" htmlFor="block-units"><Input id="block-units" type="number" min={1} value={block.units} onChange={event => setBlock({ ...block, units: numeric(event.target.value) })} /></Field>
              <Field label="Nota" htmlFor="block-notes"><Input id="block-notes" value={block.notes} onChange={event => setBlock({ ...block, notes: event.target.value })} placeholder="Ej: Booking #123" /></Field>
            </div>
            <Button variant="outline" onClick={() => addBlock.mutate()} disabled={!validBlock || addBlock.isPending}><Plus /> Agregar bloqueo</Button>
            {block.check_in && block.check_out && block.check_out <= block.check_in && <p className="text-sm text-destructive" role="alert">La fecha de salida del bloqueo debe ser posterior a la entrada.</p>}
            <BlockList blocks={blocksQuery.data ?? []} removing={removeBlock.isPending} onRemove={id => removeBlock.mutate(id)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Tarifas por fecha</CardTitle><CardDescription>Sobrescribe una noche concreta para feriados, temporada alta o cierre de ventas.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <RoomSelect id="rate-room" rooms={rooms} value={rate.room_type_id} onChange={room_type_id => setRate({ ...rate, room_type_id })} />
              <Field label="Fecha" htmlFor="rate-date"><Input id="rate-date" type="date" value={rate.rate_date} onChange={event => setRate({ ...rate, rate_date: event.target.value })} /></Field>
              <Field label="Tarifa base" htmlFor="rate-base"><Input id="rate-base" type="number" min={0} step="0.01" value={rate.base_rate} onChange={event => setRate({ ...rate, base_rate: event.target.value })} placeholder="Obligatoria salvo que cierres la noche" /></Field>
              <Field label="Adulto extra" htmlFor="rate-extra"><Input id="rate-extra" type="number" min={0} step="0.01" value={rate.extra_adult_rate} onChange={event => setRate({ ...rate, extra_adult_rate: event.target.value })} /></Field>
              <Field label="Niño" htmlFor="rate-child"><Input id="rate-child" type="number" min={0} step="0.01" value={rate.child_rate} onChange={event => setRate({ ...rate, child_rate: event.target.value })} /></Field>
              <Label htmlFor="rate-closed" className="mb-0 flex cursor-pointer items-center gap-2 self-end pb-2"><Checkbox id="rate-closed" checked={rate.closed} onCheckedChange={checked => setRate({ ...rate, closed: checked === true })} /> Cerrar esta noche</Label>
            </div>
            <Button variant="outline" onClick={() => addRate.mutate()} disabled={!validRate || addRate.isPending}><Plus /> Guardar tarifa</Button>
            <RateList rates={ratesQuery.data ?? []} rooms={rooms} currency={currency} removing={removeRate.isPending} onRemove={id => removeRate.mutate(id)} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function RequestsPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['lodging-requests'], queryFn: lodging.getLodgingRequests, refetchInterval: 20_000 })
  const status = useMutation({
    mutationFn: ({ id, next }: { id: string; next: LodgingRequestStatus }) => lodging.setLodgingRequestStatus(id, next),
    onSuccess: (result, variables) => {
      if (!result.changed) {
        toast.info('La solicitud ya tenía ese estado')
      } else if (!result.notificationSent) {
        toast.warning('Estado guardado, pero el mensaje no se entregó. Contacta al huésped manualmente.')
      } else {
        toast.success(variables.next === 'confirmed' ? 'Estadía confirmada y huésped avisado' : 'Solicitud actualizada y huésped avisado')
      }
      void queryClient.invalidateQueries({ queryKey: ['lodging-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['lodging-requests-watch'] })
    },
    onError: error => toast.error(errorText(error)),
  })
  if (query.isLoading) return <PanelSkeleton />
  if (query.isError) return <QueryError onRetry={() => { void query.refetch() }} />

  const requests = query.data ?? []
  const pending = requests.filter(request => request.status === 'pending_owner')
  const history = requests.filter(request => request.status !== 'pending_owner')

  return (
    <div className="space-y-5">
      <div><h2 className="font-semibold">Pendientes ({pending.length})</h2><p className="text-sm text-muted-foreground">Confirma antes de que venza la retención. El servidor vuelve a validar el cupo.</p></div>
      {pending.length === 0 ? <EmptyState icon={CalendarRange} title="Sin solicitudes pendientes" description="Cuando un huésped elija una cotización del bot, aparecerá aquí para la decisión del equipo autorizado." /> : <div className="grid gap-4 xl:grid-cols-2">{pending.map(request => <RequestCard key={request.id} request={request} busy={status.isPending} onStatus={next => status.mutate({ id: request.id, next })} />)}</div>}
      {history.length > 0 && <><div><h2 className="font-semibold">Historial</h2><p className="text-sm text-muted-foreground">Solicitudes confirmadas, rechazadas, canceladas o vencidas.</p></div><div className="grid gap-3 xl:grid-cols-2">{history.map(request => <RequestCard key={request.id} request={request} busy={status.isPending} onStatus={next => status.mutate({ id: request.id, next })} />)}</div></>}
    </div>
  )
}

function RequestCard({ request, busy, onStatus }: { request: LodgingRequest; busy: boolean; onStatus: (status: LodgingRequestStatus) => void }) {
  const navigate = useNavigate()
  const badge = REQUEST_BADGES[request.status]
  const expiredAt = request.expires_at ? new Date(request.expires_at) : null
  const canSeeConversations = session.user?.role === 'owner'
    || session.user?.permissions.includes('conversaciones')
  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold">{request.contact_name || request.contact_phone}</p><p className="text-xs text-muted-foreground">{request.contact_phone}</p></div><Badge variant="secondary" className={badge.className}>{badge.label}</Badge></div>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Info label="Habitación" value={request.room_type_name || 'Tipo guardado'} />
        <Info label="Estadía" value={`${request.check_in} → ${request.check_out}`} />
        <Info label="Huéspedes" value={`${request.adults} adulto(s) · ${request.children} niño(s)`} />
        <Info label="Cupo" value={`${request.units} unidad(es) · ${request.nights} noche(s)`} />
        <Info label="Total oficial" value={money(request.total, request.currency)} />
        {request.status === 'pending_owner' && expiredAt && <Info label="Retención vence" value={expiredAt.toLocaleString('es-EC')} />}
      </div>
      {request.status === 'pending_owner' && <div className="flex flex-wrap justify-end gap-2">{canSeeConversations && <Button variant="outline" disabled={busy} onClick={() => navigate(`/conversations?phone=${encodeURIComponent(request.contact_phone)}`)}><MessageSquare /> Abrir conversación</Button>}<ConfirmAction trigger={<Button variant="outline" disabled={busy}><X /> Rechazar</Button>} title="Rechazar solicitud" description="Se liberará inmediatamente el cupo retenido. El sistema intentará avisar al huésped por el canal conectado." confirmLabel="Rechazar y liberar" destructive onConfirm={() => onStatus('rejected')} /><ConfirmAction trigger={<Button disabled={busy}><Check /> {busy ? 'Procesando…' : 'Confirmar estadía'}</Button>} title="Confirmar estadía" description="El cupo quedará confirmado y el sistema intentará avisar al huésped por el canal conectado." confirmLabel="Confirmar estadía" onConfirm={() => onStatus('confirmed')} /></div>}
      {request.status === 'confirmed' && <div className="flex flex-wrap justify-end gap-2"><ConfirmAction trigger={<Button variant="outline" disabled={busy}><X /> Cancelar</Button>} title="Cancelar estadía confirmada" description="Se liberará el cupo y se avisará al huésped. Revisa antes las políticas de cancelación del negocio." confirmLabel="Cancelar estadía" destructive onConfirm={() => onStatus('cancelled')} /></div>}
    </Card>
  )
}

function RoomSelect({ id, rooms, value, onChange }: { id: string; rooms: LodgingRoomType[]; value: string; onChange: (value: string) => void }) {
  return <Field label="Tipo de habitación" htmlFor={id}><Select value={value} onValueChange={onChange}><SelectTrigger id={id} className="w-full"><SelectValue placeholder="Selecciona…" /></SelectTrigger><SelectContent>{rooms.map(room => <SelectItem key={room.id} value={room.id}>{room.name}</SelectItem>)}</SelectContent></Select></Field>
}

function BlockList({ blocks, removing, onRemove }: { blocks: LodgingBlock[]; removing: boolean; onRemove: (id: string) => void }) {
  if (blocks.length === 0) return <p className="text-sm text-muted-foreground">No hay bloqueos cargados.</p>
  return <div className="space-y-2">{blocks.map(block => <div key={block.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm"><div className="min-w-0 flex-1"><p className="truncate font-medium">{block.room_type_name || 'Habitación'} · {block.units} unidad(es)</p><p className="text-xs text-muted-foreground">{block.check_in} → {block.check_out} · {block.kind}{block.notes ? ` · ${block.notes}` : ''}</p></div><ConfirmAction trigger={<Button variant="ghost" size="icon" disabled={removing} aria-label="Eliminar bloqueo"><Trash2 /></Button>} title="Eliminar bloqueo" description="El cupo volverá a estar disponible para nuevas solicitudes." confirmLabel="Eliminar bloqueo" destructive onConfirm={() => onRemove(block.id)} /></div>)}</div>
}

function RateList({ rates, rooms, currency, removing, onRemove }: { rates: LodgingRateOverride[]; rooms: LodgingRoomType[]; currency: string; removing: boolean; onRemove: (id: string) => void }) {
  const names = useMemo(() => new Map(rooms.map(room => [room.id, room.name])), [rooms])
  if (rates.length === 0) return <p className="text-sm text-muted-foreground">No hay tarifas especiales.</p>
  return <div className="space-y-2">{rates.map(rate => <div key={rate.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm"><div className="min-w-0 flex-1"><p className="truncate font-medium">{names.get(rate.room_type_id) || 'Habitación'} · {rate.rate_date}</p><p className="text-xs text-muted-foreground">{rate.closed ? 'Cerrada' : rate.base_rate == null ? 'Conserva tarifa base' : `Tarifa ${money(rate.base_rate, currency)}`}</p></div><ConfirmAction trigger={<Button variant="ghost" size="icon" disabled={removing} aria-label="Eliminar tarifa especial"><Trash2 /></Button>} title="Eliminar tarifa especial" description="La fecha volverá a usar la tarifa general de la habitación." confirmLabel="Eliminar tarifa" destructive onConfirm={() => onRemove(rate.id)} /></div>)}</div>
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return <div><Label htmlFor={htmlFor}>{label}</Label>{children}</div>
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium text-foreground">{value}</p></div>
}

function EmptyState({ icon: Icon, title, description, action }: { icon: React.ComponentType<{ className?: string }>; title: string; description: string; action?: React.ReactNode }) {
  return <Card className="items-center gap-2 p-8 text-center"><Icon className="h-9 w-9 text-muted-foreground/60" /><p className="font-medium">{title}</p><p className="max-w-lg text-sm text-muted-foreground">{description}</p>{action}</Card>
}

function PanelSkeleton() {
  return <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-44 w-full" /><Skeleton className="h-28 w-full" /></div>
}
