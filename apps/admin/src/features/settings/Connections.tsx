import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as cfg from './api'
import { Globe, Square, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'

// ── Conexiones: el túnel público de desarrollo y la URL que hay que pegar en
// YCloud para que el número del marketplace entregue aquí.
//
// ⚠️ Se retiró la fila de Meta el 2026-08-23: ningún negocio usa ese canal —el
// marketplace entra por YCloud— y ofrecer su URL invitaba a configurar un
// webhook que nadie iba a atender. La ruta `/webhook` sigue en el servidor.
const card = 'p-5 mb-5 gap-0'

const WH_PROVIDERS = [
  { name: 'YCloud', path: '/webhook/ycloud', desc: 'YCloud → Developers → Webhooks → Add Endpoint' },
]

export default function Connections() {
  const qc = useQueryClient()
  const { data: tunnel } = useQuery({ queryKey: ['adm-tunnel'], queryFn: cfg.getTunnel })

  async function start() {
    toast.info('Iniciando túnel (puede tardar ~15s)…')
    try { await cfg.startTunnel(); toast.success('Túnel activo'); qc.invalidateQueries({ queryKey: ['adm-tunnel'] }) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Error') }
  }
  async function stop() {
    await cfg.stopTunnel(); toast.success('Túnel detenido')
    qc.invalidateQueries({ queryKey: ['adm-tunnel'] })
  }
  const copy = (url: string) => navigator.clipboard.writeText(url)
  const base = tunnel?.active && tunnel.url ? tunnel.url.replace(/\/$/, '') : null

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-1">Conexiones</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Túnel público de desarrollo y la URL del webhook del número del marketplace.
      </p>

      <Card className={card}>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Globe className="w-4 h-4" /> Túnel público / URL del servidor</h2>
            <div className={`font-mono text-sm mt-1 break-all ${base ? 'text-primary' : 'text-muted-foreground/70'}`}>
              {base || 'Sin túnel activo'}
            </div>
            {tunnel?.active && <div className="text-xs text-muted-foreground mt-0.5">Activo — {tunnel.provider}</div>}
          </div>
          {tunnel?.active
            ? <Button variant="outline" size="sm" onClick={stop}><Square /> Detener túnel</Button>
            : <Button size="sm" onClick={start}><Play /> Iniciar túnel</Button>}
        </div>

        {base && (
          <div className="mt-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">URL del webhook (copiar y pegar en YCloud)</div>
            {WH_PROVIDERS.map(p => {
              const url = base + p.path
              return (
                <div key={p.name} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0 w-24 text-center rounded bg-muted border border-input text-foreground/80 px-2 py-1">{p.name}</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-muted-foreground" title={url}>{url}</span>
                  <Button variant="outline" size="sm" onClick={() => copy(url)} className="shrink-0">Copiar</Button>
                  <span className="shrink-0 hidden lg:inline text-muted-foreground/70">{p.desc}</span>
                </div>
              )
            })}
          </div>
        )}
        {/* ⚠️ Decía «guárdalos en el negocio correspondiente», y eso ya no
            existe: el número es de la PLATAFORMA y sus credenciales viven en
            `server_settings`. Mandar al superadmin a la ficha de un local le
            haría configurar un canal que ese local no puede tener. */}
        <p className="text-[11px] text-muted-foreground/70 mt-3">
          YCloud firma cada solicitud con <code>YCloud-Signature</code>. El Endpoint ID y el
          Signing Secret van en <strong>Configuración → Número del marketplace</strong>:
          sin ellos el servidor rechaza las entregas con 503 y el número queda mudo.
        </p>
        <p className="text-[11px] text-muted-foreground/70 mt-3">En producción con BASE_URL configurada, la URL es fija y el túnel no se usa.</p>
      </Card>
    </div>
  )
}
