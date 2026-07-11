import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, session } from '../../api/client'
import { getAlerts } from '../reports/api'
import { getProducts } from '../catalog/api'
import { useBusinessInfo } from '../../lib/biz'
import { TrendingUp, DollarSign, Trophy, Users, Package, Rocket, Plus, CircleCheck, Circle, PackageX, PackageMinus, ClipboardList, TrendingDown, UserMinus, ShoppingCart, Brain, Moon, CreditCard, CircleAlert, TriangleAlert, Info, Receipt, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card as UICard, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, CartesianGrid, LabelList, Label } from 'recharts'

// ── INICIO (port fiel del dashboard BI del panel viejo):
// KPIs + línea de ventas por día + comparación + top + donas de
// clientes/inventario + banner de alertas + checklist de onboarding.
// Gráficas: componentes oficiales de shadcn (ChartContainer sobre Recharts).

// Paleta del sistema (skill graficos-dashboard — CVD-safe, orden fijo)
const C1 = 'var(--chart-1)', C2 = 'var(--chart-2)', C3 = 'var(--chart-3)', C4 = 'var(--chart-4)'
const GOOD = '#22c55e', WARN = '#f59e0b', CRIT = '#ef4444'

type DashboardData = {
  period: string
  label: string
  kpis: {
    total: number; orders: number; avg: number
    conversion: number | null; items: number
    clientes: number; nuevos: number; recurrentes: number
  }
  comparison: { curTotal: number; prevTotal: number; pct: number | null }
  top: { name: string; qty: number; rev: number }[]
  stock: { disponible: number; ultimas: number; agotado: number }
  customersByStatus: { nuevos: number; frecuentes: number; activos: number; inactivos: number }
  trend: { days: number; rows: { date: string; label: string; total: number; orders: number }[] }
}

type Onboarding = {
  steps: { label: string; done: boolean; hint?: string; page?: string }[]
  done: number; total: number; pct: number
}

// Contadores rápidos del panel viejo (loadStats)
type QuickStats = { totalProducts: number; availableProducts: number; messagesToday: number; totalContacts: number }

// Mapa de páginas del viejo → rutas del panel React (para el checklist)
const PAGE_ROUTE: Record<string, string> = {
  products: '/catalog', botprompt: '/settings', policies: '/settings',
  settings: '/settings', schedule: '/schedule', conversations: '/conversations',
}

const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`   // centavos EXACTOS, siempre

const ALERT_STYLE: Record<string, string> = {
  critical: 'bg-red-50 border-red-200 text-red-800 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300',
  warning:  'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-300',
  good:     'bg-primary/10 border-green-200 text-primary dark:border-green-500/30',
  info:     'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-500/10 dark:border-blue-500/30 dark:text-blue-300',
}

// El server manda las alertas con emoji en `icon`; aquí se traduce a Lucide (línea shadcn)
const ALERT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  '🔴': PackageX, '🟡': PackageMinus, '📋': ClipboardList, '📉': TrendingDown,
  '📈': TrendingUp, '😴': UserMinus, '🛒': ShoppingCart, '🧠': Brain,
  '🌙': Moon, '💳': CreditCard,
}
const ALERT_ICON_FALLBACK: Record<string, React.ComponentType<{ className?: string }>> = {
  critical: CircleAlert, warning: TriangleAlert, good: CircleCheck, info: Info,
}

const PERIODS = [
  { value: 'hoy',    label: 'Hoy' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes',    label: 'Mes' },
] as const

export default function Dashboard() {
  const [period, setPeriod] = useState<string>('semana')   // el viejo arranca en Semana
  const navigate = useNavigate()
  const user = session.user
  const isOwner = user?.role === 'owner'
  const canReports = isOwner || (user?.permissions ?? []).includes('reportes')
  const { data: bizInfo } = useBusinessInfo()
  const { data: products = [] } = useQuery({ queryKey: ['products'], queryFn: getProducts })
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => api<DashboardData>(`/api/client/dashboard?period=${period}`),
    enabled: canReports,
  })
  const { data: alertsData } = useQuery({ queryKey: ['alerts'], queryFn: getAlerts, staleTime: 60_000 })
  const { data: onboarding } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api<Onboarding>('/api/client/onboarding'),
    enabled: isOwner,
    staleTime: 60_000,
  })
  const { data: quick } = useQuery({
    queryKey: ['quick-stats'],
    queryFn: () => api<QuickStats>('/api/client/stats'),
    staleTime: 60_000,
  })

  if (canReports && isLoading) return <p className="text-muted-foreground">Cargando tu negocio…</p>
  if (error) return <p className="text-destructive">✗ {(error as Error).message}</p>

  const k = data?.kpis
  const pct = data?.comparison.pct ?? null
  const conv = k?.conversion == null ? '—' : `${Math.round(k.conversion)}%`
  const cs = data?.customersByStatus

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Hola, {session.business?.name || ''}!</h1>
          <p className="text-sm text-muted-foreground">Panel de gestión de tu bot de WhatsApp</p>
        </div>
        <div className="flex items-center gap-2">
          {canReports && (
            <div className="flex gap-1 bg-card border rounded-lg p-1">
              {PERIODS.map(p => (
                <Button variant="ghost"
                  key={p.value} onClick={() => setPeriod(p.value)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    period === p.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          )}
          <Button onClick={() => navigate('/catalog?new=1')}>
            <span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Agregar producto</span>
          </Button>
        </div>
      </div>

      {/* Banner de suspendido (igual que el viejo) */}
      {bizInfo?.suspended && (
        <div className="rounded-xl bg-gradient-to-r from-red-600 to-red-400 text-white text-sm font-semibold px-5 py-4 mb-5">
          Tu cuenta está suspendida — el bot no responde a tus clientes. Contacta a soporte para reactivarla.
        </div>
      )}

      {/* Checklist de onboarding (solo dueño, solo si falta algo) */}
      {onboarding?.steps && onboarding.pct < 100 && <OnboardingCard d={onboarding} />}

      {/* Banner de alertas */}
      {alertsData && alertsData.alerts.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {alertsData.alerts.map((a, i) => {
            const Icon = ALERT_ICON[a.icon] ?? ALERT_ICON_FALLBACK[a.level] ?? Info
            return (
              <span key={i} className={`text-xs font-medium rounded-lg border px-2.5 py-1.5 inline-flex items-center gap-1.5 ${ALERT_STYLE[a.level] ?? ALERT_STYLE.info}`}>
                <Icon className="w-3.5 h-3.5 shrink-0" /> {a.text}
              </span>
            )
          })}
        </div>
      )}

      {/* BI (solo con permiso de reportes, como el viejo) */}
      {canReports && data && k && (<>
      {/* KPIs (mismos 5 del viejo, en stat-tiles de la librería) */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <Kpi icon={DollarSign} label={`Ventas (${data.label})`} value={money(k.total)} sub={pct === null ? '' : `${pct >= 0 ? '▲ +' : '▼ '}${Math.abs(pct).toFixed(0)}% vs período anterior`} good={pct !== null && pct >= 0} />
        <Kpi icon={ShoppingCart} label="Pedidos" value={String(k.orders)} sub={`${k.items} ítems vendidos`} />
        <Kpi icon={Receipt} label="Ticket promedio" value={money(k.avg)} sub="" />
        <Kpi icon={TrendingUp} label="Conversión" value={conv} sub="Contactos que compraron" />
        <Kpi icon={Users} label="Clientes" value={String(k.clientes)} sub="Personas que escribieron en el chat" />
      </div>

      {/* Gráficos (mismo grid del viejo, con los charts de la librería) */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title={`Ventas por día (últimos ${data.trend?.days ?? 7} días)`} icon={TrendingUp} full>
          <SalesTrend rows={data.trend?.rows ?? []} />
        </Card>
        <Card title={`Ventas: ${data.label} vs anterior`} icon={DollarSign}>
          <ComparisonChart label={data.label} cur={Number(data.comparison.curTotal) || 0} prev={Number(data.comparison.prevTotal) || 0} />
        </Card>
        <Card title="Productos más vendidos" icon={Trophy}>
          {data.top.length === 0 ? <p className="text-sm text-muted-foreground">Sin ventas en el período.</p> :
            <Bars rows={data.top.map(t => ({ label: t.name, value: t.qty, text: `${t.qty} uds` }))} />}
        </Card>
        <Card title="Clientes por estado" icon={Users}>
          <Donut center="clientes" segs={[
            { label: 'Nuevos', value: cs?.nuevos ?? 0, color: C1 },
            { label: 'Frecuentes', value: cs?.frecuentes ?? 0, color: C2 },
            { label: 'Activos', value: cs?.activos ?? 0, color: C3 },
            { label: 'Inactivos', value: cs?.inactivos ?? 0, color: C4 },
          ]} />
        </Card>
        <Card title="Inventario" icon={Package}>
          <Donut center="productos" segs={[
            { label: 'Disponible', value: data.stock.disponible, color: GOOD },
            { label: 'Últimas unidades', value: data.stock.ultimas, color: WARN },
            { label: 'Agotado', value: data.stock.agotado, color: CRIT },
          ]} />
        </Card>
      </div>
      </>)}

      {/* Contadores (mismos 4 del viejo, debajo del BI) */}
      {quick && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4 mb-4">
          <Kpi icon={Package} label="Productos" value={String(quick.totalProducts)} sub="En catálogo" />
          <Kpi icon={CircleCheck} label="Disponibles" value={String(quick.availableProducts)} sub="Con stock" />
          <Kpi icon={MessageSquare} label="Mensajes hoy" value={String(quick.messagesToday)} sub="Respondidos" />
          <Kpi icon={Users} label="Contactos" value={String(quick.totalContacts)} sub="Personas que escribieron en el chat" />
        </div>
      )}

      {/* Productos recientes (igual que el viejo: 5, con foto, marca y precio) */}
      <Card title="Productos recientes">
        {products.length === 0
          ? <p className="text-sm text-muted-foreground">Sin productos aún.</p>
          : products.slice(0, 5).map(p => (
            <div key={p.id} className="flex items-center gap-3 py-2 border-b border-border/60 last:border-0">
              <div className="w-9 h-9 rounded-lg bg-muted overflow-hidden shrink-0">
                {p.image_url && <img src={p.image_url} alt="" className="w-full h-full object-cover" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground truncate">{p.name}</div>
                <div className="text-xs text-muted-foreground/80">{p.brand || ''}</div>
              </div>
              <div className="font-mono text-sm font-medium text-foreground shrink-0">
                {Number(p.price) > 0 ? `$${Number(p.price).toFixed(2)}` : 'a consultar'}
              </div>
            </div>
          ))}
      </Card>
    </div>
  )
}

function OnboardingCard({ d }: { d: Onboarding }) {
  const navigate = useNavigate()
  return (
    <UICard className="border-2 border-green-300 dark:border-green-500/40 mb-5 gap-3">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base"><Rocket className="w-4 h-4 text-primary" /> Configura tu bot para vender</CardTitle>
          <strong className="text-foreground">{d.done}/{d.total}</strong>
        </div>
        <Progress value={d.pct} className="h-2 mt-2" />
      </CardHeader>
      <CardContent>
        {d.steps.map((s, i) => (
          <div key={i} className="flex items-center gap-3 py-2 border-b border-border/40 last:border-0 text-sm">
            {s.done ? <CircleCheck className="w-4 h-4 text-primary shrink-0" /> : <Circle className="w-4 h-4 text-muted-foreground/40 shrink-0" />}
            <span className={`flex-1 ${s.done ? 'text-muted-foreground/80 line-through' : 'text-foreground/90'}`}>
              {s.label}{s.hint && <span className="text-muted-foreground/80 text-xs"> · {s.hint}</span>}
            </span>
            {!s.done && s.page && (
              <Button variant="outline" size="sm" onClick={() => navigate(PAGE_ROUTE[s.page!] ?? '/')} className="text-xs">Configurar →</Button>
            )}
          </div>
        ))}
      </CardContent>
    </UICard>
  )
}

// Stat-tile de la librería: icono + label arriba, número grande en negrita
function Kpi({ label, value, sub, good, icon: Icon }: { label: string; value: string; sub: string; good?: boolean; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <UICard className="py-4 gap-0">
      <CardContent className="px-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
          {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />} {label}
        </div>
        <div className="text-3xl font-bold tracking-tight text-foreground mt-1">{value}</div>
        {sub && <div className={`text-xs mt-1 ${good === undefined ? 'text-muted-foreground' : good ? 'text-primary' : 'text-destructive'}`}>{sub}</div>}
      </CardContent>
    </UICard>
  )
}

function Card({ title, icon: Icon, children, full }: { title: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode; full?: boolean }) {
  return (
    <UICard className={`gap-3 ${full ? 'lg:col-span-2' : ''}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">{Icon && <Icon className="w-4 h-4 text-muted-foreground" />}{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </UICard>
  )
}

// Tooltip de dinero para los charts (label + valor formateado)
const moneyTooltip = (label: string) => (value: unknown) => (
  <div className="flex w-full items-center justify-between gap-4">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono font-medium tabular-nums text-foreground">{money(Number(value))}</span>
  </div>
)

// ── Ventas por día — LineChart oficial de la librería ──
function SalesTrend({ rows }: { rows: { label: string; total: number }[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Sin datos aún.</p>
  return (
    <ChartContainer config={{ total: { label: 'Ventas', color: 'var(--chart-1)' } }} className="aspect-auto h-56 w-full">
      <LineChart data={rows} margin={{ top: 24, left: 16, right: 16 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} tick={{ fontSize: 11 }} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={moneyTooltip('Ventas')} />} />
        <Line dataKey="total" type="monotone" stroke="var(--color-total)" strokeWidth={2}
          dot={{ r: 4, fill: 'var(--color-total)', stroke: 'var(--card)', strokeWidth: 2 }}>
          <LabelList dataKey="total" position="top" offset={10} className="fill-muted-foreground" fontSize={10}
            formatter={(v: unknown) => (Number(v) > 0 ? money(Number(v)) : '')} />
        </Line>
      </LineChart>
    </ChartContainer>
  )
}

// ── Comparación con período anterior — BarChart oficial de la librería ──
function ComparisonChart({ label, cur, prev }: { label: string; cur: number; prev: number }) {
  const data = [
    { name: label, total: cur, fill: 'var(--chart-1)' },
    { name: 'Anterior', total: prev, fill: 'var(--muted-foreground)' },
  ]
  return (
    <ChartContainer config={{ total: { label: 'Ventas' } }} className="aspect-auto h-56 w-full">
      <BarChart data={data} margin={{ top: 24 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={moneyTooltip('Ventas')} />} />
        <Bar dataKey="total" radius={[8, 8, 0, 0]} maxBarSize={72}>
          <LabelList dataKey="total" position="top" offset={8} className="fill-muted-foreground" fontSize={11}
            formatter={(v: unknown) => money(Number(v))} />
          {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

// ── Dona — PieChart oficial de la librería, con total al centro y leyenda al lado ──
function Donut({ segs, center }: { segs: { label: string; value: number; color: string }[]; center: string }) {
  const total = segs.reduce((s, x) => s + x.value, 0)
  if (!total) return <p className="text-sm text-muted-foreground">Sin datos aún.</p>
  const live = segs.filter(s => s.value > 0)
  return (
    <div className="flex items-center gap-6 flex-wrap">
      <ChartContainer config={{}} className="aspect-square h-44 shrink-0">
        <PieChart>
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
          <Pie data={live} dataKey="value" nameKey="label" innerRadius={48} outerRadius={70} strokeWidth={2} stroke="var(--card)">
            {live.map((s, i) => <Cell key={i} fill={s.color} />)}
            <Label content={({ viewBox }) => {
              if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                return (
                  <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-bold">{total}</tspan>
                    <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 18} className="fill-muted-foreground text-xs">{center}</tspan>
                  </text>
                )
              }
            }} />
          </Pie>
        </PieChart>
      </ChartContainer>
      {/* Leyenda: nunca color como única identidad */}
      <ul className="text-sm space-y-1.5">
        {segs.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-foreground/90">{s.label}</span>
            <span className="text-muted-foreground font-semibold ml-1 tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Barras horizontales con el Progress de la librería (patrón "location by city")
function Bars({ rows }: { rows: { label: string; value: number; text: string }[] }) {
  const max = Math.max(...rows.map(r => r.value), 0.0001)
  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={i} title={`${r.label}: ${r.text}`}>
          <div className="flex justify-between text-sm mb-1.5">
            <span className="text-foreground/90 truncate">{r.label}</span>
            <span className="text-muted-foreground shrink-0 ml-2 font-medium tabular-nums">{r.text}</span>
          </div>
          <Progress value={Math.max((r.value / max) * 100, 2)} className="h-1.5" />
        </div>
      ))}
    </div>
  )
}
