import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as bill from './api'
import type { BillingRow } from './api'
import { getClients } from '../clients/api'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Badge } from '@botpanel/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// Facturación — paridad con el panel viejo: filtros por cliente/estado
// (incluye "Próximo" = período futuro), paginación y marcar pagado.

const PER_PAGE = 12   // BILLING_PER_PAGE del viejo

const money = (v: number | string) =>
  '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const mesLabel = (iso: string | null) =>
  iso ? new Date(iso + 'T00:00:00').toLocaleDateString('es', { month: 'long', year: 'numeric' }) : '—'

const isFuture = (b: BillingRow) => {
  if (!b.period_start) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return new Date(b.period_start + 'T00:00:00') > today
}

function StatusPill({ b }: { b: BillingRow }) {
  if (isFuture(b)) return <Badge variant="secondary">Próximo</Badge>
  if (b.status === 'paid') return <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">Pagado</Badge>
  if (b.status === 'overdue') return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Vencido</Badge>
  return <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">Pendiente</Badge>
}

export default function Billing() {
  const qc = useQueryClient()
  const [fClient, setFClient] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [page, setPage] = useState(1)

  const { data: records = [], isLoading } = useQuery({ queryKey: ['adm-billing'], queryFn: bill.getBilling })
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })

  const refresh = () => qc.invalidateQueries({ queryKey: ['adm-billing'] })
  const mPaid = useMutation({
    mutationFn: bill.markPaid,
    onSuccess: () => toast.success('Cobro marcado como pagado'),
    onError: error => toast.error(error instanceof Error ? error.message : 'No se pudo registrar el pago'),
    onSettled: refresh,
  })

  const filtered = useMemo(() => {
    const list = records.filter(b => {
      if (fClient && b.business_id !== fClient) return false
      if (fStatus) {
        const eff = isFuture(b) ? 'future' : b.status
        if (eff !== fStatus) return false
      }
      return true
    })
    // Orden: cliente A→Z, luego por mes (igual que el panel viejo)
    return list.sort((a, b) => {
      const na = (a.businesses?.name || '').toLowerCase()
      const nb = (b.businesses?.name || '').toLowerCase()
      if (na !== nb) return na < nb ? -1 : 1
      return (a.period_start || '') < (b.period_start || '') ? -1 : 1
    })
  }, [records, fClient, fStatus])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const curPage = Math.min(page, totalPages)
  const pageData = filtered.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Facturación</h1>
          <p className="text-sm text-muted-foreground">Cuotas mensuales generadas automáticamente e historial de pagos</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Radix no permite value="" en un item → centinela 'all' ↔ '' (Todos) */}
          <Select value={fClient || 'all'} onValueChange={v => { setFClient(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger id="billing-client-filter" aria-label="Filtrar por cliente" className="w-full sm:w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los clientes</SelectItem>
              {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={fStatus || 'all'} onValueChange={v => { setFStatus(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger id="billing-status-filter" aria-label="Filtrar por estado" className="w-full sm:w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="pending">Pendiente</SelectItem>
              <SelectItem value="overdue">Vencido</SelectItem>
              <SelectItem value="paid">Pagado</SelectItem>
              <SelectItem value="future">Próximo</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <Card className="flex-1 p-4 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </Card>
      ) : (
        <Card className="py-0 gap-0 overflow-hidden flex-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Mes</TableHead>
                <TableHead>Cuota</TableHead>
                <TableHead>Comisión</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acción</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!pageData.length && (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Sin registros para los filtros aplicados</TableCell></TableRow>
              )}
              {pageData.map(b => (
                <TableRow key={b.id} className={isFuture(b) ? 'opacity-45' : ''}>
                  <TableCell className="font-medium text-foreground">{b.businesses?.name || '—'}</TableCell>
                  <TableCell className="text-foreground/80 capitalize text-xs">{mesLabel(b.period_start)}</TableCell>
                  <TableCell className="font-mono text-foreground/90 tabular-nums">{money(b.amount)}</TableCell>
                  {/* La comisión no se suma a la cuota: el comercio tiene que
                      poder distinguir qué paga por el servicio y qué por sus
                      ventas. El total va en su propia columna. */}
                  <TableCell className="font-mono tabular-nums text-primary">
                    {Number(b.commission_amount || 0) > 0 ? money(b.commission_amount!) : '—'}
                    {Number(b.commission_orders || 0) > 0 && (
                      <span className="block text-[11px] text-muted-foreground">
                        {b.commission_orders} pedidos
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono font-semibold text-foreground tabular-nums">
                    {money(Number(b.amount || 0) + Number(b.commission_amount || 0))}
                  </TableCell>
                  <TableCell><StatusPill b={b} /></TableCell>
                  <TableCell className="text-right">
                    {b.status !== 'paid' && (
                      <Button
                        size="sm"
                        onClick={() => mPaid.mutate(b.id)}
                        disabled={isFuture(b) || mPaid.isPending}
                        aria-label={`Marcar pagado: ${b.businesses?.name || 'cliente'}, ${mesLabel(b.period_start)}`}
                      >
                        Marcar pagado
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">
            Mostrando {(curPage - 1) * PER_PAGE + 1}–{Math.min(curPage * PER_PAGE, filtered.length)} de {filtered.length}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" aria-label="Página anterior" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={curPage <= 1}>←</Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - curPage) <= 2)
              .map((p, i, arr) => (
                <span key={p} className="flex">
                  {i > 0 && arr[i - 1] !== p - 1 && <span className="px-1 text-muted-foreground/70">…</span>}
                  <Button variant="ghost" onClick={() => setPage(p)}
                    className={`rounded-lg text-xs px-2.5 py-1.5 ${p === curPage ? 'bg-primary text-primary-foreground font-semibold' : 'border border-input text-foreground/80'}`}>
                    {p}
                  </Button>
                </span>
              ))}
            <Button variant="outline" size="icon-sm" aria-label="Página siguiente" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={curPage >= totalPages}>→</Button>
          </div>
        </div>
      )}
    </div>
  )
}
