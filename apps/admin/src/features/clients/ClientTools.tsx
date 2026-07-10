import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as adm from './api'
import type { BusinessRow } from './api'

// ── Herramientas por negocio (paridad con el admin viejo):
// 👁 Ver negocio (datos + estadísticas + últimas conversaciones)
// 🤖 Prompt del Bot por negocio (con plantillas formal/casual/luxury)

const modalBg = 'fixed inset-0 z-30 bg-black/60 flex items-start justify-center overflow-y-auto p-4'
const modalBox = 'w-full max-w-2xl bg-stone-900 border border-stone-800 rounded-2xl p-6 my-8'

export function ViewModal({ c, onClose }: { c: BusinessRow; onClose: () => void }) {
  const { data: prods = [] } = useQuery({ queryKey: ['adm-cprods', c.id], queryFn: () => adm.getClientProducts(c.id) })
  const { data: convs = [] } = useQuery({ queryKey: ['adm-cconvs', c.id], queryFn: () => adm.getClientConversations(c.id) })
  const { data: pol } = useQuery({ queryKey: ['adm-cpol', c.id], queryFn: () => adm.getClientPolicies(c.id) })

  return (
    <div className={modalBg} onClick={onClose}>
      <div className={modalBox} onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-white mb-4">{c.name}</h2>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-xl bg-stone-800/60 p-4 text-sm text-stone-300 space-y-1">
            <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">Negocio</div>
            <div><strong className="text-stone-200">Tipo:</strong> {c.type || '—'}</div>
            <div><strong className="text-stone-200">Número:</strong> {c.whatsapp_number || '—'}</div>
            <div><strong className="text-stone-200">Plan:</strong> <span className="capitalize">{c.plan || '—'}</span></div>
            <div><strong className="text-stone-200">Estado:</strong> {c.suspended ? '⛔ Suspendido' : '✅ Activo'}</div>
          </div>
          <div className="rounded-xl bg-stone-800/60 p-4 text-sm text-stone-300 space-y-1">
            <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">Estadísticas</div>
            <div><strong className="text-stone-200">Productos:</strong> {prods.length}</div>
            <div><strong className="text-stone-200">Conversaciones:</strong> {convs.length}</div>
            <div><strong className="text-stone-200">Envíos:</strong> {pol?.shipping ? 'Configurado' : 'Sin configurar'}</div>
          </div>
        </div>
        <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">Últimas conversaciones</div>
        <div className="max-h-64 overflow-y-auto space-y-2">
          {convs.length === 0 && <p className="text-sm text-stone-500">Sin mensajes todavía.</p>}
          {convs.slice(0, 20).map((m, i) => (
            <div key={i} className="rounded-lg bg-stone-800/40 px-3 py-2 text-sm">
              <div className={`text-[11px] font-semibold mb-0.5 ${m.role === 'user' ? 'text-blue-400' : 'text-green-400'}`}>
                {m.role === 'user' ? `📱 ${m.contact_phone}` : '🤖 Bot'}
              </div>
              <div className="text-stone-300 whitespace-pre-wrap break-words">{(m.content || '').slice(0, 300)}</div>
            </div>
          ))}
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="rounded-lg border border-stone-700 text-stone-300 px-4 py-2 text-sm hover:bg-stone-800">Cerrar</button>
        </div>
      </div>
    </div>
  )
}

// Mismas plantillas del admin viejo
const BPM_TEMPLATES: Record<string, string> = {
  formal: `Eres [Nombre], el asistente virtual oficial de [Negocio].\nTu tono es profesional y cortés. Siempre trata al cliente de "usted".\n\nSaludo: "Bienvenido/a a [Negocio], ¿en qué puedo asistirle hoy?"\nDespedida: "Ha sido un placer atenderle. Que tenga un excelente día."`,
  casual: `Eres [Nombre], el asistente de [Negocio] 😊\nTu tono es cercano y entusiasta. Usa emojis con moderación.\n\nSaludo: "¡Hola! 👋 Bienvenido/a a [Negocio], ¿en qué te puedo ayudar?"\nDespedida: "¡Fue un gusto ayudarte! Escríbenos cuando quieras 🙌"`,
  luxury: `Eres [Nombre], asesor/a de lujo de [Negocio].\nTu tono es elegante y sofisticado. Cuida cada palabra.\n\nSaludo: "Bienvenido/a. En [Negocio] nos complace asesorarle personalmente."\nDespedida: "Ha sido un honor. Quedamos a su disposición."\n\nDestaca la exclusividad de cada producto. Nunca menciones precios sin antes presentar el valor.`,
}

export function PromptModal({ c, onClose }: { c: BusinessRow; onClose: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adm.getClientPolicies(c.id).then(d => setPrompt(d.bot_prompt || '')).catch(() => {})
  }, [c.id])

  async function save() {
    setSaving(true); setMsg('')
    try {
      await adm.saveClientPolicies(c.id, { bot_prompt: prompt })
      setMsg('✅ Prompt guardado')
      setTimeout(onClose, 800)
    } catch (e) { setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`) }
    setSaving(false)
  }

  return (
    <div className={modalBg} onClick={onClose}>
      <div className={modalBox} onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-white">Prompt del Bot</h2>
        <p className="text-sm text-stone-400 mb-3">{c.name}</p>
        <div className="flex gap-2 mb-2">
          {Object.keys(BPM_TEMPLATES).map(t => (
            <button key={t} onClick={() => setPrompt(BPM_TEMPLATES[t])}
              className="rounded-lg border border-stone-700 text-stone-300 text-xs px-2.5 py-1 capitalize hover:bg-stone-800">
              Plantilla {t}
            </button>
          ))}
        </div>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={14}
          className="w-full rounded-lg bg-stone-800 border border-stone-700 text-white px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="Eres el asistente virtual de…" />
        <p className="text-[11px] text-stone-500 mt-1">⚠️ El prompt es la personalidad; precios y totales SIEMPRE los calcula el sistema.</p>
        <div className="flex items-center justify-end gap-3 mt-3">
          {msg && <span className="text-sm text-stone-300">{msg}</span>}
          <button onClick={onClose} className="rounded-lg border border-stone-700 text-stone-300 px-4 py-2 text-sm hover:bg-stone-800">Cancelar</button>
          <button onClick={save} disabled={saving}
            className="rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
            {saving ? 'Guardando…' : 'Guardar prompt'}
          </button>
        </div>
      </div>
    </div>
  )
}
