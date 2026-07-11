import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as custApi from './api'
import { Repeat2, Sparkles, Download } from 'lucide-react'
import type { Customer } from './api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { money } = custApi

const STATUS_BADGE: Record<Customer['status'], { label: string; cls: string }> = {
  nuevo:     { label: 'Nuevo',      cls: 'bg-blue-50 text-blue-700' },
  frecuente: { label: 'Frecuente',  cls: 'bg-primary/10 text-primary' },
  activo:    { label: 'Activo',     cls: 'bg-muted text-muted-foreground' },
  inactivo:  { label: 'Inactivo',   cls: 'bg-amber-50 text-amber-700' },
}

export default function Customers() {
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Clientes</h1>
        <p className="text-sm text-muted-foreground">Directorio de tus clientes con su historial de compras.</p>
      </div>
      <Directory />
    </div>
  )
}

// ── Directorio: quiénes te han comprado, cuánto y hace cuánto ──
function Directory() {
  const { data: customers = [], isLoading } = useQuery({ queryKey: ['customers'], queryFn: custApi.getCustomers })
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return q ? customers.filter(c => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q)) : customers
  }, [customers, search])

  if (isLoading) return <p className="text-muted-foreground">Cargando…</p>

  const fecha = (iso: string) => new Date(iso).toLocaleDateString('es')

  return (
    <div>
      <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o teléfono..." className="w-full max-w-sm mb-4" />

      {!customers.length ? (
        <p className="text-sm text-muted-foreground">Aún no hay clientes con compras registradas.</p>
      ) : !filtered.length ? (
        <p className="text-sm text-muted-foreground">Ningún cliente coincide con la búsqueda.</p>
      ) : (
        <>
          <div className="bg-card rounded-xl border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border/60">
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Teléfono</th>
                  <th className="px-3 py-2">Última compra</th>
                  <th className="px-3 py-2">Total gastado</th>
                  <th className="px-3 py-2">Compras</th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.phone} className="border-b border-border/40 hover:bg-muted/50">
                    <td className="px-3 py-2 font-semibold text-foreground">{c.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.phone}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fecha(c.lastPurchase)} <span className="text-muted-foreground/80">({c.daysSince}d)</span></td>
                    <td className="px-3 py-2 font-mono">{money(c.total)}</td>
                    <td className="px-3 py-2">{c.orders}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[11px] font-semibold rounded px-2 py-0.5 ${STATUS_BADGE[c.status].cls}`}>{STATUS_BADGE[c.status].label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground/80 mt-2.5">{filtered.length} cliente(s){search ? ' (filtrados)' : ''} · "Inactivo" = sin comprar hace más de 60 días.</p>
        </>
      )}
    </div>
  )
}

// ── Reactivar: contactos con tiempo sin escribir + exportar a Excel ──
export function Reactivate() {
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
      <div className="flex items-center gap-2 mb-4 flex-wrap justify-end">
        <select value={days} onChange={e => setDays(parseInt(e.target.value))}
          className="rounded-lg border border-input px-3 py-2 text-sm max-w-36 focus:outline-none focus:ring-2 focus:ring-ring">
          {[7, 15, 30, 60].map(d => <option key={d} value={d}>+{d} días</option>)}
        </select>
        <Button onClick={exportExcel} disabled={!rows.length}>
          <span className="inline-flex items-center gap-1.5"><Download className="w-4 h-4" /> Exportar Excel/CSV</span>
        </Button>
      </div>

      {isLoading ? <p className="text-muted-foreground">Cargando…</p> :
        rows.length === 0 ? <p className="text-sm text-muted-foreground py-5">Nadie sin escribir en ese rango. ¡Todos al día!</p> : (
          <>
            <p className="text-xs text-muted-foreground/80 mb-2.5">{rows.length} cliente(s) sin escribir · "Cliente" ya te compró · "Solo consultó" aún no.</p>
            <div className="bg-card rounded-xl border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b-2 border-border/60">
                    <th className="px-3 py-2">Cliente</th>
                    <th className="px-3 py-2">Teléfono</th>
                    <th className="px-3 py-2">Sin escribir</th>
                    <th className="px-3 py-2">Qué preguntó</th>
                    <th className="px-3 py-2">Estado</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.phone} className="border-b border-border/40 hover:bg-muted/50">
                      <td className="px-3 py-2 font-semibold text-foreground">{r.name}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{r.phone}</td>
                      <td className="px-3 py-2">{r.daysSince} días</td>
                      <td className="px-3 py-2 text-muted-foreground max-w-72 truncate">{r.lastMessage || '—'}</td>
                      <td className="px-3 py-2">{r.hasPurchased ? <span className="inline-flex items-center gap-1"><Repeat2 className="w-3.5 h-3.5" />Cliente</span> : <span className="inline-flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" />Solo consultó</span>}</td>
                      <td className="px-3 py-2 text-right font-mono">{Number(r.total) > 0 ? money(r.total) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </div>
  )
}

