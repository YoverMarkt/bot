import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, session } from '../../api/client'
import { Locked } from './Settings'
import { Lightbulb } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Textarea } from '@botpanel/ui/components/textarea'
import { Label } from '@botpanel/ui/components/label'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// ── Mensaje de bienvenida y políticas ─────────────────────────────
//
// ⚠️ Esta pantalla se llamaba «Prompt del Bot» hasta el 2026-08-21. El dueño
// escribía instrucciones para una IA —«Eres Sofía, asistente de…»— y el código
// PESCABA de ahí un saludo con expresiones regulares. Retirada la IA, escribe
// el saludo y se manda tal cual.
//
// Se fueron también las tres plantillas de personalidad (formal, casual, lujo):
// eran prompts, no saludos.

type Policies = {
  welcome_message?: string | null
  shipping?: string | null
  returns?: string | null
  discounts?: string | null
}

const LIMITE = 280

const EJEMPLOS = [
  '¡Hola! 👋 Bienvenido a {{negocio}}. ¿Qué se te antoja hoy?',
  '¡Buenas! 😊 Gracias por escribir a {{negocio}}. Dime en qué te ayudo.',
  '¡Hola! 🍕 Aquí {{negocio}}. Elige una opción del menú y armamos tu pedido.',
]

export default function Bienvenida() {
  const isOwner = session.user?.role === 'owner'
  const { data, isLoading } = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<Policies>('/api/client/policies'),
  })
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? data?.welcome_message ?? ''
  const restantes = LIMITE - value.length

  const mSave = useMutation({
    mutationFn: () => api('/api/client/welcome-message', {
      method: 'PUT',
      body: JSON.stringify({ welcome_message: value.trim() || null }),
    }),
    onSuccess: () => toast.success('Saludo guardado — es lo primero que verá tu cliente'),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  })

  if (!isOwner) return <Locked />
  if (isLoading) return (
    <div>
      <div className="mb-5 space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card className="p-5 max-w-2xl gap-3">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-9 w-36 self-end" />
      </Card>
    </div>
  )

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Mensaje de bienvenida</h1>
        <p className="text-sm text-muted-foreground">
          Lo primero que lee tu cliente al escribirte. Se manda tal cual lo escribas.
        </p>
      </div>

      <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 mb-4 max-w-2xl flex gap-3 text-foreground">
        <Lightbulb className="w-5 h-5 shrink-0 text-primary" />
        <div className="text-xs leading-relaxed">
          <div className="font-bold uppercase tracking-wide text-primary mb-1">Cómo escribirlo</div>
          Corto y directo: es un saludo, no un texto de presentación. Escribe{' '}
          <code className="rounded bg-background/60 px-1">{'{{negocio}}'}</code> donde quieras
          que aparezca el nombre de tu local.<br />
          <span className="opacity-80">Si lo dejas vacío, se usa un saludo estándar con el nombre de tu negocio.</span>
        </div>
      </div>

      <Card className="p-5 max-w-2xl gap-0">
        <Label htmlFor="mensaje-bienvenida">Tu saludo</Label>
        <Textarea
          id="mensaje-bienvenida"
          rows={3}
          maxLength={LIMITE}
          value={value}
          onChange={e => setDraft(e.target.value)}
          className="w-full"
          placeholder="¡Hola! 👋 Bienvenido a {{negocio}}. ¿Qué se te antoja hoy?"
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-muted-foreground">
            {restantes} caracteres disponibles
          </span>
        </div>

        <div className="flex gap-2 flex-wrap mt-3">
          {EJEMPLOS.map((ejemplo, i) => (
            <Button key={i} variant="outline" size="sm" type="button" onClick={() => setDraft(ejemplo)}>
              Ejemplo {i + 1}
            </Button>
          ))}
        </div>

        <div className="flex justify-end mt-3">
          <Button onClick={() => mSave.mutate()} disabled={draft === null || mSave.isPending}>
            {mSave.isPending ? 'Guardando…' : 'Guardar saludo'}
          </Button>
        </div>
      </Card>

      <PoliciesCard />
    </div>
  )
}

function PoliciesCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<Policies>('/api/client/policies'),
  })
  const [draft, setDraft] = useState<Policies | null>(null)
  const f = draft ?? data

  const mSave = useMutation({
    mutationFn: () => api('/api/client/policies', {
      method: 'PUT',
      body: JSON.stringify({
        shipping: f?.shipping ?? null,
        returns: f?.returns ?? null,
        discounts: f?.discounts ?? null,
      }),
    }),
    onSuccess: () => toast.success('Políticas guardadas'),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  })

  if (isLoading || !f) return null
  const set = (k: keyof Policies) => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    setDraft({ ...f, [k]: e.target.value })

  return (
    <Card className="p-5 max-w-2xl mt-5 gap-0">
      <h2 className="font-semibold text-foreground mb-1">Envíos, devoluciones y descuentos</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Tus condiciones, escritas por ti. Se muestran tal cual cuando el cliente pregunta.
      </p>
      <div className="space-y-3">
        <div><Label htmlFor="politica-envios">Envíos</Label><Textarea id="politica-envios" rows={3} value={f.shipping ?? ''} onChange={set('shipping')} /></div>
        <div><Label htmlFor="politica-devoluciones">Devoluciones</Label><Textarea id="politica-devoluciones" rows={3} value={f.returns ?? ''} onChange={set('returns')} /></div>
        <div><Label htmlFor="politica-descuentos">Descuentos</Label><Textarea id="politica-descuentos" rows={3} value={f.discounts ?? ''} onChange={set('discounts')} /></div>
      </div>
      <div className="flex justify-end mt-3">
        <Button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}>
          {mSave.isPending ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </Card>
  )
}
