import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getReports, getAlerts, money, type Alert } from './api'
import { BarChart3, UserRound, ClipboardList, Trophy, Search, ShoppingCart, Snail, Package, Handshake, Frown, Brain, HelpCircle, Users, DollarSign, Bot as BotIcon, Repeat2, Sparkles, PackageX, PackageMinus, TrendingDown, TrendingUp, UserMinus, Moon, CreditCard, CircleAlert, TriangleAlert, CircleCheck, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card as UICard, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'

// Paleta del sistema (skill graficos-dashboard — validada CVD-safe, orden fijo):
// Barras horizontales = Progress de la librería (valor directo SIEMPRE,
// regla de relieve). Estados reservados para stock/alertas.

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
        <div className="flex gap-1 bg-card border rounded-lg p-1">
          {PERIODS.map(([v, l]) => (
            <Button variant="ghost" key={v} onClick={() => setPeriod(v)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${period === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>
              {l}
            </Button>
          ))}
        </div>
      </div>

      {/* Atajo a reactivar (igual que el viejo) */}
      <div className="mb-4">
        <Link to="/reactivate" className="inline-block rounded-lg border border-border bg-card text-sm text-foreground/90 px-3 py-1.5 hover:bg-muted/50">
          <span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> Clientes sin escribir (reactivar)</span>
        </Link>
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
      <div className="mb-4 flex flex-wrap gap-2">
        {CATS.map(([v, l]) => (
          <Button variant="ghost" key={v} onClick={() => setCat(v)}
            className={`rounded-lg text-xs font-medium px-3 py-1.5 border ${cat === v ? 'bg-primary border-primary text-primary-foreground' : 'bg-card border-border text-muted-foreground hover:bg-muted/50'}`}>
            {l}
          </Button>
        ))}
      </div>

      {isLoading && <p className="text-muted-foreground">Calculando reportes…</p>}
      {error && <p className="text-destructive">✗ {(error as Error).message}</p>}
      {data && (
        <>
          {/* Resumen del período */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-5">
            <Stat label="Total vendido" value={money(data.summary.total)} />
            <Stat label="Pedidos" value={String(data.summary.orders)} />
            <Stat label="Ítems" value={String(data.summary.items)} />
            <Stat label="Ticket promedio" value={money(data.summary.avg)} />
            <Stat label="Nuevos" value={String(data.summary.nuevos)} />
            <Stat label="Recurrentes" value={String(data.summary.recurrentes)} />
            <Stat label="Conversión" value={data.summary.conversion === null ? '—' : `${Math.round(data.summary.conversion)}%`} />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* Comparación */}
            {show('ventas') && (<>
            <Card title="Comparación con período anterior" icon={BarChart3}>
              <Bars rows={[
                { label: data.comparison.label, value: Number(data.comparison.curTotal) || 0, text: money(data.comparison.curTotal) },
                { label: 'Anterior', value: Number(data.comparison.prevTotal) || 0, text: money(data.comparison.prevTotal) },
              ]} />
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
            <Card title={`Pedidos sin cerrar${data.pending.count ? ` (${data.pending.count})` : ''}`} icon={ClipboardList}>
              {data.pending.rows.length === 0 ? <Empty msg="No hay cotizaciones sin cerrar." /> :
                <ul className="text-sm space-y-1">
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
            {/* Más consultados (c2 → regla de relieve: valor directo SIEMPRE) */}
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
                <ul className="text-sm space-y-1">
                  {data.abandoned.rows.map((r, i) => <li key={i} className="flex justify-between"><span className="truncate text-foreground/90">{r.name}</span><span className="text-muted-foreground ml-2 shrink-0">{r.consultas} consultas</span></li>)}
                </ul>}
            </Card>
            </>)}
            {/* Bajo movimiento */}
            {show('productos') && (<>
            <Card title="Bajo movimiento (candidatos a promo)" icon={Snail}>
              {data.lowMovement.rows.length === 0 ? <Empty msg="Todos tus productos tuvieron ventas." /> :
                <ul className="text-sm space-y-1">
                  {data.lowMovement.rows.map((r, i) => <li key={i} className="flex justify-between"><span className="truncate text-foreground/90">{r.name}</span><span className="text-muted-foreground ml-2 shrink-0">{r.qty} uds</span></li>)}
                </ul>}
            </Card>
            </>)}
            {/* Stock bajo (colores de ESTADO reservados) */}
            {show('productos') && (<>
            <Card title="Stock bajo o agotado" icon={Package}>
              {data.lowStock.rows.length === 0 ? <Empty msg="Nada agotado ni en últimas unidades." /> :
                <ul className="text-sm space-y-1">
                  {data.lowStock.rows.map((r, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${r.stock === 'agotado' ? 'bg-red-500' : 'bg-amber-500'}`} />
                      <span className="truncate text-foreground/90 flex-1">{r.name}</span>
                      <span className="text-xs text-muted-foreground">{r.stock}</span>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
            {/* Clientes frecuentes */}
            {show('clientes') && (<>
            <Card title="Clientes frecuentes" icon={Handshake}>
              {data.recurring.rows.length === 0 ? <Empty msg="Aún sin clientes recurrentes." /> :
                <ul className="text-sm space-y-1.5">
                  {data.recurring.rows.map((r, i) => (
                    <li key={i} className="flex justify-between">
                      <span className="text-foreground/90 truncate"><span className={`font-semibold ${i < 3 ? 'text-primary' : 'text-muted-foreground'}`}>{i + 1}.</span> {r.name}</span>
                      <span className="text-muted-foreground shrink-0 ml-2">{r.orders} compra(s) · {money(r.total)}</span>
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
                  <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1 flex-wrap"><Repeat2 className="w-3.5 h-3.5" /> {data.lostCustomers.returning} ya-cliente · <Sparkles className="w-3.5 h-3.5" /> {data.lostCustomers.nuevos} nuevos · {data.lostCustomers.noRespondio} sin respuesta del negocio</p>
                  <ul className="text-sm space-y-1">
                    {data.lostCustomers.rows.map((r, i) => (
                      <li key={i} className="flex justify-between">
                        <span className="truncate text-foreground/90 flex items-center gap-1.5">{r.returning ? <Repeat2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <Sparkles className="w-3.5 h-3.5 text-muted-foreground shrink-0" />} {r.name}</span>
                        {r.reason && <span className="text-xs text-muted-foreground/80 shrink-0 ml-2">{r.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </>}
            </Card>
            </>)}
            {/* Reporte de IA: FAQ + sin responder */}
            {show('bot') && (<>
            <Card title="Preguntas más frecuentes" icon={Brain}>
              {data.faq.rows.length === 0 ? <Empty msg="Sin datos suficientes aún." /> :
                <Bars rows={data.faq.rows.filter(r => r.count > 0).map(r => ({ label: r.topic, value: r.count, text: String(r.count) }))} />}
            </Card>

            <Card title="Preguntas que la IA no pudo responder" icon={HelpCircle}>
              {data.unanswered.rows.length === 0 ? <Empty msg="El bot pudo con todo." /> :
                <ul className="text-sm space-y-1">
                  {data.unanswered.rows.map((r, i) => <li key={i} className="text-foreground/90 truncate">“{r.question ?? '—'}” <span className="text-muted-foreground/80">×{r.count}</span></li>)}
                </ul>}
            </Card>
            </>)}
          </div>
        </>
      )}
    </div>
  )
}

function Card({ title, icon: Icon, children }: { title: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <UICard className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">{Icon && <Icon className="w-4 h-4 text-muted-foreground" />}{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </UICard>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <UICard className="py-3 gap-0">
      <CardContent className="px-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold tracking-tight text-foreground tabular-nums">{value}</div>
      </CardContent>
    </UICard>
  )
}

function Empty({ msg }: { msg: string }) {
  return <p className="text-sm text-muted-foreground">{msg}</p>
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
