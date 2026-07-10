import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, session } from '../../api/client'
import { getAlerts } from '../reports/api'

// ── INICIO (port fiel del dashboard BI del panel viejo):
// KPIs + línea de ventas por día + comparación + top + donas de
// clientes/inventario + banner de alertas + checklist de onboarding.

// Paleta del sistema (skill graficos-dashboard — CVD-safe, orden fijo)
const C1 = '#2a78d6', C2 = '#1baf7a', C3 = '#eda100', C4 = '#008300'
const GOOD = '#22c55e', WARN = '#f59e0b', CRIT = '#ef4444'
const INK = '#1e1e1e'

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

// Mapa de páginas del viejo → rutas del panel React (para el checklist)
const PAGE_ROUTE: Record<string, string> = {
  products: '/catalog', botprompt: '/settings', policies: '/settings',
  settings: '/settings', schedule: '/schedule', conversations: '/conversations',
}

const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`   // centavos EXACTOS, siempre

const ALERT_STYLE: Record<string, string> = {
  critical: 'bg-red-50 border-red-200 text-red-800',
  warning:  'bg-amber-50 border-amber-200 text-amber-800',
  good:     'bg-green-50 border-green-200 text-green-800',
  info:     'bg-blue-50 border-blue-200 text-blue-800',
}

const PERIODS = [
  { value: 'hoy',    label: 'Hoy' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes',    label: 'Mes' },
] as const

export default function Dashboard() {
  const [period, setPeriod] = useState<string>('mes')
  const isOwner = session.user?.role === 'owner'
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => api<DashboardData>(`/api/client/dashboard?period=${period}`),
  })
  const { data: alertsData } = useQuery({ queryKey: ['alerts'], queryFn: getAlerts, staleTime: 60_000 })
  const { data: onboarding } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api<Onboarding>('/api/client/onboarding'),
    enabled: isOwner,
    staleTime: 60_000,
  })

  if (isLoading) return <p className="text-stone-500">Cargando tu negocio…</p>
  if (error) return <p className="text-red-600">❌ {(error as Error).message}</p>
  if (!data) return null

  const k = data.kpis
  const pct = data.comparison.pct
  const conv = k.conversion == null ? '—' : `${Math.round(k.conversion)}%`
  const cs = data.customersByStatus

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">Inicio</h1>
          <p className="text-sm text-stone-500">Resumen de {data.label}</p>
        </div>
        <div className="flex gap-1 bg-white border border-stone-200 rounded-lg p-1">
          {PERIODS.map(p => (
            <button
              key={p.value} onClick={() => setPeriod(p.value)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                period === p.value ? 'bg-green-600 text-white' : 'text-stone-600 hover:bg-stone-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

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
        <Card title={`📈 Ventas por día (últimos ${data.trend?.days ?? 7} días)`} full>
          <LineChart rows={data.trend?.rows ?? []} />
        </Card>
        <Card title={`💰 Ventas: ${data.label} vs anterior`}>
          <Bars color={C1} rows={[
            { label: data.label, value: Number(data.comparison.curTotal) || 0, text: money(data.comparison.curTotal) },
            { label: 'Anterior', value: Number(data.comparison.prevTotal) || 0, text: money(data.comparison.prevTotal) },
          ]} />
        </Card>
        <Card title="🏆 Productos más vendidos">
          {data.top.length === 0 ? <p className="text-sm text-stone-500">Sin ventas en el período.</p> :
            <Bars color={INK} rows={data.top.map(t => ({ label: t.name, value: t.qty, text: `${t.qty} uds` }))} />}
        </Card>
        <Card title="👥 Clientes por estado">
          <Donut center="clientes" segs={[
            { label: 'Nuevos', value: cs?.nuevos ?? 0, color: C1 },
            { label: 'Frecuentes', value: cs?.frecuentes ?? 0, color: C2 },
            { label: 'Activos', value: cs?.activos ?? 0, color: C3 },
            { label: 'Inactivos', value: cs?.inactivos ?? 0, color: C4 },
          ]} />
        </Card>
        <Card title="📦 Inventario">
          <Donut center="productos" segs={[
            { label: 'Disponible', value: data.stock.disponible, color: GOOD },
            { label: 'Últimas unidades', value: data.stock.ultimas, color: WARN },
            { label: 'Agotado', value: data.stock.agotado, color: CRIT },
          ]} />
        </Card>
      </div>
    </div>
  )
}

function OnboardingCard({ d }: { d: Onboarding }) {
  const navigate = useNavigate()
  return (
    <div className="bg-white rounded-xl border-2 border-green-300 p-5 mb-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-stone-900">🚀 Configura tu bot para vender</h2>
        <strong className="text-stone-900">{d.done}/{d.total}</strong>
      </div>
      <div className="h-2 bg-stone-100 rounded-full overflow-hidden my-3">
        <div className="h-full bg-green-600 rounded-full transition-all" style={{ width: `${d.pct}%` }} />
      </div>
      {d.steps.map((s, i) => (
        <div key={i} className="flex items-center gap-3 py-2 border-b border-stone-50 last:border-0 text-sm">
          <span>{s.done ? '✅' : '⬜'}</span>
          <span className={`flex-1 ${s.done ? 'text-stone-400 line-through' : 'text-stone-700'}`}>
            {s.label}{s.hint && <span className="text-stone-400 text-xs"> · {s.hint}</span>}
          </span>
          {!s.done && s.page && (
            <button onClick={() => navigate(PAGE_ROUTE[s.page!] ?? '/')}
              className="rounded-lg border border-stone-200 text-xs px-2.5 py-1 hover:bg-stone-50">Configurar →</button>
          )}
        </div>
      ))}
    </div>
  )
}

function Kpi({ label, value, sub, good }: { label: string; value: string; sub: string; good?: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4">
      <div className="text-[10px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className="text-2xl font-bold text-stone-900 mt-1">{value}</div>
      {sub && <div className={`text-xs mt-1 ${good === undefined ? 'text-stone-500' : good ? 'text-green-700' : 'text-red-600'}`}>{sub}</div>}
    </div>
  )
}

function Card({ title, children, full }: { title: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`bg-white rounded-xl border border-stone-200 p-5 ${full ? 'lg:col-span-2' : ''}`}>
      <h2 className="font-semibold text-stone-900 mb-3">{title}</h2>
      {children}
    </div>
  )
}

// ── Gráfico de línea (SVG puro — skill graficos-dashboard) ──
function LineChart({ rows }: { rows: { label: string; total: number }[] }) {
  if (!rows.length) return <p className="text-sm text-stone-500">Sin datos aún.</p>
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
              <text x={x(i)} y={y(r.total) - 8} textAnchor="middle" fontSize="10" fill="#57534e">{money(r.total)}</text>
            )}
            <text x={x(i)} y={H + 14} textAnchor="middle" fontSize="10" fill="#a8a29e">{r.label}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ── Dona (SVG puro) con leyenda al lado — nunca color como única identidad ──
function Donut({ segs, center }: { segs: { label: string; value: number; color: string }[]; center: string }) {
  const total = segs.reduce((s, x) => s + x.value, 0)
  if (!total) return <p className="text-sm text-stone-500">Sin datos aún.</p>
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
        <text x="55" y="66" textAnchor="middle" fontSize="9" fill="#a8a29e">{center}</text>
      </svg>
      <ul className="text-sm space-y-1.5">
        {segs.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-stone-700">{s.label}</span>
            <span className="text-stone-500 font-semibold ml-1">{s.value}</span>
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
            <span className="text-stone-700 truncate">{r.label}</span>
            <span className="text-stone-500 shrink-0 ml-2">{r.text}</span>
          </div>
          <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.max((r.value / max) * 100, 2)}%`, backgroundColor: color }} />
          </div>
        </div>
      ))}
    </div>
  )
}
