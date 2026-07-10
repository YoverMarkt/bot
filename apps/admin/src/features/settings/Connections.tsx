import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as cfg from './api'

// ── Conexiones (sección propia, igual que el admin viejo):
// túnel público + URLs de webhooks por proveedor listas para copiar.
const card = 'bg-card rounded-xl border p-5 mb-5'

const WH_PROVIDERS = [
  { name: 'YCloud',        path: '/webhook/ycloud',         desc: 'YCloud → Webhooks → Add Endpoint', secret: true },
  { name: 'Kapso',         path: '/webhook/kapso',          desc: 'Kapso → Configuración → Webhook URL', secret: true },
  { name: 'Meta',          path: '/webhook',                desc: 'Meta → App → WhatsApp → Webhook URL' },
  { name: 'Retell LLM',    path: '/api/retell/llm',         desc: 'Retell → Agent → Custom LLM URL' },
  { name: 'Retell Events', path: '/api/retell/call-events', desc: 'Retell → Agent → Call Events URL' },
]

export default function Connections() {
  const qc = useQueryClient()
  const { data: tunnel } = useQuery({ queryKey: ['adm-tunnel'], queryFn: cfg.getTunnel })
  const [msg, setMsg] = useState('')

  async function start() {
    setMsg('⏳ Iniciando túnel (puede tardar ~15s)…')
    try { await cfg.startTunnel(); setMsg(''); qc.invalidateQueries({ queryKey: ['adm-tunnel'] }) }
    catch (e) { setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`) }
  }
  async function stop() {
    await cfg.stopTunnel(); setMsg('🔌 Túnel detenido')
    qc.invalidateQueries({ queryKey: ['adm-tunnel'] })
  }
  const copy = (url: string) => navigator.clipboard.writeText(url)
  const base = tunnel?.active && tunnel.url ? tunnel.url.replace(/\/$/, '') : null

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground mb-1">Conexiones</h1>
      <p className="text-sm text-muted-foreground mb-6">Túnel público y URLs de webhooks para cada proveedor.</p>

      <section className={card}>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">🌐 Túnel público / URL del servidor</h2>
            <div className={`font-mono text-sm mt-1 break-all ${base ? 'text-primary' : 'text-muted-foreground/70'}`}>
              {base || 'Sin túnel activo'}
            </div>
            {tunnel?.active && <div className="text-xs text-muted-foreground mt-0.5">✅ Activo — {tunnel.provider}</div>}
          </div>
          {tunnel?.active
            ? <button onClick={stop} className="rounded-lg border border-input text-foreground/80 text-xs px-3 py-1.5 hover:bg-muted">⏹ Detener túnel</button>
            : <button onClick={start} className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold px-3 py-1.5">▶️ Iniciar túnel</button>}
        </div>
        {msg && <p className="text-xs text-muted-foreground mb-2">{msg}</p>}

        {base && (
          <div className="mt-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">URLs de webhooks (copiar y pegar en cada proveedor)</div>
            {WH_PROVIDERS.map(p => {
              const url = base + p.path + (p.secret && tunnel?.webhookSecret ? `?secret=${tunnel.webhookSecret}` : '')
              return (
                <div key={p.name} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0 w-24 text-center rounded bg-muted border border-input text-foreground/80 px-2 py-1">{p.name}</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-muted-foreground" title={url}>{url}</span>
                  <button onClick={() => copy(url)} className="shrink-0 rounded border border-input text-foreground/80 px-2 py-1 hover:bg-muted">Copiar</button>
                  <span className="shrink-0 hidden lg:inline text-muted-foreground/70">{p.desc}</span>
                </div>
              )
            })}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground/70 mt-3">En producción con BASE_URL configurada, la URL es fija y el túnel no se usa.</p>
      </section>
    </div>
  )
}
