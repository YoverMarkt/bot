import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, session } from '../../api/client'
import { Locked } from './Settings'

// ── Prompt del Bot (sección propia, igual que el panel viejo) ──
type Policies = { bot_prompt?: string | null }

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
        <p className="text-sm text-stone-500">La personalidad y forma de atender de tu bot</p>
      </div>
      <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-2xl">
        <textarea rows={18} value={value} onChange={e => setDraft(e.target.value)}
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="Eres el asistente virtual de…" />
        <p className="text-[11px] text-stone-400 mt-1">⚠️ El prompt es la personalidad; los precios, totales y descuentos SIEMPRE los calcula el sistema.</p>
        <div className="flex justify-end mt-3">
          <button onClick={() => mSave.mutate()} disabled={draft === null || mSave.isPending}
            className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
            {mSave.isPending ? 'Guardando…' : 'Guardar prompt'}
          </button>
        </div>
        {msg && <p className="text-sm text-stone-600 mt-2">{msg}</p>}
      </div>
    </div>
  )
}
