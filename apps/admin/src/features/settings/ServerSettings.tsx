import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as cfg from './api'
import { Bot as BotIcon, Cloud, Plug, Search } from 'lucide-react'

// Configuración del servidor — paridad con el panel viejo:
// proveedor de IA global + keys (verificables), Cloudinary (verificable),
// Telegram/Retell, y túnel público con URLs de webhooks listas para copiar.

const input = 'w-full rounded-lg bg-muted border border-input text-foreground px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const label = 'text-xs font-medium text-muted-foreground'
const card = 'bg-card rounded-xl border p-5 mb-5'

const AI_FIELDS: Record<string, { key: string; label: string; ph: string }> = {
  groq:     { key: 'groq_api_key',      label: 'Groq API Key',      ph: 'gsk_…' },
  deepseek: { key: 'deepseek_api_key',  label: 'DeepSeek API Key',  ph: 'sk-…' },
  gemini:   { key: 'gemini_api_key',    label: 'Gemini API Key',    ph: 'AIzaSy…' },
  claude:   { key: 'anthropic_api_key', label: 'Anthropic API Key', ph: 'sk-ant-api03-…' },
  openai:   { key: 'openai_api_key',    label: 'OpenAI API Key',    ph: 'sk-proj-…' },
}


export default function ServerSettings() {
  const qc = useQueryClient()
  const { data: saved = {} } = useQuery({ queryKey: ['adm-settings'], queryFn: cfg.getServerSettings })

  // Solo lo que el admin ESCRIBE se guarda; lo vacío no pisa keys existentes
  const [f, setF] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState('')
  const [aiMsg, setAiMsg] = useState('')
  const [cldMsg, setCldMsg] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
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


  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground mb-1">Configuración del servidor</h1>
      <p className="text-sm text-muted-foreground mb-6">Keys globales de IA, Cloudinary y conexiones. Las keys guardadas se muestran enmascaradas.</p>

      {/* IA global */}
      <section className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><BotIcon className="w-4 h-4" /> Proveedor de IA activo (global)</h2>
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
            <span className={label}>{aiField.label} {saved[aiField.key] && <em className="text-muted-foreground not-italic">— guardada: {saved[aiField.key]}</em>}</span>
            <input className={input} type="password" value={val(aiField.key)} onChange={set(aiField.key)} placeholder={saved[aiField.key] || aiField.ph} />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button onClick={verifyAI} className="rounded-lg border border-input text-foreground/80 text-xs px-3 py-1.5 hover:bg-muted"><span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar conexión</span></button>
          <span className="text-xs text-foreground/80">{aiMsg || 'Ingresa la key (o usa la guardada) y verifica'}</span>
        </div>
      </section>

      {/* Cloudinary */}
      <section className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Cloud className="w-4 h-4" /> Cloudinary — Imágenes y videos</h2>
        <div className="grid grid-cols-3 gap-3">
          <div><span className={label}>Cloud name {saved.cloudinary_cloud_name && <em className="text-muted-foreground not-italic">— {saved.cloudinary_cloud_name}</em>}</span>
            <input className={input} value={val('cloudinary_cloud_name')} onChange={set('cloudinary_cloud_name')} placeholder={saved.cloudinary_cloud_name || 'tu-cloud-name'} /></div>
          <div><span className={label}>API Key</span>
            <input className={input} value={val('cloudinary_api_key')} onChange={set('cloudinary_api_key')} placeholder={saved.cloudinary_api_key || '123456789012345'} /></div>
          <div><span className={label}>API Secret</span>
            <input className={input} type="password" value={val('cloudinary_api_secret')} onChange={set('cloudinary_api_secret')} placeholder={saved.cloudinary_api_secret || '••••••••'} /></div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button onClick={verifyCloudinary} className="rounded-lg border border-input text-foreground/80 text-xs px-3 py-1.5 hover:bg-muted"><span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar conexión</span></button>
          <span className="text-xs text-foreground/80">{cldMsg || 'Guarda o ingresa las llaves y verifica'}</span>
        </div>
      </section>

      {/* Otras conexiones */}
      <section className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Plug className="w-4 h-4" /> Otras conexiones</h2>
        <div className="grid grid-cols-2 gap-3">
          <div><span className={label}>Telegram Bot Token (global) {saved.telegram_bot_token && <em className="text-muted-foreground not-italic">— guardado</em>}</span>
            <input className={input} type="password" value={val('telegram_bot_token')} onChange={set('telegram_bot_token')} placeholder={saved.telegram_bot_token || '1234567890:ABC…'} /></div>
          <div><span className={label}>Retell API Key (voz) {saved.retell_api_key && <em className="text-muted-foreground not-italic">— guardada</em>}</span>
            <input className={input} type="password" value={val('retell_api_key')} onChange={set('retell_api_key')} placeholder={saved.retell_api_key || 'key_…'} /></div>
        </div>
      </section>

      <div className="flex items-center gap-3 mb-8">
        <button onClick={save} disabled={busy}
          className="rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-semibold px-5 py-2 text-sm">
          Guardar configuración
        </button>
        <span className="text-sm text-foreground/80">{saveMsg}</span>
      </div>

    </div>
  )
}
