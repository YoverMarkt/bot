import { useQuery } from '@tanstack/react-query'
import { getStats, getClients, getChannelHealth, enElMarketplace, type ChannelStatus } from '../clients/api'
import { Store, CircleCheck, CirclePause, MessageSquare, RadioTower, TriangleAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// Semáforo del canal de entrada. Nació del incidente de julio de 2026: el bot
// estuvo cinco días sin recibir WhatsApp y nada lo delataba.
//
// ⚠️ Desde el 2026-08-23 el sujeto es el NÚMERO DE UMBANI, no cada local. Hay
// un solo canal de entrada: pintar una fila por negocio enseñaba «Sin mensajes»
// en todos —sus entrantes se encolan sin `business_id`— y una alarma que grita
// siempre es una alarma que se acaba ignorando.
const CHANNEL_BADGE: Record<ChannelStatus, { label: string; className: string }> = {
  ok: { label: 'Recibiendo', className: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  silencio: { label: 'Sin mensajes', className: 'bg-destructive/10 text-destructive' },
  nunca_recibio: { label: 'Nunca recibió', className: 'bg-destructive/10 text-destructive' },
  sin_canal: { label: 'Sin configurar', className: 'bg-muted text-muted-foreground' },
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

  // ⚠️ Dos de las cuatro cambiaron de significado el 2026-08-23:
  //   · «Activos — Bots funcionando» contaba `bot_active`, una columna que el
  //     marketplace no lee. Ahora cuenta los locales que un cliente puede
  //     ENCONTRAR en el menú de Umbani, con las mismas condiciones que la base.
  //   · «Mensajes hoy — En todos los bots» contaba `conversation_history`,
  //     donde el marketplace no escribe: marcaba 4 en un día de 55 entrantes.
  const cards = [
    { label: 'Total clientes', value: data.totalClients, sub: 'Negocios registrados', icon: Store },
    { label: 'En el marketplace', value: data.activeClients, sub: 'Locales que el cliente encuentra', icon: CircleCheck },
    { label: 'Suspendidos', value: data.suspendedClients, sub: 'Pago pendiente', icon: CirclePause },
    { label: 'Mensajes hoy', value: data.messagesToday, sub: 'Entrantes al número de Umbani', icon: MessageSquare },
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
              El canal de entrada no está recibiendo mensajes
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Revisa el webhook en YCloud: los clientes podrían estar escribiendo sin que nadie les responda.
              Con un solo número, esto deja sin servicio a todos los locales a la vez.
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

      {/* Salud del canal de entrada: ¿sigue llegando algo al número de Umbani? */}
      {/* ⚠️ `channel?.platform` y no `channel && …`. Una respuesta a medias —un
          `{}` de un 502, un despliegue con el servidor a mitad— hacía
          `undefined.status` y tumbaba el dashboard ENTERO: el superadmin se
          quedaba con una pantalla en blanco por un recuadro secundario. Lo
          mismo que ya pasó en Conversaciones con la lista de bloqueados. */}
      {channel?.platform && (
        <Card className="mt-6 gap-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTower className="h-4 w-4 shrink-0" /> Canal de entrada
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">
                  Número de Umbani
                </div>
                <div className="text-xs text-muted-foreground">{channel.platform.detail}</div>
              </div>
              <Badge variant="secondary" className={CHANNEL_BADGE[channel.platform.status].className}>
                {CHANNEL_BADGE[channel.platform.status].label}
              </Badge>
            </div>

            {/* Los negocios con canal PROPIO, si queda alguno. Hoy: ninguno. */}
            {(channel.businesses ?? []).map(business => (
              <div
                key={business.businessId}
                className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{business.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Número propio · {business.detail}
                  </div>
                </div>
                <Badge variant="secondary" className={CHANNEL_BADGE[business.status].className}>
                  {CHANNEL_BADGE[business.status].label}
                </Badge>
              </div>
            ))}

            <p className="mt-3 text-xs text-muted-foreground">
              Todos los locales comparten este número: se avisa cuando pasa {channel.silenceHours} h
              sin recibir un solo mensaje.
            </p>
            {(channel.recentFailures?.length ?? 0) > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                  Entregas rechazadas recientemente
                </div>
                {channel.recentFailures.slice(0, 3).map(failure => (
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
          {/* ⚠️ Ni el número ni `bot_active`: el primero está vacío en todos
              los locales del marketplace y el segundo no decide nada desde que
              se fue el canal propio. Lo que importa de un local recién creado
              es si un cliente ya puede encontrarlo. */}
          {clients.slice(0, 6).map(c => (
            <div key={c.id} className="flex items-center gap-3 py-2.5 border-b border-border/60 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground truncate">{c.name}</div>
                <div className="text-xs text-muted-foreground">{c.type || 'negocio'} · /t/{c.slug}</div>
              </div>
              {c.suspended
                ? <Badge variant="secondary" className="bg-destructive/10 text-destructive">Suspendido</Badge>
                : enElMarketplace(c)
                  ? <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">En el marketplace</Badge>
                  : <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">Oculto</Badge>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
