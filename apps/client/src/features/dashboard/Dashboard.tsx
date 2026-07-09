import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'

// Forma real de GET /api/client/dashboard (reports.getDashboard en el server)
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
}

const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`   // centavos EXACTOS, siempre

const PERIODS = [
  { value: 'hoy',    label: 'Hoy' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes',    label: 'Mes' },
] as const

export default function Dashboard() {
  const [period, setPeriod] = useState<string>('mes')
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => api<DashboardData>(`/api/client/dashboard?period=${period}`),
  })

  if (isLoading) return <p className="text-stone-500">Cargando tu negocio…</p>
  if (error) return <p className="text-red-600">❌ {(error as Error).message}</p>
  if (!data) return null

  const k = data.kpis
  const pct = data.comparison.pct

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
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

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Kpi label="Total vendido" value={money(k.total)} sub={pct === null ? '' : `${pct >= 0 ? '▲ +' : '▼ '}${Math.abs(pct).toFixed(0)}% vs período anterior`} good={pct !== null && pct >= 0} />
        <Kpi label="Pedidos" value={String(k.orders)} sub={`${k.items} ítems vendidos`} />
        <Kpi label="Ticket promedio" value={money(k.avg)} sub="" />
        <Kpi label="Contactos" value={String(k.clientes)} sub="Personas que escribieron en el chat" />
      </div>

      {/* Top productos + stock */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-stone-200 p-5">
          <h2 className="font-semibold text-stone-900 mb-3">🏆 Productos más vendidos</h2>
          {data.top.length === 0
            ? <p className="text-sm text-stone-500">Sin ventas en el período.</p>
            : data.top.map((t, i) => (
              <div key={t.name} className="flex items-center justify-between py-1.5 text-sm border-b border-stone-100 last:border-0">
                <span className="text-stone-700 truncate">{['🥇','🥈','🥉'][i] ?? `${i + 1}.`} {t.name}</span>
                <span className="text-stone-500 shrink-0 ml-3">{t.qty} uds · {money(t.rev)}</span>
              </div>
            ))}
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-5">
          <h2 className="font-semibold text-stone-900 mb-3">📦 Estado del catálogo</h2>
          <div className="space-y-2 text-sm">
            <StockRow color="bg-green-500" label="Disponible" value={data.stock.disponible} />
            <StockRow color="bg-amber-500" label="Últimas unidades" value={data.stock.ultimas} />
            <StockRow color="bg-red-500" label="Agotado" value={data.stock.agotado} />
          </div>
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, good }: { label: string; value: string; sub: string; good?: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="text-2xl font-bold text-stone-900 mt-1">{value}</div>
      {sub && <div className={`text-xs mt-1 ${good === undefined ? 'text-stone-500' : good ? 'text-green-700' : 'text-red-600'}`}>{sub}</div>}
    </div>
  )
}

function StockRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-stone-700 flex-1">{label}</span>
      <span className="font-semibold text-stone-900">{value}</span>
    </div>
  )
}
