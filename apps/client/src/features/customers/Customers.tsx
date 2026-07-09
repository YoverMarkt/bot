import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as custApi from './api'
import type { Customer } from './api'

const { money } = custApi

const STATUS_BADGE: Record<Customer['status'], { label: string; cls: string }> = {
  nuevo:     { label: '🆕 Nuevo',      cls: 'bg-blue-50 text-blue-700' },
  frecuente: { label: '⭐ Frecuente',  cls: 'bg-green-50 text-green-700' },
  activo:    { label: '✅ Activo',     cls: 'bg-stone-100 text-stone-600' },
  inactivo:  { label: '😴 Inactivo',   cls: 'bg-amber-50 text-amber-700' },
}

export default function Customers() {
  const [tab, setTab] = useState<'directory' | 'reactivate'>('directory')
  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">Clientes</h1>
          <p className="text-sm text-stone-500">Directorio de compradores y contactos por reactivar</p>
        </div>
        <div className="flex gap-1 bg-white border border-stone-200 rounded-lg p-1">
          {([['directory', '📇 Directorio'], ['reactivate', '📤 Reactivar']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setTab(v)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === v ? 'bg-green-600 text-white' : 'text-stone-600 hover:bg-stone-50'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {tab === 'directory' ? <Directory /> : <Reactivate />}
    </div>
  )
}

// ── Directorio: quiénes te han comprado, cuánto y hace cuánto ──
function Directory() {
  const { data: customers = [], isLoading } = useQuery({ queryKey: ['customers'], queryFn: custApi.getCustomers })
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'todos' | Customer['status']>('todos')

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return customers
      .filter(c => filter === 'todos' || c.status === filter)
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q))
  }, [customers, search, filter])

  if (isLoading) return <p className="text-stone-500">Cargando directorio…</p>

  const counts = customers.reduce((acc, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc }, {} as Record<string, number>)

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o teléfono…"
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-green-500" />
        {(['todos', 'nuevo', 'frecuente', 'activo', 'inactivo'] as const).map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`text-xs rounded-lg px-2.5 py-1.5 font-medium border ${filter === s ? 'border-green-600 bg-green-50 text-green-800' : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50'}`}>
            {s === 'todos' ? `Todos (${customers.length})` : `${STATUS_BADGE[s].label} (${counts[s] ?? 0})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-stone-500">No hay clientes{search || filter !== 'todos' ? ' con ese filtro' : ' aún — se llenan solos al registrar ventas'}.</p>
      ) : (
        <div className="bg-white rounded-xl border border-stone-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-stone-500 border-b border-stone-100">
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Compras</th>
                <th className="px-4 py-3 text-right">Total gastado</th>
                <th className="px-4 py-3 text-right">Última compra</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.phone} className="border-b border-stone-50 hover:bg-stone-50">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-stone-900">{c.name}</div>
                    <div className="text-xs text-stone-400">{c.phone}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[11px] font-semibold rounded px-2 py-0.5 ${STATUS_BADGE[c.status].cls}`}>{STATUS_BADGE[c.status].label}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">{c.orders}</td>
                  <td className="px-4 py-2.5 text-right font-semibold">{money(c.total)}</td>
                  <td className="px-4 py-2.5 text-right text-stone-500">hace {c.daysSince} día(s)</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Reactivar: contactos con tiempo sin escribir + exportar a Excel ──
function Reactivate() {
  const [days, setDays] = useState(15)
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['inactive', days],
    queryFn: () => custApi.getInactive(days),
  })

  function exportExcel() {
    custApi.exportCSV(
      `clientes-sin-escribir-${days}dias.csv`,
      ['Nombre', 'Teléfono', 'Días sin escribir', '¿Compró?', 'Compras', 'Total gastado', 'Último mensaje'],
      rows.map(r => [r.name, r.phone, r.daysSince, r.hasPurchased ? 'Sí' : 'No', r.orders, (Number(r.total) || 0).toFixed(2), r.lastMessage ?? ''])
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm text-stone-600">Sin escribir hace</label>
        <select value={days} onChange={e => setDays(parseInt(e.target.value))}
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500">
          {[7, 15, 30, 60, 90].map(d => <option key={d} value={d}>{d} días o más</option>)}
        </select>
        <button onClick={exportExcel} disabled={!rows.length}
          className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-4 py-2 text-sm">
          📤 Exportar a Excel ({rows.length})
        </button>
      </div>

      {isLoading ? <p className="text-stone-500">Buscando contactos…</p> :
        rows.length === 0 ? <p className="text-sm text-stone-500">🎉 Nadie lleva {days}+ días sin escribir.</p> : (
          <div className="bg-white rounded-xl border border-stone-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-stone-500 border-b border-stone-100">
                  <th className="px-4 py-3">Contacto</th>
                  <th className="px-4 py-3 text-right">Días sin escribir</th>
                  <th className="px-4 py-3">Historial</th>
                  <th className="px-4 py-3">Último mensaje</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.phone} className="border-b border-stone-50 hover:bg-stone-50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-stone-900">{r.name}</div>
                      <div className="text-xs text-stone-400">{r.phone}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-amber-700">{r.daysSince}</td>
                    <td className="px-4 py-2.5">
                      {r.hasPurchased
                        ? <span className="text-xs text-green-700">🛒 {r.orders} compra(s) · {money(r.total)}</span>
                        : <span className="text-xs text-stone-400">Solo preguntó</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-stone-500 max-w-[280px] truncate">{r.lastMessage ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
