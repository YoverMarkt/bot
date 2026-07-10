import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getReports, getAlerts, money, type Alert } from './api'
import { BarChart3, UserRound, ClipboardList, Trophy, Search, ShoppingCart, Snail, Package, Handshake, Frown, Brain, HelpCircle, Users, DollarSign, Bot as BotIcon } from 'lucide-react'

// Paleta del sistema (skill graficos-dashboard — validada CVD-safe, orden fijo):
// serie única = tinta INK; c1 azul para comparación/vendedores; c2 aqua SIEMPRE
// con valor directo (regla de relieve). Estados reservados para stock/alertas.
const INK = 'var(--foreground)'
const C1 = 'var(--chart-1)'
const C2 = 'var(--chart-2)'

const ALERT_STYLE: Record<Alert['level'], string> = {
  critical: 'bg-red-50 border-red-200 text-red-800',
  warning:  'bg-amber-50 border-amber-200 text-amber-800',
  good:     'bg-primary/10 border-green-200 text-primary',
  info:     'bg-blue-50 border-blue-200 text-blue-800',
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
            <button key={v} onClick={() => setPeriod(v)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${period === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Atajo a reactivar (igual que el viejo) */}
      <div className="mb-4">
        <Link to="/reactivate" className="inline-block rounded-lg border border-border bg-white text-sm text-foreground/90 px-3 py-1.5 hover:bg-muted/50">
          <span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> Clientes sin escribir (reactivar)</span>
        </Link>
      </div>

      {/* Banner de alertas */}
      {alertsData && alertsData.alerts.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {alertsData.alerts.map((a, i) => (
            <span key={i} className={`text-xs font-medium rounded-lg border px-2.5 py-1.5 ${ALERT_STYLE[a.level]}`}>
              {a.icon} {a.text}
            </span>
          ))}
        </div>
      )}

      {/* Filtro por categoría (mismas del panel viejo) */}
      <div className="mb-4 flex flex-wrap gap-2">
        {CATS.map(([v, l]) => (
          <button key={v} onClick={() => setCat(v)}
            className={`rounded-lg text-xs font-medium px-3 py-1.5 border ${cat === v ? 'bg-green-600 border-green-600 text-white' : 'bg-white border-border text-muted-foreground hover:bg-muted/50'}`}>
            {l}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-muted-foreground">Calculando reportes…</p>}
      {error && <p className="text-destructive">❌ {(error as Error).message}</p>}
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
              <Bars color={C1} rows={[
                { label: data.comparison.label, value: Number(data.comparison.curTotal) || 0, text: money(data.comparison.curTotal) },
                { label: 'Anterior', value: Number(data.comparison.prevTotal) || 0, text: money(data.comparison.prevTotal) },
              ]} />
              <p className="text-xs text-muted-foreground mt-2">
                {data.comparison.curOrders} vs {data.comparison.prevOrders} pedidos · Variación:{' '}
                {data.comparison.pct === null
                  ? (data.comparison.curTotal > 0 ? '🚀 sin base anterior' : 'sin datos')
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
                <Bars color={C1} rows={data.bySeller.rows.map(r => ({ label: r.name, value: Number(r.total) || 0, text: money(r.total) }))} />}
            </Card>
            </>)}
            {/* Pendientes */}
            {show('ventas') && (<>
            <Card title={`Pedidos sin cerrar${data.pending.count ? ` (${data.pending.count})` : ''}`} icon={ClipboardList}>
              {data.pending.rows.length === 0 ? <Empty msg="No hay cotizaciones sin cerrar. ✅" /> :
                <ul className="text-sm space-y-1">
                  {data.pending.rows.map((r, i) => <li key={i} className="truncate text-foreground/90">{r.name}{r.last_message ? <span className="text-muted-foreground/80"> — “{r.last_message.slice(0, 40)}”</span> : null}</li>)}
                </ul>}
            </Card>
            </>)}
            {/* Top productos */}
            {show('productos') && (<>
            <Card title="Productos más vendidos" icon={Trophy}>
              {data.top.rows.length === 0 ? <Empty msg="Sin ventas en el período." /> :
                <Bars color={INK} rows={data.top.rows.map(r => ({ label: r.name, value: r.qty, text: `${r.qty} uds · ${money(r.rev)}` }))} />}
            </Card>
            </>)}
            {/* Más consultados (c2 → regla de relieve: valor directo SIEMPRE) */}
            {show('productos') && (<>
            <Card title="Más consultados" icon={Search}>
              {data.mostConsulted.rows.length === 0 ? <Empty msg="Sin consultas registradas." /> :
                <Bars color={C2} rows={data.mostConsulted.rows.map(r => ({ label: r.name, value: r.count, text: `${r.count} consultas` }))} />}
            </Card>
            </>)}
            {/* Abandonados */}
            {show('productos') && (<>
            <Card title="Productos abandonados (consultados sin vender)" icon={ShoppingCart}>
              {data.abandoned.rows.length === 0 ? <Empty msg="Nada abandonado. 🎉" /> :
                <ul className="text-sm space-y-1">
                  {data.abandoned.rows.map((r, i) => <li key={i} className="flex justify-between"><span className="truncate text-foreground/90">{r.name}</span><span className="text-muted-foreground ml-2 shrink-0">{r.consultas} consultas</span></li>)}
                </ul>}
            </Card>
            </>)}
            {/* Bajo movimiento */}
            {show('productos') && (<>
            <Card title="Bajo movimiento (candidatos a promo)" icon={Snail}>
              {data.lowMovement.rows.length === 0 ? <Empty msg="Todos tus productos tuvieron ventas. 🎉" /> :
                <ul className="text-sm space-y-1">
                  {data.lowMovement.rows.map((r, i) => <li key={i} className="flex justify-between"><span className="truncate text-foreground/90">{r.name}</span><span className="text-muted-foreground ml-2 shrink-0">{r.qty} uds</span></li>)}
                </ul>}
            </Card>
            </>)}
            {/* Stock bajo (colores de ESTADO reservados) */}
            {show('productos') && (<>
            <Card title="Stock bajo o agotado" icon={Package}>
              {data.lowStock.rows.length === 0 ? <Empty msg="Nada agotado ni en últimas unidades. ✅" /> :
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
                      <span className="text-foreground/90 truncate">{['🥇','🥈','🥉'][i] ?? `${i + 1}.`} {r.name}</span>
                      <span className="text-muted-foreground shrink-0 ml-2">{r.orders} compra(s) · {money(r.total)}</span>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
            {/* Clientes perdidos */}
            {show('clientes') && (<>
            <Card title="Clientes perdidos (escribieron sin comprar)" icon={Frown}>
              {data.lostCustomers.rows.length === 0 ? <Empty msg="Nadie se quedó sin comprar. 🎉" /> :
                <>
                  <p className="text-xs text-muted-foreground mb-2">🔁 {data.lostCustomers.returning} ya-cliente · 🆕 {data.lostCustomers.nuevos} nuevos · {data.lostCustomers.noRespondio} sin respuesta del negocio</p>
                  <ul className="text-sm space-y-1">
                    {data.lostCustomers.rows.map((r, i) => (
                      <li key={i} className="flex justify-between">
                        <span className="truncate text-foreground/90">{r.returning ? '🔁' : '🆕'} {r.name}</span>
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
                <Bars color={INK} rows={data.faq.rows.filter(r => r.count > 0).map(r => ({ label: `${r.emoji} ${r.topic}`, value: r.count, text: String(r.count) }))} />}
            </Card>

            <Card title="Preguntas que la IA no pudo responder" icon={HelpCircle}>
              {data.unanswered.rows.length === 0 ? <Empty msg="El bot pudo con todo. 💪" /> :
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
    <div className="bg-card rounded-xl border p-5">
      <h2 className="font-semibold text-foreground mb-3 flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-muted-foreground" />}{title}</h2>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card rounded-xl border px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-bold text-foreground">{value}</div>
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <p className="text-sm text-muted-foreground">{msg}</p>
}

// Barras horizontales (skill graficos-dashboard): CSS puro, marca fina con
// extremo redondeado anclada al inicio, VALOR DIRECTO en texto (nunca color
// como única identidad), texto en tinta neutra, title = tooltip nativo.
function Bars({ rows, color }: { rows: { label: string; value: number; text: string }[]; color: string }) {
  const max = Math.max(...rows.map(r => r.value), 0.0001)
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} title={`${r.label}: ${r.text}`}>
          <div className="flex justify-between text-xs mb-0.5">
            <span className="text-foreground/90 truncate">{r.label}</span>
            <span className="text-muted-foreground shrink-0 ml-2">{r.text}</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.max((r.value / max) * 100, 2)}%`, backgroundColor: color }} />
          </div>
        </div>
      ))}
    </div>
  )
}
