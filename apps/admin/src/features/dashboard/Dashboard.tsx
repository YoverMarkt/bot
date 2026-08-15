import { useQuery } from '@tanstack/react-query'
import { getStats, getClients, getChannelHealth, type ChannelStatus } from '../clients/api'
import { Users, CircleCheck, CirclePause, MessageSquare, RadioTower, TriangleAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// Semáforo del canal de entrada. Nació del incidente de julio de 2026: el bot
// estuvo cinco días sin recibir WhatsApp y nada lo delataba.
const CHANNEL_BADGE: Record<ChannelStatus, { label: string; className: string }> = {
  ok: { label: 'Recibiendo', className: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  silencio: { label: 'Sin mensajes', className: 'bg-destructive/10 text-destructive' },
  nunca_recibio: { label: 'Nunca recibió', className: 'bg-destructive/10 text-destructive' },
  sin_canal: { label: 'Sin canal', className: 'bg-muted text-muted-foreground' },
}

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ['adm-stats'], queryFn: getStats, refetchInterval: 30_000 })
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })
  const { data: channel } = useQuery({
    queryKey: ['adm-channel-health'],
    queryFn: getChannelHealth,
    refetchInterval: 60_000,
  })

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

      {channel?.alert && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-destructive">
              Hay bots que no están recibiendo mensajes
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Revisa el webhook del proveedor: los clientes podrían estar escribiendo sin que nadie les responda.
            </div>
          </div>
        </div>
      )}

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

      {/* Salud del canal de entrada: ¿siguen llegando mensajes a cada bot? */}
      {/* ⚠️ `channel?.businesses?.length` y no `channel && channel.businesses`.
          Una respuesta a medias —un `{}` de un 502, un despliegue con el
          servidor a mitad— hacía `undefined.length` y tumbaba el dashboard
          ENTERO: el superadmin se quedaba con una pantalla en blanco por un
          recuadro secundario. Lo mismo que ya pasó en Conversaciones con la
          lista de bloqueados. */}
      {(channel?.businesses?.length ?? 0) > 0 && (
        <Card className="mt-6 gap-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTower className="h-4 w-4 shrink-0" /> Canal de entrada
            </CardTitle>
          </CardHeader>
          <CardContent>
            {channel!.businesses.map(business => (
              <div
                key={business.businessId}
                className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{business.name}</div>
                  <div className="text-xs text-muted-foreground">{business.detail}</div>
                </div>
                <Badge variant="secondary" className={CHANNEL_BADGE[business.status].className}>
                  {CHANNEL_BADGE[business.status].label}
                </Badge>
              </div>
            ))}
            <p className="mt-3 text-xs text-muted-foreground">
              Se avisa cuando un bot activo pasa {channel!.silenceHours} h sin recibir un solo mensaje.
            </p>
            {(channel!.recentFailures?.length ?? 0) > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                  Entregas rechazadas recientemente
                </div>
                {channel!.recentFailures.slice(0, 3).map(failure => (
                  <div key={failure.at} className="mt-1 text-xs text-muted-foreground">
                    {new Date(failure.at).toLocaleString('es-EC')} · {failure.provider} · HTTP {failure.status} — {failure.reason}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
