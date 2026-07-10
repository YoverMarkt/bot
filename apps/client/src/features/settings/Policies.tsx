import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, session } from '../../api/client'
import { Locked } from './Settings'

// ── Políticas del bot (sección propia, igual que el panel viejo) ──
type Policies = { shipping?: string | null; returns?: string | null; discounts?: string | null; bot_instructions?: string | null }

const input = 'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

export default function PoliciesPage() {
  const isOwner = session.user?.role === 'owner'
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: () => api<Policies>('/api/client/policies') })
  const [draft, setDraft] = useState<Policies | null>(null)
  const [msg, setMsg] = useState('')
  const f = draft ?? data

  const mSave = useMutation({
    mutationFn: () => api('/api/client/policies', { method: 'PUT', body: JSON.stringify({
      shipping: f?.shipping ?? null, returns: f?.returns ?? null,
      discounts: f?.discounts ?? null, bot_instructions: f?.bot_instructions ?? null,
    }) }),
    onSuccess: () => setMsg('✅ Políticas guardadas — el bot ya responde con esto'),
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (!isOwner) return <Locked />
  if (isLoading || !f) return <p className="text-stone-500">Cargando…</p>
  const set = (k: keyof Policies) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...f, [k]: e.target.value })

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-stone-900">Políticas del bot</h1>
        <p className="text-sm text-stone-500">Envíos, devoluciones, descuentos e instrucciones extra</p>
      </div>
      <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-2xl">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs font-medium text-stone-600">🚚 Envíos</label><textarea className={input} rows={3} value={f.shipping ?? ''} onChange={set('shipping')} /></div>
          <div><label className="text-xs font-medium text-stone-600">↩️ Devoluciones</label><textarea className={input} rows={3} value={f.returns ?? ''} onChange={set('returns')} /></div>
          <div><label className="text-xs font-medium text-stone-600">🏷️ Descuentos (informativo)</label><textarea className={input} rows={3} value={f.discounts ?? ''} onChange={set('discounts')} /></div>
          <div><label className="text-xs font-medium text-stone-600">📌 Instrucciones extra</label><textarea className={input} rows={3} value={f.bot_instructions ?? ''} onChange={set('bot_instructions')} /></div>
        </div>
        <div className="flex justify-end mt-3">
          <button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}
            className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
            {mSave.isPending ? 'Guardando…' : 'Guardar políticas'}
          </button>
        </div>
        {msg && <p className="text-sm text-stone-600 mt-2">{msg}</p>}
      </div>
    </div>
  )
}
