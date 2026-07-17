import { useQuery } from '@tanstack/react-query'
import { getStats, getClients } from '../clients/api'
import { Users, CircleCheck, CirclePause, MessageSquare } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Skeleton } from '@botpanel/ui/components/skeleton'

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ['adm-stats'], queryFn: getStats, refetchInterval: 30_000 })
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })

  if (isLoading) return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-6 h-56 w-full rounded-xl" />
    </div>
  )
  if (error) return <p className="text-destructive">✗ {(error as Error).message}</p>
  if (!data) return null

  const cards = [
    { label: 'Total clientes', value: data.totalClients, sub: 'Negocios registrados', icon: Users },
    { label: 'Activos', value: data.activeClients, sub: 'Bots funcionando', icon: CircleCheck },
    { label: 'Suspendidos', value: data.suspendedClients, sub: 'Pago pendiente', icon: CirclePause },
    { label: 'Mensajes hoy', value: data.messagesToday, sub: 'En todos los bots', icon: MessageSquare },
  ]

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <h1 className="text-2xl font-bold text-foreground mb-1">Dashboard</h1>
      <p className="text-sm text-muted-foreground mb-6">Visión general de tu negocio</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(c => (
          <Card key={c.label} className="py-4 gap-0">
            <CardContent className="px-5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <c.icon className="w-3.5 h-3.5 shrink-0" /> {c.label}
              </div>
              <div className="text-3xl font-bold tracking-tight text-foreground mt-1 tabular-nums">{c.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{c.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Últimos negocios (renderDashRecent del panel viejo) */}
      <Card className="mt-6 flex-1 gap-3">
        <CardHeader>
          <CardTitle className="text-base">Clientes recientes</CardTitle>
        </CardHeader>
        <CardContent>
          {clients.length === 0 && <p className="text-sm text-muted-foreground">Sin clientes aún.</p>}
          {clients.slice(0, 6).map(c => (
            <div key={c.id} className="flex items-center gap-3 py-2.5 border-b border-border/60 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground truncate">{c.name}</div>
                <div className="text-xs text-muted-foreground">{c.type || ''} · {c.whatsapp_number || 'sin número'}</div>
              </div>
              {c.suspended
                ? <Badge variant="secondary" className="bg-destructive/10 text-destructive">Suspendido</Badge>
                : !c.bot_active
                  ? <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">Pausado</Badge>
                  : <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">Activo</Badge>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
