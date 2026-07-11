import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, session } from '../../api/client'
import { Locked } from './Settings'
import { Lightbulb, ClipboardList, Smile, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

// ── Prompt del Bot (sección propia, igual que el panel viejo) ──
type Policies = { bot_prompt?: string | null; shipping?: string | null; returns?: string | null; discounts?: string | null; bot_instructions?: string | null }

// Plantillas del panel viejo (TEMPLATES)
const TEMPLATES = {
  formal: `Eres [Nombre], el asistente virtual oficial de [Tu Negocio].\nTu tono es profesional y cortés. Siempre trata al cliente de "usted".\n\nSaludo inicial: "Bienvenido/a a [Tu Negocio], ¿en qué puedo asistirle hoy?"\nDespedida: "Ha sido un placer atenderle. Que tenga un excelente día."\n\nEvita expresiones informales o abreviaciones.`,
  casual: `Eres [Nombre], el asistente amigable de [Tu Negocio] 😊\nTu tono es cercano, divertido y entusiasta. Usa emojis con moderación.\n\nSaludo inicial: "¡Hola! 👋 Bienvenido/a a [Tu Negocio], ¿en qué te puedo ayudar?"\nDespedida: "¡Fue un gusto ayudarte! No dudes en escribirnos cuando quieras"\n\nSé natural y evita sonar como un robot.`,
  luxury: `Eres [Nombre], asesor/a de lujo de [Tu Negocio].\nTu tono es elegante, sofisticado y exclusivo. Cuida cada palabra.\n\nSaludo inicial: "Bienvenido/a. En [Tu Negocio] nos complace asesorarle personalmente."\nDespedida: "Ha sido un honor. Quedamos a su disposición."\n\nDestaca la exclusividad y calidad de cada producto. Nunca menciones precios sin antes presentar el valor.`,
}

export default function BotPrompt() {
  const isOwner = session.user?.role === 'owner'
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: () => api<Policies>('/api/client/policies') })
  const [draft, setDraft] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const value = draft ?? data?.bot_prompt ?? ''

  const mSave = useMutation({
    mutationFn: () => api('/api/client/policies', { method: 'PUT', body: JSON.stringify({ bot_prompt: value }) }),
    onSuccess: () => setMsg('✓ Prompt guardado — el bot ya responde con esto'),
    onError: (e) => setMsg(`✗ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (!isOwner) return <Locked />
  if (isLoading) return <p className="text-muted-foreground">Cargando…</p>

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Prompt del Bot</h1>
        <p className="text-sm text-muted-foreground">Personalidad, tono y saludo de tu bot + las políticas con las que responde</p>
      </div>

      {/* Card de ayuda del viejo */}
      <div className="rounded-xl border border-lime-300 bg-gradient-to-br from-lime-50 to-lime-100 p-4 mb-4 max-w-2xl flex gap-3">
        <Lightbulb className="w-5 h-5 shrink-0 text-lime-700" />
        <div className="text-xs leading-relaxed text-lime-900">
          <div className="font-bold uppercase tracking-wide text-lime-800 mb-1">¿Qué escribir aquí?</div>
          Define <strong>cómo quieres que suene tu bot</strong>: su nombre, cómo saluda, el tono (formal, amigable, elegante), qué puede y no puede decir.<br />
          <span className="opacity-80">Ejemplo: <em>"Eres Sofía, asistente de Perfumes Elite. Habla con elegancia y discreción. Siempre saluda con '¡Bienvenido a Perfumes Elite!' y trata al cliente de 'usted'."</em></span>
        </div>
      </div>
      <Card className="p-5 max-w-2xl gap-0">
        <label className="text-xs font-medium text-muted-foreground">Instrucciones de personalidad y saludo</label>
        <Textarea rows={12} value={value} onChange={e => setDraft(e.target.value)} className="w-full"
          placeholder={'Eres [nombre del asistente], el asistente virtual de [tu negocio]. Tu tono es [amigable / formal / elegante].\n\nSiempre saluda con: "[tu saludo personalizado]"\n\nCuando el cliente se despide, responde con: "[tu despedida]"\n\nNunca hables de [lo que quieres evitar].\nSiempre ofrece [algo que quieras destacar].'} />
        <div className="flex gap-2 flex-wrap mt-2">
          <Button variant="outline" size="sm" onClick={() => setDraft(TEMPLATES.formal)}><span className="inline-flex items-center gap-1"><ClipboardList className="w-3.5 h-3.5" /> Plantilla formal</span></Button>
          <Button variant="outline" size="sm" onClick={() => setDraft(TEMPLATES.casual)}><span className="inline-flex items-center gap-1"><Smile className="w-3.5 h-3.5" /> Plantilla casual</span></Button>
          <Button variant="outline" size="sm" onClick={() => setDraft(TEMPLATES.luxury)}><span className="inline-flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> Plantilla lujo</span></Button>
        </div>
        <div className="flex justify-end mt-3">
          <Button onClick={() => mSave.mutate()} disabled={draft === null || mSave.isPending}>
            {mSave.isPending ? 'Guardando…' : 'Guardar prompt'}
          </Button>
        </div>
        {msg && <p className="text-sm text-muted-foreground mt-2">{msg}</p>}
      </Card>

      {/* Políticas del bot (unidas aquí por decisión del usuario 2026-07-10) */}
      <PoliciesCard />
    </div>
  )
}

function PoliciesCard() {
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: () => api<Policies>('/api/client/policies') })
  const [draft, setDraft] = useState<Policies | null>(null)
  const [msg, setMsg] = useState('')
  const f = draft ?? data
  const input = 'w-full rounded-lg border border-input px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

  const mSave = useMutation({
    mutationFn: () => api('/api/client/policies', { method: 'PUT', body: JSON.stringify({
      shipping: f?.shipping ?? null, returns: f?.returns ?? null,
      discounts: f?.discounts ?? null, bot_instructions: f?.bot_instructions ?? null,
    }) }),
    onSuccess: () => setMsg('✓ Políticas guardadas — el bot ya responde con esto'),
    onError: (e) => setMsg(`✗ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (isLoading || !f) return null
  const set = (k: keyof Policies) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...f, [k]: e.target.value })

  return (
    <Card className="p-5 max-w-2xl mt-5 gap-0">
      <h2 className="font-semibold text-foreground mb-1">Políticas del bot</h2>
      <p className="text-xs text-muted-foreground mb-3">El bot responde usando esta información</p>
      <div className="space-y-3">
        <div><label className="text-xs font-medium text-muted-foreground">Envíos</label><Textarea className={input} rows={3} value={f.shipping ?? ''} onChange={set('shipping')} /></div>
        <div><label className="text-xs font-medium text-muted-foreground">Devoluciones</label><Textarea className={input} rows={3} value={f.returns ?? ''} onChange={set('returns')} /></div>
        <div><label className="text-xs font-medium text-muted-foreground">Descuentos</label><Textarea className={input} rows={3} value={f.discounts ?? ''} onChange={set('discounts')} /></div>
        <div><label className="text-xs font-medium text-muted-foreground">Instrucciones especiales para el bot</label><Textarea className={input} rows={4} value={f.bot_instructions ?? ''} onChange={set('bot_instructions')} /></div>
      </div>
      <div className="flex justify-end mt-3">
        <Button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}>
          {mSave.isPending ? 'Guardando…' : 'Guardar políticas'}
        </Button>
      </div>
      {msg && <p className="text-sm text-muted-foreground mt-2">{msg}</p>}
    </Card>
  )
}
