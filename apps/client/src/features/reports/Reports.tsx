import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getReports, getAlerts, money, type Alert } from './api'
import { BarChart3, UserRound, ClipboardList, Trophy, Search, ShoppingCart, Snail, Package, Handshake, Frown, Brain, HelpCircle, Users, DollarSign, Bot as BotIcon, Repeat2, Sparkles, PackageX, PackageMinus, TrendingDown, TrendingUp, UserMinus, Moon, CreditCard, CircleAlert, TriangleAlert, CircleCheck, Info, Receipt } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card as UICard, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, LabelList } from 'recharts'

// Reportes premium con la librería (misma información REAL del servidor):
// Tabs para el período, pills con variantes, stat-tiles con icono, charts
// oficiales (comparación y FAQ), Progress para magnitudes y Badges para
// conteos/estados. Estados (rojo/ámbar) reservados para stock, como siempre.

const ALERT_STYLE: Record<Alert['level'], string> = {
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

const PERIODS = [['hoy', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes']] as const

// Categorías del panel viejo (filterReports): cada card pertenece a un grupo
const CATS = [
  ['todos', 'Todos', null],
  ['ventas', 'Ventas', DollarSign],
  ['productos', 'Productos', Package],
  ['clientes', 'Clientes', Users],
  ['bot', 'Bot', BotIcon],
] as const
type Cat = typeof CATS[number][0]

export default function Reports() {
  const [period, setPeriod] = useState<string>('mes')
  const [cat, setCat] = useState<Cat>('todos')
  const { data, isLoading, error } = useQuery({ queryKey: ['reports', period], queryFn: () => getReports(period) })
  const { data: alertsData } = useQuery({ queryKey: ['alerts'], queryFn: getAlerts, staleTime: 60_000 })

  const show = (g: Cat) => cat === 'todos' || cat === g

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reportes de ventas</h1>
          <p className="text-sm text-muted-foreground">Tus métricas de negocio. También puedes pedirlas por WhatsApp.</p>
        </div>
        <Tabs value={period} onValueChange={setPeriod}>
          <TabsList>
            {PERIODS.map(([v, l]) => <TabsTrigger key={v} value={v}>{l}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </div>

      {/* Atajo a reactivar (igual que el viejo) */}
      <div className="mb-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/reactivate"><span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> Clientes sin escribir (reactivar)</span></Link>
        </Button>
      </div>

      {/* Banner de alertas */}
      {alertsData && alertsData.alerts.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {alertsData.alerts.map((a, i) => {
            const Icon = ALERT_ICON[a.icon] ?? ALERT_ICON_FALLBACK[a.level] ?? Info
            return (
              <span key={i} className={`text-xs font-medium rounded-lg border px-2.5 py-1.5 inline-flex items-center gap-1.5 ${ALERT_STYLE[a.level]}`}>
                <Icon className="w-3.5 h-3.5 shrink-0" /> {a.text}
              </span>
            )
          })}
        </div>
      )}

      {/* Filtro por categoría (mismas del panel viejo) */}
      <div className="mb-5 flex flex-wrap gap-2">
        {CATS.map(([v, l, Icon]) => (
          <Button key={v} size="sm" variant={cat === v ? 'default' : 'outline'} onClick={() => setCat(v)} className="rounded-full">
            <span className="inline-flex items-center gap-1.5">{Icon && <Icon className="w-3.5 h-3.5" />}{l}</span>
          </Button>
        ))}
      </div>

      {isLoading && <p className="text-muted-foreground">Calculando reportes…</p>}
      {error && <p className="text-destructive">✗ {(error as Error).message}</p>}
      {data && (
        <>
          {/* Resumen del período */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <Stat icon={DollarSign} label="Total vendido" value={money(data.summary.total)} />
            <Stat icon={ShoppingCart} label="Pedidos" value={String(data.summary.orders)} />
            <Stat icon={Package} label="Ítems" value={String(data.summary.items)} />
            <Stat icon={Receipt} label="Ticket promedio" value={money(data.summary.avg)} />
            <Stat icon={Sparkles} label="Nuevos" value={String(data.summary.nuevos)} />
            <Stat icon={Repeat2} label="Recurrentes" value={String(data.summary.recurrentes)} />
            <Stat icon={TrendingUp} label="Conversión" value={data.summary.conversion === null ? '—' : `${Math.round(data.summary.conversion)}%`} />
          </div>

          <Separator className="my-5" />

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {/* Comparación — BarChart oficial de la librería */}
            {show('ventas') && (<>
            <Card title="Comparación con período anterior" icon={BarChart3}>
              <ComparisonChart label={data.comparison.label} cur={Number(data.comparison.curTotal) || 0} prev={Number(data.comparison.prevTotal) || 0} />
              <p className="text-xs text-muted-foreground mt-2">
                {data.comparison.curOrders} vs {data.comparison.prevOrders} pedidos · Variación:{' '}
                {data.comparison.pct === null
                  ? (data.comparison.curTotal > 0 ? 'sin base anterior' : 'sin datos')
                  : <span className={data.comparison.pct >= 0 ? 'text-primary font-semibold' : 'text-destructive font-semibold'}>
                      {data.comparison.pct >= 0 ? '▲ +' : '▼ '}{data.comparison.pct.toFixed(1)}%
                    </span>}
              </p>
            </Card>
            </>)}
            {/* Vendedores */}
            {show('ventas') && (<>
            <Card title="Ventas por vendedor" icon={UserRound}>
              {data.bySeller.rows.length === 0 ? <Empty msg="Sin ventas en el período." /> :
                <Bars rows={data.bySeller.rows.map(r => ({ label: r.name, value: Number(r.total) || 0, text: money(r.total) }))} />}
            </Card>
            </>)}
            {/* Pendientes */}
            {show('ventas') && (<>
            <Card title="Pedidos sin cerrar" icon={ClipboardList} badge={data.pending.count || undefined}>
              {data.pending.rows.length === 0 ? <Empty msg="No hay cotizaciones sin cerrar." /> :
                <ul className="text-sm space-y-1.5">
                  {data.pending.rows.map((r, i) => <li key={i} className="truncate text-foreground/90">{r.name}{r.last_message ? <span className="text-muted-foreground/80"> — “{r.last_message.slice(0, 40)}”</span> : null}</li>)}
                </ul>}
            </Card>
            </>)}
            {/* Top productos */}
            {show('productos') && (<>
            <Card title="Productos más vendidos" icon={Trophy}>
              {data.top.rows.length === 0 ? <Empty msg="Sin ventas en el período." /> :
                <Bars rows={data.top.rows.map(r => ({ label: r.name, value: r.qty, text: `${r.qty} uds · ${money(r.rev)}` }))} />}
            </Card>
            </>)}
            {/* Más consultados */}
            {show('productos') && (<>
            <Card title="Más consultados" icon={Search}>
              {data.mostConsulted.rows.length === 0 ? <Empty msg="Sin consultas registradas." /> :
                <Bars rows={data.mostConsulted.rows.map(r => ({ label: r.name, value: r.count, text: `${r.count} consultas` }))} />}
            </Card>
            </>)}
            {/* Abandonados */}
            {show('productos') && (<>
            <Card title="Productos abandonados (consultados sin vender)" icon={ShoppingCart}>
              {data.abandoned.rows.length === 0 ? <Empty msg="Nada abandonado." /> :
                <ul className="text-sm space-y-2">
                  {data.abandoned.rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground/90">{r.name}</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">{r.consultas} consultas</Badge>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
            {/* Bajo movimiento */}
            {show('productos') && (<>
            <Card title="Bajo movimiento (candidatos a promo)" icon={Snail}>
              {data.lowMovement.rows.length === 0 ? <Empty msg="Todos tus productos tuvieron ventas." /> :
                <ul className="text-sm space-y-2">
                  {data.lowMovement.rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground/90">{r.name}</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">{r.qty} uds</Badge>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
            {/* Stock bajo (colores de ESTADO reservados; nunca color como única identidad) */}
            {show('productos') && (<>
            <Card title="Stock bajo o agotado" icon={Package}>
              {data.lowStock.rows.length === 0 ? <Empty msg="Nada agotado ni en últimas unidades." /> :
                <ul className="text-sm space-y-2">
                  {data.lowStock.rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground/90">{r.name}</span>
                      <Badge variant="outline" className="shrink-0 gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${r.stock === 'agotado' ? 'bg-red-500' : 'bg-amber-500'}`} />
                        {r.stock}
                      </Badge>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
            {/* Clientes frecuentes */}
            {show('clientes') && (<>
            <Card title="Clientes frecuentes" icon={Handshake}>
              {data.recurring.rows.length === 0 ? <Empty msg="Aún sin clientes recurrentes." /> :
                <ul className="text-sm space-y-2">
                  {data.recurring.rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="text-foreground/90 truncate"><span className={`font-semibold ${i < 3 ? 'text-primary' : 'text-muted-foreground'}`}>{i + 1}.</span> {r.name}</span>
                      <span className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums">{r.orders} compra(s) · {money(r.total)}</span>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
            {/* Clientes perdidos */}
            {show('clientes') && (<>
            <Card title="Clientes perdidos (escribieron sin comprar)" icon={Frown}>
              {data.lostCustomers.rows.length === 0 ? <Empty msg="Nadie se quedó sin comprar." /> :
                <>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <Badge variant="secondary" className="gap-1"><Repeat2 className="w-3 h-3" /> {data.lostCustomers.returning} ya-cliente</Badge>
                    <Badge variant="secondary" className="gap-1"><Sparkles className="w-3 h-3" /> {data.lostCustomers.nuevos} nuevos</Badge>
                    <Badge variant="secondary" className="tabular-nums">{data.lostCustomers.noRespondio} sin respuesta del negocio</Badge>
                  </div>
                  <ul className="text-sm space-y-1.5">
                    {data.lostCustomers.rows.map((r, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span className="truncate text-foreground/90 flex items-center gap-1.5">{r.returning ? <Repeat2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <Sparkles className="w-3.5 h-3.5 text-muted-foreground shrink-0" />} {r.name}</span>
                        {r.reason && <span className="text-xs text-muted-foreground/80 shrink-0">{r.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </>}
            </Card>
            </>)}
            {/* Reporte de IA: FAQ (BarChart oficial horizontal) + sin responder */}
            {show('bot') && (<>
            <Card title="Preguntas más frecuentes" icon={Brain}>
              {data.faq.rows.filter(r => r.count > 0).length === 0 ? <Empty msg="Sin datos suficientes aún." /> :
                <FaqChart rows={data.faq.rows.filter(r => r.count > 0).map(r => ({ topic: r.topic, count: r.count }))} />}
            </Card>

            <Card title="Preguntas que la IA no pudo responder" icon={HelpCircle}>
              {data.unanswered.rows.length === 0 ? <Empty msg="El bot pudo con todo." /> :
                <ul className="text-sm space-y-2">
                  {data.unanswered.rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="text-foreground/90 truncate">“{r.question ?? '—'}”</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">×{r.count}</Badge>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
          </div>
        </>
      )}
    </div>
  )
}

function Card({ title, icon: Icon, badge, children }: { title: string; icon?: React.ComponentType<{ className?: string }>; badge?: number; children: React.ReactNode }) {
  return (
    <UICard className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
          <span className="truncate">{title}</span>
          {badge !== undefined && <Badge variant="secondary" className="ml-auto shrink-0 tabular-nums">{badge}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </UICard>
  )
}

// Stat-tile de la librería: icono + label y número grande en negrita
function Stat({ label, value, icon: Icon }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <UICard className="py-3 gap-0">
      <CardContent className="px-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
          {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />} {label}
        </div>
        <div className="text-2xl font-bold tracking-tight text-foreground tabular-nums mt-0.5">{value}</div>
      </CardContent>
    </UICard>
  )
}

function Empty({ msg }: { msg: string }) {
  return <p className="text-sm text-muted-foreground">{msg}</p>
}

// Tooltip de dinero para los charts
const moneyTooltip = (label: string) => (value: unknown) => (
  <div className="flex w-full items-center justify-between gap-4">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono font-medium tabular-nums text-foreground">{money(Number(value))}</span>
  </div>
)

// ── Comparación — BarChart vertical oficial (actual azul, anterior gris) ──
function ComparisonChart({ label, cur, prev }: { label: string; cur: number; prev: number }) {
  const data = [
    { name: label, total: cur, fill: 'var(--chart-1)' },
    { name: 'Anterior', total: prev, fill: 'var(--muted-foreground)' },
  ]
  return (
    <ChartContainer config={{ total: { label: 'Ventas' } }} className="aspect-auto h-48 w-full">
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

// ── FAQ — BarChart horizontal oficial (temas por cantidad de consultas) ──
function FaqChart({ rows }: { rows: { topic: string; count: number }[] }) {
  return (
    <ChartContainer config={{ count: { label: 'Consultas', color: 'var(--chart-1)' } }}
      className="aspect-auto w-full" style={{ height: Math.max(rows.length * 36 + 16, 88) }}>
      <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 28 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" hide />
        <YAxis dataKey="topic" type="category" tickLine={false} axisLine={false} width={110} tick={{ fontSize: 11 }} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={4} maxBarSize={18}>
          <LabelList dataKey="count" position="right" className="fill-muted-foreground" fontSize={11} />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

// Barras horizontales con el Progress de la librería: VALOR DIRECTO en texto
// (nunca color como única identidad), title = tooltip nativo.
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
