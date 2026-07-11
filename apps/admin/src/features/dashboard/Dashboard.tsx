import { useQuery } from '@tanstack/react-query'
import { getStats, getClients } from '../clients/api'

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ['adm-stats'], queryFn: getStats, refetchInterval: 30_000 })
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })

  if (isLoading) return <p className="text-muted-foreground">Cargando…</p>
  if (error) return <p className="text-destructive">✗ {(error as Error).message}</p>
  if (!data) return null

  const cards = [
    { label: 'Total clientes', value: data.totalClients, sub: 'Negocios registrados' },
    { label: 'Activos', value: data.activeClients, sub: 'Bots funcionando' },
    { label: 'Suspendidos', value: data.suspendedClients, sub: 'Pago pendiente' },
    { label: 'Mensajes hoy', value: data.messagesToday, sub: 'En todos los bots' },
  ]

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <h1 className="text-2xl font-bold text-foreground mb-1">Dashboard</h1>
      <p className="text-sm text-muted-foreground mb-6">Visión general de tu negocio</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(c => (
          <div key={c.label} className="bg-card rounded-xl border p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="text-3xl font-bold text-foreground mt-1">{c.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Últimos negocios (renderDashRecent del panel viejo) */}
      <div className="bg-card rounded-xl border p-5 mt-6 flex-1">
        <h2 className="text-sm font-semibold text-foreground mb-2">Clientes recientes</h2>
        {clients.length === 0 && <p className="text-sm text-muted-foreground">Sin clientes aún.</p>}
        {clients.slice(0, 6).map(c => (
          <div key={c.id} className="flex items-center gap-3 py-2.5 border-b border-border/60 last:border-0">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">{c.name}</div>
              <div className="text-xs text-muted-foreground">{c.type || ''} · {c.whatsapp_number || 'sin número'}</div>
            </div>
            {c.suspended
              ? <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-destructive/10 text-destructive">Suspendido</span>
              : !c.bot_active
                ? <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-amber-500/10 text-amber-400">Pausado</span>
                : <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-green-500/10 text-primary">Activo</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
