import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, session } from '../../api/client'
import { Locked } from './Settings'

// ── Prompt del Bot (sección propia, igual que el panel viejo) ──
type Policies = { bot_prompt?: string | null; shipping?: string | null; returns?: string | null; discounts?: string | null; bot_instructions?: string | null }

// Plantillas del panel viejo (TEMPLATES)
const TEMPLATES = {
  formal: `Eres [Nombre], el asistente virtual oficial de [Tu Negocio].\nTu tono es profesional y cortés. Siempre trata al cliente de "usted".\n\nSaludo inicial: "Bienvenido/a a [Tu Negocio], ¿en qué puedo asistirle hoy?"\nDespedida: "Ha sido un placer atenderle. Que tenga un excelente día."\n\nEvita expresiones informales o abreviaciones.`,
  casual: `Eres [Nombre], el asistente amigable de [Tu Negocio] 😊\nTu tono es cercano, divertido y entusiasta. Usa emojis con moderación.\n\nSaludo inicial: "¡Hola! 👋 Bienvenido/a a [Tu Negocio], ¿en qué te puedo ayudar?"\nDespedida: "¡Fue un gusto ayudarte! No dudes en escribirnos cuando quieras 🙌"\n\nSé natural y evita sonar como un robot.`,
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
    onSuccess: () => setMsg('✅ Prompt guardado — el bot ya responde con esto'),
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (!isOwner) return <Locked />
  if (isLoading) return <p className="text-stone-500">Cargando…</p>

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-stone-900">Prompt del Bot</h1>
        <p className="text-sm text-stone-500">Personalidad, tono y saludo de tu bot + las políticas con las que responde</p>
      </div>

      {/* Card de ayuda del viejo */}
      <div className="rounded-xl border border-lime-300 bg-gradient-to-br from-lime-50 to-lime-100 p-4 mb-4 max-w-2xl flex gap-3">
        <div className="text-xl shrink-0">💡</div>
        <div className="text-xs leading-relaxed text-lime-900">
          <div className="font-bold uppercase tracking-wide text-lime-800 mb-1">¿Qué escribir aquí?</div>
          Define <strong>cómo quieres que suene tu bot</strong>: su nombre, cómo saluda, el tono (formal, amigable, elegante), qué puede y no puede decir.<br />
          <span className="opacity-80">Ejemplo: <em>"Eres Sofía, asistente de Perfumes Elite. Habla con elegancia y discreción. Siempre saluda con '¡Bienvenido a Perfumes Elite!' y trata al cliente de 'usted'."</em></span>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-2xl">
        <label className="text-xs font-medium text-stone-600">Instrucciones de personalidad y saludo</label>
        <textarea rows={12} value={value} onChange={e => setDraft(e.target.value)}
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder={'Eres [nombre del asistente], el asistente virtual de [tu negocio]. Tu tono es [amigable / formal / elegante].\n\nSiempre saluda con: "[tu saludo personalizado]"\n\nCuando el cliente se despide, responde con: "[tu despedida]"\n\nNunca hables de [lo que quieres evitar].\nSiempre ofrece [algo que quieras destacar].'} />
        <div className="flex gap-2 flex-wrap mt-2">
          <button onClick={() => setDraft(TEMPLATES.formal)} className="text-[11px] rounded-lg border border-stone-200 px-2.5 py-1 hover:bg-stone-50">📋 Plantilla formal</button>
          <button onClick={() => setDraft(TEMPLATES.casual)} className="text-[11px] rounded-lg border border-stone-200 px-2.5 py-1 hover:bg-stone-50">😊 Plantilla casual</button>
          <button onClick={() => setDraft(TEMPLATES.luxury)} className="text-[11px] rounded-lg border border-stone-200 px-2.5 py-1 hover:bg-stone-50">✨ Plantilla lujo</button>
        </div>
        <div className="flex justify-end mt-3">
          <button onClick={() => mSave.mutate()} disabled={draft === null || mSave.isPending}
            className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
            {mSave.isPending ? 'Guardando…' : 'Guardar prompt'}
          </button>
        </div>
        {msg && <p className="text-sm text-stone-600 mt-2">{msg}</p>}
      </div>

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
  const input = 'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

  const mSave = useMutation({
    mutationFn: () => api('/api/client/policies', { method: 'PUT', body: JSON.stringify({
      shipping: f?.shipping ?? null, returns: f?.returns ?? null,
      discounts: f?.discounts ?? null, bot_instructions: f?.bot_instructions ?? null,
    }) }),
    onSuccess: () => setMsg('✅ Políticas guardadas — el bot ya responde con esto'),
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (isLoading || !f) return null
  const set = (k: keyof Policies) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...f, [k]: e.target.value })

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-2xl mt-5">
      <h2 className="font-semibold text-stone-900 mb-1">Políticas del bot</h2>
      <p className="text-xs text-stone-500 mb-3">El bot responde usando esta información</p>
      <div className="space-y-3">
        <div><label className="text-xs font-medium text-stone-600">Envíos</label><textarea className={input} rows={3} value={f.shipping ?? ''} onChange={set('shipping')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Devoluciones</label><textarea className={input} rows={3} value={f.returns ?? ''} onChange={set('returns')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Descuentos</label><textarea className={input} rows={3} value={f.discounts ?? ''} onChange={set('discounts')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Instrucciones especiales para el bot</label><textarea className={input} rows={4} value={f.bot_instructions ?? ''} onChange={set('bot_instructions')} /></div>
      </div>
      <div className="flex justify-end mt-3">
        <button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}
          className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
          {mSave.isPending ? 'Guardando…' : 'Guardar políticas'}
        </button>
      </div>
      {msg && <p className="text-sm text-stone-600 mt-2">{msg}</p>}
    </div>
  )
}
