import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, session } from '../../api/client'
import { getAlerts } from '../reports/api'
import { getProducts } from '../catalog/api'
import { useBusinessInfo } from '../../lib/biz'
import { TrendingUp, DollarSign, Trophy, Users, Package, Rocket, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ── INICIO (port fiel del dashboard BI del panel viejo):
// KPIs + línea de ventas por día + comparación + top + donas de
// clientes/inventario + banner de alertas + checklist de onboarding.

// Paleta del sistema (skill graficos-dashboard — CVD-safe, orden fijo)
const C1 = 'var(--chart-1)', C2 = 'var(--chart-2)', C3 = 'var(--chart-3)', C4 = 'var(--chart-4)'
const GOOD = '#22c55e', WARN = '#f59e0b', CRIT = '#ef4444'
const INK = 'var(--foreground)'

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
  critical: 'bg-red-50 border-red-200 text-red-800',
  warning:  'bg-amber-50 border-amber-200 text-amber-800',
  good:     'bg-primary/10 border-green-200 text-primary',
  info:     'bg-blue-50 border-blue-200 text-blue-800',
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
                <Button
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
          <Button onClick={() => navigate('/catalog?new=1')}
            className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold px-4 py-2">
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
          {alertsData.alerts.map((a, i) => (
            <span key={i} className={`text-xs font-medium rounded-lg border px-2.5 py-1.5 ${ALERT_STYLE[a.level] ?? ALERT_STYLE.info}`}>
              {a.icon} {a.text}
            </span>
          ))}
        </div>
      )}

      {/* BI (solo con permiso de reportes, como el viejo) */}
      {canReports && data && k && (<>
      {/* KPIs (mismos 5 del viejo) */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <Kpi label={`Ventas (${data.label})`} value={money(k.total)} sub={pct === null ? '' : `${pct >= 0 ? '▲ +' : '▼ '}${Math.abs(pct).toFixed(0)}% vs período anterior`} good={pct !== null && pct >= 0} />
        <Kpi label="Pedidos" value={String(k.orders)} sub={`${k.items} ítems vendidos`} />
        <Kpi label="Ticket promedio" value={money(k.avg)} sub="" />
        <Kpi label="Conversión" value={conv} sub="Contactos que compraron" />
        <Kpi label="Clientes" value={String(k.clientes)} sub="Personas que escribieron en el chat" />
      </div>

      {/* Gráficos (mismo grid del viejo) */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title={`Ventas por día (últimos ${data.trend?.days ?? 7} días)`} icon={TrendingUp} full>
          <LineChart rows={data.trend?.rows ?? []} />
        </Card>
        <Card title={`Ventas: ${data.label} vs anterior`} icon={DollarSign}>
          <Bars color={C1} rows={[
            { label: data.label, value: Number(data.comparison.curTotal) || 0, text: money(data.comparison.curTotal) },
            { label: 'Anterior', value: Number(data.comparison.prevTotal) || 0, text: money(data.comparison.prevTotal) },
          ]} />
        </Card>
        <Card title="Productos más vendidos" icon={Trophy}>
          {data.top.length === 0 ? <p className="text-sm text-muted-foreground">Sin ventas en el período.</p> :
            <Bars color={INK} rows={data.top.map(t => ({ label: t.name, value: t.qty, text: `${t.qty} uds` }))} />}
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
          <Kpi label="Productos" value={String(quick.totalProducts)} sub="En catálogo" />
          <Kpi label="Disponibles" value={String(quick.availableProducts)} sub="Con stock" />
          <Kpi label="Mensajes hoy" value={String(quick.messagesToday)} sub="Respondidos" />
          <Kpi label="Contactos" value={String(quick.totalContacts)} sub="Personas que escribieron en el chat" />
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
    <div className="bg-white rounded-xl border-2 border-green-300 p-5 mb-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground flex items-center gap-2"><Rocket className="w-4 h-4 text-primary" /> Configura tu bot para vender</h2>
        <strong className="text-foreground">{d.done}/{d.total}</strong>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden my-3">
        <div className="h-full bg-green-600 rounded-full transition-all" style={{ width: `${d.pct}%` }} />
      </div>
      {d.steps.map((s, i) => (
        <div key={i} className="flex items-center gap-3 py-2 border-b border-border/40 last:border-0 text-sm">
          <span>{s.done ? '✓' : '⬜'}</span>
          <span className={`flex-1 ${s.done ? 'text-muted-foreground/80 line-through' : 'text-foreground/90'}`}>
            {s.label}{s.hint && <span className="text-muted-foreground/80 text-xs"> · {s.hint}</span>}
          </span>
          {!s.done && s.page && (
            <Button onClick={() => navigate(PAGE_ROUTE[s.page!] ?? '/')}
              className="rounded-lg border border-border text-xs px-2.5 py-1 hover:bg-muted/50">Configurar →</Button>
          )}
        </div>
      ))}
    </div>
  )
}

function Kpi({ label, value, sub, good }: { label: string; value: string; sub: string; good?: boolean }) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold text-foreground mt-1">{value}</div>
      {sub && <div className={`text-xs mt-1 ${good === undefined ? 'text-muted-foreground' : good ? 'text-primary' : 'text-destructive'}`}>{sub}</div>}
    </div>
  )
}

function Card({ title, icon: Icon, children, full }: { title: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`bg-card rounded-xl border p-5 ${full ? 'lg:col-span-2' : ''}`}>
      <h2 className="font-semibold text-foreground mb-3 flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-muted-foreground" />}{title}</h2>
      {children}
    </div>
  )
}

// ── Gráfico de línea (SVG puro — skill graficos-dashboard) ──
function LineChart({ rows }: { rows: { label: string; total: number }[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Sin datos aún.</p>
  const W = 700, H = 160, PAD = 8
  const max = Math.max(...rows.map(r => r.total), 0.01)
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(rows.length - 1, 1)
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD)
  const path = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.total).toFixed(1)}`).join(' ')
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full min-w-[480px]">
        <path d={path} fill="none" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        {rows.map((r, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(r.total)} r="3.5" fill={INK}>
              <title>{r.label}: {money(r.total)}</title>
            </circle>
            {r.total > 0 && (
              <text x={x(i)} y={y(r.total) - 8} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">{money(r.total)}</text>
            )}
            <text x={x(i)} y={H + 14} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">{r.label}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ── Dona (SVG puro) con leyenda al lado — nunca color como única identidad ──
function Donut({ segs, center }: { segs: { label: string; value: number; color: string }[]; center: string }) {
  const total = segs.reduce((s, x) => s + x.value, 0)
  if (!total) return <p className="text-sm text-muted-foreground">Sin datos aún.</p>
  const R = 42, CIRC = 2 * Math.PI * R
  let acc = 0
  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg viewBox="0 0 110 110" className="w-32 h-32 shrink-0">
        {segs.filter(s => s.value > 0).map((s, i) => {
          const frac = s.value / total
          const dash = `${(frac * CIRC).toFixed(2)} ${(CIRC - frac * CIRC).toFixed(2)}`
          const off = -acc * CIRC
          acc += frac
          return <circle key={i} cx="55" cy="55" r={R} fill="none" stroke={s.color} strokeWidth="14"
            strokeDasharray={dash} strokeDashoffset={off} transform="rotate(-90 55 55)">
            <title>{s.label}: {s.value}</title>
          </circle>
        })}
        <text x="55" y="52" textAnchor="middle" fontSize="18" fontWeight="700" fill={INK}>{total}</text>
        <text x="55" y="66" textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">{center}</text>
      </svg>
      <ul className="text-sm space-y-1.5">
        {segs.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-foreground/90">{s.label}</span>
            <span className="text-muted-foreground font-semibold ml-1">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Barras horizontales (mismas de Reportes)
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
