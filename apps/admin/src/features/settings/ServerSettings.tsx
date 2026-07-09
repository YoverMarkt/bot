import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as cfg from './api'

// Configuración del servidor — paridad con el panel viejo:
// proveedor de IA global + keys (verificables), Cloudinary (verificable),
// Telegram/Retell, y túnel público con URLs de webhooks listas para copiar.

const input = 'w-full rounded-lg bg-stone-800 border border-stone-700 text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'
const label = 'text-xs font-medium text-stone-400'
const card = 'bg-stone-900 rounded-xl border border-stone-800 p-5 mb-5'

const AI_FIELDS: Record<string, { key: string; label: string; ph: string }> = {
  groq:     { key: 'groq_api_key',      label: 'Groq API Key',      ph: 'gsk_…' },
  deepseek: { key: 'deepseek_api_key',  label: 'DeepSeek API Key',  ph: 'sk-…' },
  gemini:   { key: 'gemini_api_key',    label: 'Gemini API Key',    ph: 'AIzaSy…' },
  claude:   { key: 'anthropic_api_key', label: 'Anthropic API Key', ph: 'sk-ant-api03-…' },
  openai:   { key: 'openai_api_key',    label: 'OpenAI API Key',    ph: 'sk-proj-…' },
}

// URLs de webhooks por proveedor (mismas del panel viejo)
const WH_PROVIDERS = [
  { name: 'YCloud',        path: '/webhook/ycloud',         desc: 'YCloud → Webhooks → Add Endpoint', secret: true },
  { name: 'Kapso',         path: '/webhook/kapso',          desc: 'Kapso → Configuración → Webhook URL', secret: true },
  { name: 'Meta',          path: '/webhook',                desc: 'Meta → App → WhatsApp → Webhook URL' },
  { name: 'Retell LLM',    path: '/api/retell/llm',         desc: 'Retell → Agent → Custom LLM URL' },
  { name: 'Retell Events', path: '/api/retell/call-events', desc: 'Retell → Agent → Call Events URL' },
]

export default function ServerSettings() {
  const qc = useQueryClient()
  const { data: saved = {} } = useQuery({ queryKey: ['adm-settings'], queryFn: cfg.getServerSettings })
  const { data: tunnel } = useQuery({ queryKey: ['adm-tunnel'], queryFn: cfg.getTunnel })

  // Solo lo que el admin ESCRIBE se guarda; lo vacío no pisa keys existentes
  const [f, setF] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState('')
  const [aiMsg, setAiMsg] = useState('')
  const [cldMsg, setCldMsg] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [tunnelMsg, setTunnelMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const activeProvider = provider || saved.ai_provider || 'claude'
  const aiField = AI_FIELDS[activeProvider] ?? AI_FIELDS.claude
  const val = (k: string) => f[k] ?? ''
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF(p => ({ ...p, [k]: e.target.value }))

  async function verifyAI() {
    setAiMsg('⏳ Verificando…')
    try {
      const r = await cfg.verifyAI({ provider: activeProvider, [aiField.key]: val(aiField.key) || undefined })
      setAiMsg(`${r.ok ? '✅' : '❌'} ${r.info}`)
    } catch (e) { setAiMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`) }
  }

  async function verifyCloudinary() {
    setCldMsg('⏳ Verificando…')
    try {
      const r = await cfg.verifyCloudinary({
        cloudinary_cloud_name: val('cloudinary_cloud_name') || undefined,
        cloudinary_api_key: val('cloudinary_api_key') || undefined,
        cloudinary_api_secret: val('cloudinary_api_secret') || undefined,
      })
      setCldMsg(`${r.ok ? '✅' : '❌'} ${r.info}`)
    } catch (e) { setCldMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`) }
  }

  async function save() {
    setBusy(true); setSaveMsg('Guardando…')
    const payload: Record<string, string> = { ai_provider: activeProvider }
    for (const [k, v] of Object.entries(f)) if (v.trim()) payload[k] = v.trim()
    try {
      await cfg.saveServerSettings(payload)
      setSaveMsg('✅ Guardado correctamente')
      setF({}) // limpiar campos: las keys quedan enmascaradas del server
      qc.invalidateQueries({ queryKey: ['adm-settings'] })
    } catch (e) { setSaveMsg(`❌ ${e instanceof Error ? e.message : 'Error al guardar'}`) }
    setBusy(false)
  }

  async function tunnelStart() {
    setTunnelMsg('⏳ Iniciando túnel (puede tardar ~15s)…')
    try {
      await cfg.startTunnel()
      setTunnelMsg('')
      qc.invalidateQueries({ queryKey: ['adm-tunnel'] })
    } catch (e) { setTunnelMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`) }
  }

  async function tunnelStop() {
    await cfg.stopTunnel()
    setTunnelMsg('🔌 Túnel detenido')
    qc.invalidateQueries({ queryKey: ['adm-tunnel'] })
  }

  const copy = (url: string) => navigator.clipboard.writeText(url)
  const base = tunnel?.active && tunnel.url ? tunnel.url.replace(/\/$/, '') : null

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-white mb-1">Configuración del servidor</h1>
      <p className="text-sm text-stone-400 mb-6">Keys globales de IA, Cloudinary y conexiones. Las keys guardadas se muestran enmascaradas.</p>

      {/* IA global */}
      <section className={card}>
        <h2 className="text-sm font-semibold text-white mb-3">🤖 Proveedor de IA activo (global)</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>Proveedor</span>
            <select className={input} value={activeProvider} onChange={e => setProvider(e.target.value)}>
              <option value="groq">Groq (Llama) — rápido y barato</option>
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Gemini</option>
              <option value="claude">Claude</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
          <div>
            <span className={label}>{aiField.label} {saved[aiField.key] && <em className="text-stone-500 not-italic">— guardada: {saved[aiField.key]}</em>}</span>
            <input className={input} type="password" value={val(aiField.key)} onChange={set(aiField.key)} placeholder={saved[aiField.key] || aiField.ph} />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button onClick={verifyAI} className="rounded-lg border border-stone-700 text-stone-300 text-xs px-3 py-1.5 hover:bg-stone-800">🔍 Verificar conexión</button>
          <span className="text-xs text-stone-300">{aiMsg || 'Ingresa la key (o usa la guardada) y verifica'}</span>
        </div>
      </section>

      {/* Cloudinary */}
      <section className={card}>
        <h2 className="text-sm font-semibold text-white mb-3">☁️ Cloudinary — Imágenes y videos</h2>
        <div className="grid grid-cols-3 gap-3">
          <div><span className={label}>Cloud name {saved.cloudinary_cloud_name && <em className="text-stone-500 not-italic">— {saved.cloudinary_cloud_name}</em>}</span>
            <input className={input} value={val('cloudinary_cloud_name')} onChange={set('cloudinary_cloud_name')} placeholder={saved.cloudinary_cloud_name || 'tu-cloud-name'} /></div>
          <div><span className={label}>API Key</span>
            <input className={input} value={val('cloudinary_api_key')} onChange={set('cloudinary_api_key')} placeholder={saved.cloudinary_api_key || '123456789012345'} /></div>
          <div><span className={label}>API Secret</span>
            <input className={input} type="password" value={val('cloudinary_api_secret')} onChange={set('cloudinary_api_secret')} placeholder={saved.cloudinary_api_secret || '••••••••'} /></div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button onClick={verifyCloudinary} className="rounded-lg border border-stone-700 text-stone-300 text-xs px-3 py-1.5 hover:bg-stone-800">🔍 Verificar conexión</button>
          <span className="text-xs text-stone-300">{cldMsg || 'Guarda o ingresa las llaves y verifica'}</span>
        </div>
      </section>

      {/* Otras conexiones */}
      <section className={card}>
        <h2 className="text-sm font-semibold text-white mb-3">🔌 Otras conexiones</h2>
        <div className="grid grid-cols-2 gap-3">
          <div><span className={label}>Telegram Bot Token (global) {saved.telegram_bot_token && <em className="text-stone-500 not-italic">— guardado</em>}</span>
            <input className={input} type="password" value={val('telegram_bot_token')} onChange={set('telegram_bot_token')} placeholder={saved.telegram_bot_token || '1234567890:ABC…'} /></div>
          <div><span className={label}>Retell API Key (voz) {saved.retell_api_key && <em className="text-stone-500 not-italic">— guardada</em>}</span>
            <input className={input} type="password" value={val('retell_api_key')} onChange={set('retell_api_key')} placeholder={saved.retell_api_key || 'key_…'} /></div>
        </div>
      </section>

      <div className="flex items-center gap-3 mb-8">
        <button onClick={save} disabled={busy}
          className="rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
          Guardar configuración
        </button>
        <span className="text-sm text-stone-300">{saveMsg}</span>
      </div>

      {/* Túnel + webhooks */}
      <section className={card}>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">🌐 Túnel público / URL del servidor</h2>
            <div className={`font-mono text-sm mt-1 break-all ${base ? 'text-green-400' : 'text-stone-600'}`}>
              {base || 'Sin túnel activo'}
            </div>
            {tunnel?.active && <div className="text-xs text-stone-500 mt-0.5">✅ Activo — {tunnel.provider}</div>}
          </div>
          {tunnel?.active
            ? <button onClick={tunnelStop} className="rounded-lg border border-stone-700 text-stone-300 text-xs px-3 py-1.5 hover:bg-stone-800">⏹ Detener túnel</button>
            : <button onClick={tunnelStart} className="rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-semibold px-3 py-1.5">▶️ Iniciar túnel</button>}
        </div>
        {tunnelMsg && <p className="text-xs text-stone-400 mb-2">{tunnelMsg}</p>}

        {base && (
          <div className="mt-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-stone-500">URLs de webhooks (copiar y pegar en cada proveedor)</div>
            {WH_PROVIDERS.map(p => {
              const url = base + p.path + (p.secret && tunnel?.webhookSecret ? `?secret=${tunnel.webhookSecret}` : '')
              return (
                <div key={p.name} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0 w-24 text-center rounded bg-stone-800 border border-stone-700 text-stone-300 px-2 py-1">{p.name}</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-stone-400" title={url}>{url}</span>
                  <button onClick={() => copy(url)} className="shrink-0 rounded border border-stone-700 text-stone-300 px-2 py-1 hover:bg-stone-800">Copiar</button>
                  <span className="shrink-0 hidden lg:inline text-stone-600">{p.desc}</span>
                </div>
              )
            })}
          </div>
        )}
        <p className="text-[11px] text-stone-600 mt-3">En producción con BASE_URL configurada, la URL es fija y el túnel no se usa.</p>
      </section>
    </div>
  )
}
