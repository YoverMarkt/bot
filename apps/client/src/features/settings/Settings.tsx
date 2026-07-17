import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, session } from '../../api/client'
import { useBusinessInfo, isBookingBiz } from '../../lib/biz'
import { Crown, Lock, Bot as BotIcon, TriangleAlert, Truck, Undo2, Tag, Pin } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Textarea } from '@botpanel/ui/components/textarea'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Label } from '@botpanel/ui/components/label'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// ── Tipos (endpoints de routes/business.routes.js) ──
type BusinessData = {
  name: string; slogan: string | null; description: string | null; hours: string | null
  address: string | null; phone: string | null; social: string | null; payment_methods: string | null
}
type Policies = { bot_prompt?: string | null; shipping?: string | null; returns?: string | null; discounts?: string | null; bot_instructions?: string | null }
type TeamUser = { id: string; email: string; name: string | null; role: string; permissions: string[] | null }


export default function Settings() {
  const isOwner = session.user?.role === 'owner'
  if (!isOwner) return <Locked />
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Ajustes</h1>
        <p className="text-sm text-muted-foreground">Identidad básica de tu negocio</p>
      </div>
      <BusinessForm />
    </div>
  )
}

// Esqueleto compartido por los formularios de esta sección (identidad y bot)
function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <Card className="p-5 max-w-2xl gap-0">
      <div className="space-y-3">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
      <div className="flex justify-end mt-4">
        <Skeleton className="h-9 w-36" />
      </div>
    </Card>
  )
}

export function Locked() {
  return (
    <Card className="p-8 text-center gap-1">
      <Lock className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
      <p className="text-foreground/90 font-medium">Solo el dueño puede ver esta sección.</p>
    </Card>
  )
}

// ── Identidad del negocio (Ajustes del viejo: SOLO nombre, slogan y descripción) ──
export function BusinessForm() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['business'], queryFn: () => api<BusinessData>('/api/client/business') })
  const [draft, setDraft] = useState<Partial<BusinessData> | null>(null)
  const f = draft ?? data

  const mSave = useMutation({
    mutationFn: () => api('/api/client/business', {
      method: 'PUT',
      body: JSON.stringify({
        name: f?.name,
        slogan: f?.slogan,
        description: f?.description,
        payment_methods: f?.payment_methods,
      }),
    }),
    onSuccess: () => {
      toast.success('Guardado — el bot ya usa estos datos')
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['business'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  })

  if (isLoading || !f) return <FormSkeleton />
  const set = (k: keyof BusinessData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft({ ...f, [k]: e.target.value })

  return (
    <Card className="p-5 max-w-2xl gap-0">
      <div className="space-y-3">
        <div><Label htmlFor="business-name">Nombre del negocio</Label><Input id="business-name" value={f.name ?? ''} onChange={set('name')} placeholder="Ej: Barbería El Corte" /></div>
        <div><Label htmlFor="business-slogan">Slogan / Lema</Label><Input id="business-slogan" value={f.slogan ?? ''} onChange={set('slogan')} placeholder="Ej: El mejor corte de la ciudad" /></div>
        <div><Label htmlFor="business-description">Descripción corta</Label><Textarea id="business-description" rows={3} value={f.description ?? ''} onChange={set('description')} placeholder="Una o dos líneas sobre tu negocio." /></div>
        <div><Label htmlFor="business-payment-methods">Métodos de pago</Label><Input id="business-payment-methods" value={f.payment_methods ?? ''} onChange={set('payment_methods')} placeholder="Ej: transferencia, efectivo, tarjeta" /></div>
      </div>
      <div className="flex justify-end mt-4">
        <Button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}>
          {mSave.isPending ? 'Guardando…' : 'Guardar cambios'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground/80 mt-3">Para cambiar tu correo o contraseña de acceso, contacta al administrador.</p>
    </Card>
  )
}

// ── Bot: prompt (personalidad) + políticas ──
export function BotForm() {
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: () => api<Policies>('/api/client/policies') })
  const [draft, setDraft] = useState<Policies | null>(null)
  const f = draft ?? data

  const mSave = useMutation({
    mutationFn: () => api('/api/client/policies', { method: 'PUT', body: JSON.stringify(f) }),
    onSuccess: () => toast.success('Guardado — el bot ya responde con esto'),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  })

  if (isLoading || !f) return <FormSkeleton fields={3} />
  const set = (k: keyof Policies) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...f, [k]: e.target.value })

  return (
    <Card className="p-5 max-w-2xl gap-0 space-y-4">
      <div>
        <Label htmlFor="bot-settings-prompt"><BotIcon className="w-3.5 h-3.5" /> Prompt del bot (su personalidad y forma de atender)</Label>
        <Textarea id="bot-settings-prompt" className="font-mono text-xs" rows={14} value={f.bot_prompt ?? ''} onChange={set('bot_prompt')}
          placeholder="Eres el asistente virtual de…" />
        <p className="text-[11px] text-muted-foreground/80 mt-1 flex items-center gap-1"><TriangleAlert className="w-3 h-3 shrink-0" /> El prompt es la personalidad; los precios, totales y descuentos SIEMPRE los calcula el sistema (regla de dinero).</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><Label htmlFor="bot-settings-shipping"><Truck className="w-3.5 h-3.5" /> Envíos</Label><Textarea id="bot-settings-shipping" rows={2} value={f.shipping ?? ''} onChange={set('shipping')} /></div>
        <div><Label htmlFor="bot-settings-returns"><Undo2 className="w-3.5 h-3.5" /> Devoluciones</Label><Textarea id="bot-settings-returns" rows={2} value={f.returns ?? ''} onChange={set('returns')} /></div>
        <div><Label htmlFor="bot-settings-discounts"><Tag className="w-3.5 h-3.5" /> Descuentos (informativo)</Label><Textarea id="bot-settings-discounts" rows={2} value={f.discounts ?? ''} onChange={set('discounts')} /></div>
        <div><Label htmlFor="bot-settings-instructions"><Pin className="w-3.5 h-3.5" /> Instrucciones extra</Label><Textarea id="bot-settings-instructions" rows={2} value={f.bot_instructions ?? ''} onChange={set('bot_instructions')} /></div>
      </div>
      <div className="flex justify-end">
        <Button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}>
          {mSave.isPending ? 'Guardando…' : 'Guardar bot'}
        </Button>
      </div>
    </Card>
  )
}

// ── Equipo (propuesta elegida por el usuario 2026-07-10): lista con
// permisos editables en línea + formulario de nuevo empleado al lado.
// El permiso "citas" también controla la sección Horarios (todos los
// negocios la tienen); su nombre se adapta al tipo de negocio.
const permsForBiz = (bookingBiz: boolean, lodgingBiz: boolean) => [
  ['catalogo', 'Catálogo'], ['conversaciones', 'Conversaciones'],
  ['ventas', 'Ventas'], ['reportes', 'Reportes'],
  ['citas', bookingBiz ? 'Citas y horarios' : 'Horarios'],
  ...(lodgingBiz ? [['hospedaje', 'Hospedaje']] as const : []),
] as const
export function Team() {
  const qc = useQueryClient()
  const { data: bizInfo } = useBusinessInfo()
  const PERMS = permsForBiz(
    isBookingBiz(bizInfo?.type, bizInfo?.takes_bookings),
    bizInfo?.lodging_enabled === true,
  )
  const { data: users = [], isLoading } = useQuery({ queryKey: ['team'], queryFn: () => api<TeamUser[]>('/api/client/users') })
  const [form, setForm] = useState({ email: '', password: '', name: '', permissions: [] as string[] })

  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] })

  const mCreate = useMutation({
    mutationFn: () => api('/api/client/users', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { setForm({ email: '', password: '', name: '', permissions: [] }); toast.success('Empleado creado'); refresh() },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  })
  const mDelete = useMutation({ mutationFn: (id: string) => api(`/api/client/users/${id}`, { method: 'DELETE' }), onSettled: refresh })
  const mPerms = useMutation({
    mutationFn: (v: { id: string; permissions: string[] }) => api(`/api/client/users/${v.id}`, { method: 'PUT', body: JSON.stringify({ permissions: v.permissions }) }),
    onSettled: refresh,
  })

  const togglePerm = (list: string[], p: string) => list.includes(p) ? list.filter(x => x !== p) : [...list, p]

  if (isLoading) return (
    <div className="grid lg:grid-cols-2 gap-4 max-w-4xl">
      <Card className="p-5 gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </Card>
      <Card className="p-5 gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </Card>
    </div>
  )

  return (
    <div className="grid lg:grid-cols-2 gap-4 max-w-4xl">
      <Card className="p-5 gap-0">
        <h2 className="font-semibold text-foreground mb-3">Tu equipo ({users.length})</h2>
        {users.length === 0 && <p className="text-sm text-muted-foreground">Solo tú por ahora. Crea cuentas para tus empleados con permisos limitados.</p>}
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="border border-border/60 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-sm text-foreground">{u.name || u.email} {u.role === 'owner' && <span className="text-[10px] bg-primary/10 text-primary rounded px-1.5 py-0.5 ml-1"><Crown className="w-3 h-3 inline mr-0.5" />DUEÑO</span>}</div>
                  <div className="text-xs text-muted-foreground/80">{u.email}</div>
                </div>
                {u.role !== 'owner' && (
                  <ConfirmAction
                    trigger={<Button variant="outline" size="sm">Eliminar</Button>}
                    title={`Eliminar a ${u.email}`}
                    description="El empleado perderá el acceso al panel. Esta acción no afecta al dueño del negocio."
                    confirmLabel="Eliminar acceso"
                    destructive
                    onConfirm={() => mDelete.mutate(u.id)}
                  />
                )}
              </div>
              {u.role !== 'owner' && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {PERMS.map(([p, label]) => (
                    <Label key={p} htmlFor={`team-${u.id}-permission-${p}`} className="mb-0 flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                      <Checkbox id={`team-${u.id}-permission-${p}`} checked={(u.permissions ?? []).includes(p)}
                        onCheckedChange={() => mPerms.mutate({ id: u.id, permissions: togglePerm(u.permissions ?? [], p) })} />
                      {label}
                    </Label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5 gap-0">
        <h2 className="font-semibold text-foreground mb-3">+ Nuevo empleado</h2>
        <div className="space-y-3">
          <div><Label htmlFor="team-new-name">Nombre</Label><Input id="team-new-name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label htmlFor="team-new-email">Correo *</Label><Input id="team-new-email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
          <div><Label htmlFor="team-new-password">Contraseña * (mínimo 12 caracteres)</Label><Input id="team-new-password" type="password" minLength={12} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></div>
          <div role="group" aria-labelledby="team-new-permissions-label">
            <p id="team-new-permissions-label" className="mb-2 flex items-center gap-2 text-sm leading-none font-medium text-foreground select-none">Permisos (qué secciones puede ver)</p>
            <div className="flex flex-wrap gap-2 mt-1">
              {PERMS.map(([p, label]) => (
                <Label key={p} htmlFor={`team-new-permission-${p}`} className="mb-0 flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox id={`team-new-permission-${p}`} checked={form.permissions.includes(p)}
                    onCheckedChange={() => setForm({ ...form, permissions: togglePerm(form.permissions, p) })} />
                  {label}
                </Label>
              ))}
            </div>
          </div>
          <Button onClick={() => mCreate.mutate()} disabled={!form.email || form.password.length < 12 || mCreate.isPending} className="w-full">
            {mCreate.isPending ? 'Creando…' : 'Crear empleado'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
