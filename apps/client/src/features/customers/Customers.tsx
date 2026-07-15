import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as custApi from './api'
import { Repeat2, Sparkles, Download } from 'lucide-react'
import type { Customer } from './api'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Badge } from '@botpanel/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { QueryError } from '@botpanel/ui/components/query-error'

const { money } = custApi

const STATUS_BADGE: Record<Customer['status'], { label: string; cls: string }> = {
  nuevo:     { label: 'Nuevo',      cls: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' },
  frecuente: { label: 'Frecuente',  cls: 'bg-primary/10 text-primary' },
  activo:    { label: 'Activo',     cls: 'bg-muted text-muted-foreground' },
  inactivo:  { label: 'Inactivo',   cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' },
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
  const { data: customers = [], isLoading, isError, refetch } = useQuery({ queryKey: ['customers'], queryFn: custApi.getCustomers })
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return q ? customers.filter(c => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q)) : customers
  }, [customers, search])

  if (isLoading) return <p className="text-muted-foreground">Cargando…</p>
  if (isError) return <QueryError onRetry={() => { void refetch() }} />

  const fecha = (iso: string) => new Date(iso).toLocaleDateString('es')

  return (
    <div>
      <Input id="customers-search" aria-label="Buscar clientes" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o teléfono..." className="w-full max-w-sm mb-4" />

      {!customers.length ? (
        <p className="text-sm text-muted-foreground">Aún no hay clientes con compras registradas.</p>
      ) : !filtered.length ? (
        <p className="text-sm text-muted-foreground">Ningún cliente coincide con la búsqueda.</p>
      ) : (
        <>
          <Card className="py-0 gap-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Teléfono</TableHead>
                  <TableHead>Última compra</TableHead>
                  <TableHead>Total gastado</TableHead>
                  <TableHead>Compras</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(c => (
                  <TableRow key={c.phone}>
                    <TableCell className="font-semibold text-foreground">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">{c.phone}</TableCell>
                    <TableCell className="text-muted-foreground">{fecha(c.lastPurchase)} <span className="text-muted-foreground/80">({c.daysSince}d)</span></TableCell>
                    <TableCell className="font-mono tabular-nums">{money(c.total)}</TableCell>
                    <TableCell className="tabular-nums">{c.orders}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={STATUS_BADGE[c.status].cls}>{STATUS_BADGE[c.status].label}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
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
        <Select value={String(days)} onValueChange={v => setDays(parseInt(v))}>
          <SelectTrigger id="reactivate-days" aria-label="Días sin escribir" className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[7, 15, 30, 60].map(d => <SelectItem key={d} value={String(d)}>+{d} días</SelectItem>)}
          </SelectContent>
        </Select>
        <Button onClick={exportExcel} disabled={!rows.length}>
          <span className="inline-flex items-center gap-1.5"><Download className="w-4 h-4" /> Exportar Excel/CSV</span>
        </Button>
      </div>

      {isLoading ? <p className="text-muted-foreground">Cargando…</p> :
        rows.length === 0 ? <p className="text-sm text-muted-foreground py-5">Nadie sin escribir en ese rango. ¡Todos al día!</p> : (
          <>
            <p className="text-xs text-muted-foreground/80 mb-2.5">{rows.length} cliente(s) sin escribir · "Cliente" ya te compró · "Solo consultó" aún no.</p>
            <Card className="py-0 gap-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Teléfono</TableHead>
                    <TableHead>Sin escribir</TableHead>
                    <TableHead>Qué preguntó</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => (
                    <TableRow key={r.phone}>
                      <TableCell className="font-semibold text-foreground">{r.name}</TableCell>
                      <TableCell className="font-mono text-muted-foreground">{r.phone}</TableCell>
                      <TableCell className="tabular-nums">{r.daysSince} días</TableCell>
                      <TableCell className="text-muted-foreground max-w-72 truncate">{r.lastMessage || '—'}</TableCell>
                      <TableCell>{r.hasPurchased
                        ? <Badge variant="outline" className="gap-1"><Repeat2 className="w-3 h-3" /> Cliente</Badge>
                        : <Badge variant="secondary" className="gap-1"><Sparkles className="w-3 h-3" /> Solo consultó</Badge>}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{Number(r.total) > 0 ? money(r.total) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </>
        )}
    </div>
  )
}
