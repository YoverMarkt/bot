import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Image,
  ListChecks,
  MessageSquare,
  Search,
  Send,
  Users,
  Video,
} from 'lucide-react'
import {
  getClients,
  getMonthlyUsage,
  type BusinessRow,
  type MonthlyUsageRow,
} from '../clients/api'
import { planLabel } from '../clients/plans'
import { Badge } from '@botpanel/ui/components/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Progress } from '@botpanel/ui/components/progress'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

type UsageStatus = 'normal' | 'warning' | 'reached' | 'exceeded' | 'unconfigured'

type BusinessUsage = {
  business: BusinessRow
  usage: MonthlyUsageRow
  status: UsageStatus
  severity: number
}

const numberFormatter = new Intl.NumberFormat('es-EC')

function guayaquilMonth(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const year = parts.find(part => part.type === 'year')?.value || ''
  const month = parts.find(part => part.type === 'month')?.value || ''
  return `${year}-${month}`
}

function percentage(used: number, limit: number | null): number | null {
  if (!limit) return null
  return (used / limit) * 100
}

function statusFor(contactsPercent: number | null, messagesPercent: number | null): {
  status: UsageStatus
  severity: number
} {
  const configured = [contactsPercent, messagesPercent]
    .filter((value): value is number => value !== null)
  if (!configured.length) return { status: 'unconfigured', severity: -1 }
  const maximum = Math.max(...configured)
  if (maximum > 100) return { status: 'exceeded', severity: maximum }
  if (maximum === 100) return { status: 'reached', severity: maximum }
  if (maximum >= 80) return { status: 'warning', severity: maximum }
  return { status: 'normal', severity: maximum }
}

function emptyUsage(business: BusinessRow, month: string): MonthlyUsageRow {
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0))
    .toISOString()
    .slice(0, 10)
  return {
    business_id: business.id,
    period_start: `${month}-01`,
    period_end: lastDay,
    active_contacts: 0,
    inbound_messages: 0,
    outbound_messages: 0,
    outbound_text_messages: 0,
    outbound_image_messages: 0,
    outbound_video_messages: 0,
    outbound_interactive_messages: 0,
    contact_limit: business.monthly_contact_limit,
    outbound_message_limit: business.monthly_outbound_message_limit,
    contact_overage: 0,
    outbound_message_overage: 0,
    includes_history_estimate: false,
  }
}

const statusLabels: Record<UsageStatus, string> = {
  normal: 'Dentro del plan',
  warning: 'Cerca del límite',
  reached: 'Límite alcanzado',
  exceeded: 'Límite excedido',
  unconfigured: 'Sin límites',
}

function StatusBadge({ status }: { status: UsageStatus }) {
  const classes = status === 'exceeded'
    ? 'bg-destructive/10 text-destructive'
    : status === 'warning' || status === 'reached'
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
      : status === 'normal'
        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
        : ''
  return <Badge variant="secondary" className={classes}>{statusLabels[status]}</Badge>
}

function UsageBar({
  label,
  used,
  limit,
  overage,
}: {
  label: string
  used: number
  limit: number | null
  overage: number
}) {
  const rawPercent = percentage(used, limit)
  const displayPercent = rawPercent === null
    ? null
    : rawPercent > 100
      ? Math.ceil(rawPercent)
      : Math.round(rawPercent)
  const color = rawPercent !== null && rawPercent > 100
    ? '[&_[data-slot=progress-indicator]]:bg-destructive'
    : rawPercent !== null && rawPercent >= 80
      ? '[&_[data-slot=progress-indicator]]:bg-amber-500'
      : '[&_[data-slot=progress-indicator]]:bg-emerald-500'

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="mt-0.5 text-xl font-semibold tabular-nums">
            {numberFormatter.format(used)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              / {limit ? numberFormatter.format(limit) : 'sin límite'}
            </span>
          </div>
        </div>
        {displayPercent !== null && (
          <div className={`text-sm font-semibold tabular-nums ${
            rawPercent !== null && rawPercent > 100
              ? 'text-destructive'
              : displayPercent >= 80
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-emerald-600 dark:text-emerald-400'
          }`}>
            {displayPercent}%
          </div>
        )}
      </div>
      <Progress
        value={Math.min(100, Math.max(0, rawPercent || 0))}
        className={`h-2.5 ${color}`}
        aria-label={`${label}: ${used} de ${limit || 'sin límite'}`}
      />
      {overage > 0 && (
        <p className="text-xs font-medium text-destructive">
          Exceso: +{numberFormatter.format(overage)}
        </p>
      )}
    </div>
  )
}

function UsageCard({ item }: { item: BusinessUsage }) {
  const { business, usage, status } = item
  return (
    <Card className={status === 'exceeded' ? 'ring-destructive/50' : ''}>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{business.name}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {business.type || 'Negocio'} · Plan {planLabel(business.plan)}
            </p>
          </div>
          <StatusBadge status={status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <UsageBar
            label="Contactos activos"
            used={usage.active_contacts}
            limit={usage.contact_limit}
            overage={usage.contact_overage}
          />
          <UsageBar
            label="Mensajes enviados"
            used={usage.outbound_messages}
            limit={usage.outbound_message_limit}
            overage={usage.outbound_message_overage}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 border-t pt-4 text-xs text-muted-foreground sm:grid-cols-5">
          <div className="flex items-center gap-1.5" title="Mensajes recibidos">
            <MessageSquare className="size-3.5" />
            <span>Entrantes</span>
            <strong className="ml-auto text-foreground tabular-nums">
              {numberFormatter.format(usage.inbound_messages)}
            </strong>
          </div>
          <div className="flex items-center gap-1.5" title="Textos enviados">
            <Send className="size-3.5" />
            <span>Textos</span>
            <strong className="ml-auto text-foreground tabular-nums">
              {numberFormatter.format(usage.outbound_text_messages)}
            </strong>
          </div>
          <div className="flex items-center gap-1.5">
            <Image className="size-3.5" />
            <span>Fotos</span>
            <strong className="ml-auto text-foreground tabular-nums">
              {numberFormatter.format(usage.outbound_image_messages)}
            </strong>
          </div>
          <div className="flex items-center gap-1.5">
            <Video className="size-3.5" />
            <span>Videos</span>
            <strong className="ml-auto text-foreground tabular-nums">
              {numberFormatter.format(usage.outbound_video_messages)}
            </strong>
          </div>
          <div className="flex items-center gap-1.5">
            <ListChecks className="size-3.5" />
            <span>Menús</span>
            <strong className="ml-auto text-foreground tabular-nums">
              {numberFormatter.format(usage.outbound_interactive_messages)}
            </strong>
          </div>
        </div>

        {usage.includes_history_estimate && (
          <p className="text-[11px] text-muted-foreground">
            El inicio de este período incluye una reconstrucción aproximada del historial anterior a la activación del contador.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default function Usage() {
  const [month, setMonth] = useState(guayaquilMonth)
  const [search, setSearch] = useState('')
  const clientsQuery = useQuery({
    queryKey: ['adm-clients'],
    queryFn: getClients,
  })
  const usageQuery = useQuery({
    queryKey: ['adm-usage', month],
    queryFn: () => getMonthlyUsage(month),
    refetchInterval: 30_000,
  })

  const items = useMemo(() => {
    const usageByBusiness = new Map(
      (usageQuery.data || []).map(row => [row.business_id, row]),
    )
    const normalizedSearch = search.trim().toLocaleLowerCase('es')
    return (clientsQuery.data || [])
      .filter(business => !normalizedSearch
        || business.name.toLocaleLowerCase('es').includes(normalizedSearch)
        || (business.type || '').toLocaleLowerCase('es').includes(normalizedSearch))
      .map(business => {
        const usage = usageByBusiness.get(business.id) || emptyUsage(business, month)
        const result = statusFor(
          percentage(usage.active_contacts, usage.contact_limit),
          percentage(usage.outbound_messages, usage.outbound_message_limit),
        )
        return { business, usage, ...result }
      })
      .sort((left, right) => (
        right.severity - left.severity
        || left.business.name.localeCompare(right.business.name, 'es')
      ))
  }, [clientsQuery.data, usageQuery.data, month, search])

  const totals = useMemo(() => ({
    all: items.length,
    normal: items.filter(item => item.status === 'normal').length,
    warning: items.filter(item => (
      item.status === 'warning' || item.status === 'reached'
    )).length,
    exceeded: items.filter(item => item.status === 'exceeded').length,
  }), [items])

  const isLoading = clientsQuery.isLoading || usageQuery.isLoading
  const hasError = clientsQuery.isError || usageQuery.isError

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Gauge className="size-6 text-primary" /> Medición
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Consumo mensual de todos los negocios; se actualiza cada 30 segundos.
          </p>
        </div>
        <div>
          <label htmlFor="usage-month" className="mb-1 block text-xs font-medium text-muted-foreground">
            Período
          </label>
          <Input
            id="usage-month"
            type="month"
            value={month}
            onChange={event => setMonth(event.target.value || guayaquilMonth())}
            className="w-44"
          />
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Negocios', value: totals.all, icon: Users, color: '' },
          { label: 'Dentro del plan', value: totals.normal, icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Cerca o al límite', value: totals.warning, icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400' },
          { label: 'Excedidos', value: totals.exceeded, icon: AlertTriangle, color: 'text-destructive' },
        ].map(summary => (
          <Card key={summary.label} className="py-4">
            <CardContent>
              <div className={`flex items-center gap-1.5 text-xs ${summary.color || 'text-muted-foreground'}`}>
                <summary.icon className="size-3.5" /> {summary.label}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{summary.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Buscar negocio…"
          className="max-w-md pl-9"
        />
      </div>

      {isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : hasError ? (
        <QueryError onRetry={() => {
          void clientsQuery.refetch()
          void usageQuery.refetch()
        }} />
      ) : items.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {items.map(item => <UsageCard key={item.business.id} item={item} />)}
        </div>
      ) : (
        <Card className="p-8 text-center text-muted-foreground">
          {search ? 'No hay negocios que coincidan con la búsqueda.' : 'Todavía no hay negocios registrados.'}
        </Card>
      )}
    </div>
  )
}
