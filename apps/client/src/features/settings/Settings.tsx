import { useRef, useState } from 'react'
import MetodosDePago from './MetodosDePago'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, session } from '../../api/client'
import { MEDIA_LIMITS, fmtMB, uploadMedia } from '../catalog/api'
import { Crown, Lock } from 'lucide-react'
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
  delivery_fee: number | null; brand_color: string | null; logo_url: string | null; cover_url: string | null; takes_orders?: boolean
  prep_time_minutes: number | null; delivery_extra_minutes: number | null
  min_order_amount: number | null; max_orders_per_hour: number | null
}
type TeamUser = { id: string; email: string; name: string | null; role: string; permissions: string[] | null }


export default function Settings() {
  const isOwner = session.user?.role === 'owner'
  if (!isOwner) return <Locked />
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Ajustes</h1>
        <p className="text-sm text-muted-foreground">Identidad de tu negocio y cómo te pagan</p>
      </div>
      <BusinessForm />
      <BankAccountForm />
    </div>
  )
}

/**
 * Los minutos que escribió el dueño, o el valor de arranque si borró el campo.
 *
 * Un `<input type="number">` vacío entrega la cadena vacía, no null ni
 * undefined: `?? ` no la atrapa y `Number('')` vale 0. Sin esto, borrar el
 * campo para reescribirlo guardaba un 0 sin avisar.
 */
const minutosO = (valor: unknown, porDefecto: number): number => {
  const minutos = Number(valor)
  return valor === '' || valor == null || !Number.isFinite(minutos) ? porDefecto : minutos
}

// ── Cuenta bancaria para transferencias ──
//
// La tienda ya la mostraba al cliente en su pantalla de pago, pero no había
// forma de cargarla salvo a mano en la base.
//
// Estos datos NO son secretos: son con los que le pagan al negocio, y quien
// gestiona el riesgo es el banco. Aun así solo los ve y los cambia el dueño —
// un empleado con permiso de catálogo no tiene por qué tocar a qué cuenta
// entra el dinero.
type BankAccount = {
  bank_name: string
  account_type: 'ahorros' | 'corriente'
  account_number: string
  holder_name: string
  holder_id: string | null
  instructions: string | null
}

const CUENTA_VACIA: BankAccount = {
  bank_name: '', account_type: 'ahorros', account_number: '',
  holder_name: '', holder_id: '', instructions: '',
}

export function BankAccountForm() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['bank-account'],
    queryFn: () => api<BankAccount | null>('/api/client/bank-account'),
  })
  const [draft, setDraft] = useState<BankAccount | null>(null)
  const f = draft ?? data ?? CUENTA_VACIA

  const mSave = useMutation({
    mutationFn: () => api('/api/client/bank-account', {
      method: 'PUT',
      body: JSON.stringify(f),
    }),
    onSuccess: () => {
      toast.success('Guardada — tus clientes ya la ven al pagar')
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['bank-account'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  })

  if (isLoading) return <div className="mt-5"><FormSkeleton fields={5} /></div>

  const set = (k: keyof BankAccount) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...f, [k]: e.target.value })

  const completa = Boolean(f.bank_name && f.account_number && f.holder_name)

  return (
    <Card className="p-5 max-w-2xl gap-0 mt-5">
      <div className="mb-3">
        <h2 className="font-semibold text-foreground">Cuenta para transferencias</h2>
        <p className="text-sm text-muted-foreground">
          Es lo que ve tu cliente en la tienda cuando elige pagar por transferencia.
          {!completa && ' Sin ella, esa pantalla queda vacía.'}
        </p>
      </div>
      <div className="space-y-3">
        <div>
          <Label htmlFor="bank-name">Banco</Label>
          <Input id="bank-name" value={f.bank_name ?? ''} onChange={set('bank_name')} maxLength={80} placeholder="Ej: Banco Pichincha" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="bank-type">Tipo de cuenta</Label>
            <select
              id="bank-type"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={f.account_type}
              onChange={e => setDraft({ ...f, account_type: e.target.value as BankAccount['account_type'] })}
            >
              <option value="ahorros">Ahorros</option>
              <option value="corriente">Corriente</option>
            </select>
          </div>
          <div>
            <Label htmlFor="bank-number">Número de cuenta</Label>
            <Input id="bank-number" value={f.account_number ?? ''} onChange={set('account_number')} maxLength={40} placeholder="Ej: 2100123456" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="bank-holder">Titular</Label>
            <Input id="bank-holder" value={f.holder_name ?? ''} onChange={set('holder_name')} maxLength={120} placeholder="Nombre como figura en el banco" />
          </div>
          <div>
            <Label htmlFor="bank-holder-id">Cédula o RUC</Label>
            <Input id="bank-holder-id" value={f.holder_id ?? ''} onChange={set('holder_id')} maxLength={20} placeholder="opcional" />
          </div>
        </div>
        <div>
          <Label htmlFor="bank-instructions">Instrucciones</Label>
          <Textarea id="bank-instructions" rows={2} maxLength={300} value={f.instructions ?? ''} onChange={set('instructions')} placeholder="Ej: envía el comprobante por WhatsApp para confirmar tu pedido" />
        </div>
      </div>
      <div className="flex justify-end mt-4">
        <Button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending || !completa}>
          {mSave.isPending ? 'Guardando…' : 'Guardar cuenta'}
        </Button>
      </div>
    </Card>
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

// Verde de la plataforma: el mismo que usa la mini app cuando el negocio no
// eligió color propio.
const DEFAULT_BRAND_COLOR = '#D9F950'

// ── Identidad del negocio (Ajustes del viejo: SOLO nombre, slogan y descripción) ──
export function BusinessForm() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['business'], queryFn: () => api<BusinessData>('/api/client/business') })
  const [draft, setDraft] = useState<Partial<BusinessData> | null>(null)
  const [subiendo, setSubiendo] = useState<'logo_url' | 'cover_url' | null>(null)
  const logoInput = useRef<HTMLInputElement>(null)
  const portadaInput = useRef<HTMLInputElement>(null)
  const f = draft ?? data

  // Se reutiliza la subida del catálogo: mismo endpoint, que ya valida tipo y
  // tamaño y sube a Cloudinary bajo el business_id del JWT. Aquí solo se guarda
  // la URL que devuelve; el negocio nunca ve credenciales.
  //
  // Las dos imágenes comparten manejador porque siguen la misma regla: dos
  // copias de esto se desincronizan en cuanto cambie el límite de tamaño.
  const subirImagen = async (
    campo: 'logo_url' | 'cover_url',
    etiqueta: string,
    archivo: File | undefined,
  ) => {
    if (!archivo || !f) return
    setSubiendo(campo)
    try {
      if (archivo.size > MEDIA_LIMITS.image) {
        toast.error(`${etiqueta} supera ${fmtMB(MEDIA_LIMITS.image)}`)
        return
      }
      const subida = await uploadMedia(archivo)
      setDraft({ ...f, [campo]: subida.url })
      toast.success(`${etiqueta} lista — pulsa Guardar para aplicarla`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `No se pudo subir ${etiqueta.toLowerCase()}`)
    } finally {
      setSubiendo(null)
    }
  }

  const mSave = useMutation({
    mutationFn: () => api('/api/client/business', {
      method: 'PUT',
      body: JSON.stringify({
        name: f?.name,
        slogan: f?.slogan,
        description: f?.description,
        payment_methods: f?.payment_methods,
        delivery_fee: Number(f?.delivery_fee) || 0,
        brand_color: f?.brand_color || null,
        logo_url: f?.logo_url || null,
        cover_url: f?.cover_url || null,
        // ⚠️ Un campo numérico VACÍO entrega `''`, no null: el `??` no lo
        // atrapa y `Number('')` es 0. Así, borrar el tiempo de entrega para
        // reescribirlo guardaba 0 en silencio y la tienda prometía la comida
        // sin sumar el reparto. Se cae al defecto cuando no hay un número.
        prep_time_minutes: minutosO(f?.prep_time_minutes, 25),
        // Cero es legítimo aquí —entrego en mi cuadra—, así que solo se
        // descarta lo que NO es un número, nunca el cero.
        delivery_extra_minutes: minutosO(f?.delivery_extra_minutes, 10),
        // ⚠️ Mismo cuidado que arriba, y aquí el cero pesa más: en el mínimo
        // significa «sin mínimo», que es un valor que el dueño elige a
        // propósito. `minutosO` ya distingue el cero de «no vino».
        min_order_amount: minutosO(f?.min_order_amount, 0),
        max_orders_per_hour: minutosO(f?.max_orders_per_hour, 30),
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
        <div><Label htmlFor="business-name">Nombre del negocio</Label><Input id="business-name" value={f.name ?? ''} onChange={set('name')} placeholder="Ej: Pizzería El Horno" /></div>
        <div><Label htmlFor="business-slogan">Slogan / Lema</Label><Input id="business-slogan" value={f.slogan ?? ''} onChange={set('slogan')} placeholder="Ej: La mejor pizza de la ciudad" /></div>
        <div><Label htmlFor="business-description">Descripción corta</Label><Textarea id="business-description" rows={3} value={f.description ?? ''} onChange={set('description')} placeholder="Una o dos líneas sobre tu negocio." /></div>
        <div><Label htmlFor="business-payment-methods">Métodos de pago</Label><Input id="business-payment-methods" value={f.payment_methods ?? ''} onChange={set('payment_methods')} placeholder="Ej: transferencia, efectivo, tarjeta" /></div>

        {/* ── Tu tienda (mini app) ── */}
        <div className="border-t pt-4 mt-1 space-y-3">
          <p className="text-[13px] font-semibold">Tu tienda</p>

          {/* ── Cómo te pagan ──
              Hasta el 2026-08-16 esto era un campo de texto que solo veía el
              bot: el dueño creía que elegía y la tienda ofrecía los tres
              métodos a todo el mundo. Ahora es el interruptor de verdad, y el
              servidor lo vuelve a exigir al crear el pedido. */}
          <MetodosDePago />

          <div>
            <Label htmlFor="business-delivery-fee">Costo de envío a domicilio</Label>
            <Input
              id="business-delivery-fee"
              type="number" min="0" max="999" step="0.01" inputMode="decimal"
              value={f.delivery_fee ?? 0}
              onChange={set('delivery_fee')}
              placeholder="Ej: 2.00"
            />
            <p className="text-[11px] text-muted-foreground/80 mt-1">
              Se suma solo a los pedidos a domicilio. Quien retira en el local no lo paga.
              Déjalo en 0 si no cobras envío.
            </p>
          </div>

          {/* ── Cuánto tardas ──
              No es solo un texto: el tiempo de preparación decide desde qué
              hora se puede programar un pedido. Si dice menos de lo que tarda
              la cocina, la tienda ofrece horas que el negocio no cumple. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="business-prep-time">Tiempo de preparación (minutos)</Label>
              <Input
                id="business-prep-time"
                type="number" min="1" max="480" step="1" inputMode="numeric"
                value={f.prep_time_minutes ?? 25}
                onChange={set('prep_time_minutes')}
                placeholder="Ej: 25"
              />
              <p className="text-[11px] text-muted-foreground/80 mt-1">
                Cuánto tardas en tenerlo listo. Decide desde qué hora tus clientes
                pueden programar un pedido, así que conviene que sea realista.
              </p>
            </div>

            <div>
              <Label htmlFor="business-delivery-time">Tiempo de entrega extra (minutos)</Label>
              <Input
                id="business-delivery-time"
                type="number" min="0" max="240" step="1" inputMode="numeric"
                value={f.delivery_extra_minutes ?? 10}
                onChange={set('delivery_extra_minutes')}
                placeholder="Ej: 10"
              />
              <p className="text-[11px] text-muted-foreground/80 mt-1">
                Lo que suma llevarlo a domicilio. Quien retira en el local no lo espera.
              </p>
            </div>
          </div>

          {/* ── Los dos frenos del local ──
              Nacen de un caso real y barato de montar: alguien pasa el enlace
              en un grupo de cuarenta personas con «pidan una gaseosa, es
              gratis». Cada uno hace UN pedido, así que ningún freno por
              cliente los ve, y a la cocina le entran cuarenta comandas de
              $1,50 a la vez. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="business-min-order">Pedido mínimo ($)</Label>
              <Input
                id="business-min-order"
                type="number" min="0" max="999" step="0.01" inputMode="decimal"
                value={f.min_order_amount ?? 0}
                onChange={set('min_order_amount')}
                placeholder="Ej: 5.00"
              />
              <p className="text-[11px] text-muted-foreground/80 mt-1">
                Lo mínimo que vale la pena preparar, según tu producto más barato.
                <strong> No cuenta el envío</strong>: si alguien quiere un agua y pagar
                el reparto, es su decisión. Déjalo en 0 para no exigir mínimo.
              </p>
            </div>

            <div>
              <Label htmlFor="business-max-orders">Pedidos por hora que puedes atender</Label>
              <Input
                id="business-max-orders"
                type="number" min="1" max="500" step="1" inputMode="numeric"
                value={f.max_orders_per_hour ?? 30}
                onChange={set('max_orders_per_hour')}
                placeholder="Ej: 30"
              />
              <p className="text-[11px] text-muted-foreground/80 mt-1">
                Pasado ese número, la tienda pide a los siguientes que vuelvan en unos
                minutos en vez de llenarte la cocina. Súbelo si tu cocina da para más.
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="business-logo">Logo de tu empresa</Label>
            <div className="flex items-center gap-3">
              <div className="size-14 shrink-0 overflow-hidden rounded-xl border bg-muted">
                {f.logo_url
                  ? <img src={f.logo_url} alt="Logo de tu empresa" className="size-full object-cover" />
                  : <div className="flex size-full items-center justify-center text-[10px] text-muted-foreground">Sin logo</div>}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  id="business-logo"
                  ref={logoInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => void subirImagen('logo_url', 'El logo', e.target.files?.[0])}
                />
                <Button variant="outline" size="sm" disabled={subiendo === 'logo_url'} onClick={() => logoInput.current?.click()}>
                  {subiendo === 'logo_url' ? 'Subiendo…' : f.logo_url ? 'Cambiar logo' : 'Subir logo'}
                </Button>
                {f.logo_url && (
                  <Button variant="outline" size="sm" onClick={() => setDraft({ ...f, logo_url: null })}>
                    Quitar
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground/80 mt-1">
              Se ve en la cabecera de tu mini app. Cuadrado se ve mejor. Recuerda guardar los cambios.
            </p>
          </div>

          <div>
            <Label htmlFor="business-cover">Portada de tu tienda</Label>
            <div className="flex items-center gap-3">
              <div className="h-14 w-24 shrink-0 overflow-hidden rounded-xl border bg-muted">
                {f.cover_url
                  ? <img src={f.cover_url} alt="Portada de tu tienda" className="size-full object-cover" />
                  : <div className="flex size-full items-center justify-center text-[10px] text-muted-foreground">Sin portada</div>}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  id="business-cover"
                  ref={portadaInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => void subirImagen('cover_url', 'La portada', e.target.files?.[0])}
                />
                <Button variant="outline" size="sm" disabled={subiendo === 'cover_url'} onClick={() => portadaInput.current?.click()}>
                  {subiendo === 'cover_url' ? 'Subiendo…' : f.cover_url ? 'Cambiar portada' : 'Subir portada'}
                </Button>
                {f.cover_url && (
                  <Button variant="outline" size="sm" onClick={() => setDraft({ ...f, cover_url: null })}>
                    Quitar
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground/80 mt-1">
              La foto grande del encabezado, detrás de tu logo. Apaisada se ve mejor.
              Sin portada, la cabecera queda en negro. Recuerda guardar los cambios.
            </p>
          </div>

          <div>
            <Label htmlFor="business-brand-color">Color de tu marca</Label>
            <div className="flex items-center gap-2">
              <input
                id="business-brand-color"
                type="color"
                value={f.brand_color || DEFAULT_BRAND_COLOR}
                onChange={set('brand_color')}
                aria-label="Color de tu marca"
                className="h-9 w-14 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
              />
              <Input
                value={f.brand_color ?? ''}
                onChange={set('brand_color')}
                placeholder={DEFAULT_BRAND_COLOR}
                aria-label="Color de tu marca en hexadecimal"
              />
              {f.brand_color && (
                <Button variant="outline" size="sm" onClick={() => setDraft({ ...f, brand_color: null })}>
                  Quitar
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground/80 mt-1">
              Con el que se pinta tu mini app. Si lo dejas vacío usa el color de la plataforma.
              El texto encima se ajusta solo para que siempre se lea.
            </p>
          </div>
        </div>
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

// ── Equipo (propuesta elegida por el usuario 2026-07-10): lista con
// permisos editables en línea + formulario de nuevo empleado al lado.
// El permiso "horarios" controla la sección Horarios (todos los
// negocios la tienen); su nombre se adapta al tipo de negocio.
// ⚠️ Se retiró el permiso `conversaciones` el 2026-08-23, con la pantalla que
// gobernaba. El servidor lo SIGUE aceptando en `client_users.permissions`
// (`ALLOWED_PERMISSIONS`), así que ningún empleado que ya lo tuviera se rompe
// al guardar: simplemente deja de haber dónde marcarlo y qué abriría.
const permsForBiz = () => [
  ['catalogo', 'Catálogo'],
  ['ventas', 'Ventas'], ['reportes', 'Reportes'],
  ['horarios', 'Horarios'],
] as const
export function Team() {
  const qc = useQueryClient()
  const PERMS = permsForBiz()
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
