import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as bill from './api'
import type { BillingRow } from './api'
import { getClients } from '../clients/api'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

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
  if (isFuture(b)) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-stone-500/10 text-muted-foreground">Próximo</span>
  if (b.status === 'paid') return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-green-500/10 text-primary">Pagado</span>
  if (b.status === 'overdue') return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-destructive/10 text-destructive">Vencido</span>
  return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-400">Pendiente</span>
}

export default function Billing() {
  const qc = useQueryClient()
  const [fClient, setFClient] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [page, setPage] = useState(1)
  const [showNew, setShowNew] = useState(false)

  const { data: records = [], isLoading } = useQuery({ queryKey: ['adm-billing'], queryFn: bill.getBilling })
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })

  const refresh = () => qc.invalidateQueries({ queryKey: ['adm-billing'] })
  const mPaid = useMutation({ mutationFn: bill.markPaid, onSettled: refresh })

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
          <p className="text-sm text-muted-foreground">Historial de pagos y cobros pendientes</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Radix no permite value="" en un item → centinela 'all' ↔ '' (Todos) */}
          <Select value={fClient || 'all'} onValueChange={v => { setFClient(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los clientes</SelectItem>
              {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={fStatus || 'all'} onValueChange={v => { setFStatus(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="pending">Pendiente</SelectItem>
              <SelectItem value="overdue">Vencido</SelectItem>
              <SelectItem value="paid">Pagado</SelectItem>
              <SelectItem value="future">Próximo</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => setShowNew(true)}><span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Nuevo registro</span></Button>
        </div>
      </div>

      {isLoading ? <p className="text-muted-foreground">Cargando facturación…</p> : (
        <Card className="py-0 gap-0 overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Mes</th>
                <th className="px-4 py-3">Monto</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {!pageData.length && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Sin registros para los filtros aplicados</td></tr>
              )}
              {pageData.map(b => (
                <tr key={b.id} className={`border-b border-border/60 hover:bg-muted/40 ${isFuture(b) ? 'opacity-45' : ''}`}>
                  <td className="px-4 py-3 font-medium text-foreground">{b.businesses?.name || '—'}</td>
                  <td className="px-4 py-3 text-foreground/80 capitalize text-xs">{mesLabel(b.period_start)}</td>
                  <td className="px-4 py-3 font-mono text-foreground/90">{money(b.amount)}</td>
                  <td className="px-4 py-3"><StatusPill b={b} /></td>
                  <td className="px-4 py-3 text-right">
                    {b.status !== 'paid' && (
                      <Button size="sm" onClick={() => mPaid.mutate(b.id)} disabled={isFuture(b) || mPaid.isPending} className="text-xs">
                        Marcar pagado
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">
            Mostrando {(curPage - 1) * PER_PAGE + 1}–{Math.min(curPage * PER_PAGE, filtered.length)} de {filtered.length}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={curPage <= 1} className="text-xs">←</Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - curPage) <= 2)
              .map((p, i, arr) => (
                <span key={p} className="flex">
                  {i > 0 && arr[i - 1] !== p - 1 && <span className="px-1 text-muted-foreground/70">…</span>}
                  <Button variant="ghost" onClick={() => setPage(p)}
                    className={`rounded-lg text-xs px-2.5 py-1.5 ${p === curPage ? 'bg-primary text-foreground font-semibold' : 'border border-input text-foreground/80'}`}>
                    {p}
                  </Button>
                </span>
              ))}
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={curPage >= totalPages} className="text-xs">→</Button>
          </div>
        </div>
      )}

      {showNew && <NewCharge clients={clients} onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh() }} />}
    </div>
  )
}

function NewCharge({ clients, onClose, onSaved }: {
  clients: { id: string; name: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState({ business_id: '', amount: '', status: 'pending', period_start: '', period_end: '', notes: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const lbl = 'text-xs font-medium text-muted-foreground'
  const inp = 'w-full rounded-lg bg-muted border border-input text-foreground px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!f.business_id || !f.amount) { setError('Cliente y monto son obligatorios'); return }
    setSaving(true); setError('')
    try {
      await bill.createBilling({
        business_id: f.business_id,
        amount: parseFloat(f.amount),
        status: f.status,
        period_start: f.period_start || null,
        period_end: f.period_end || null,
        notes: f.notes || null,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <form onSubmit={save} onClick={e => e.stopPropagation()} className="w-full max-w-md bg-card border rounded-2xl p-6 my-12">
        <h2 className="text-lg font-bold text-foreground mb-4">Nuevo registro</h2>
        <div className="space-y-3">
          <div>
            <span className={lbl}>Cliente *</span>
            <Select value={f.business_id} onValueChange={v => setF({ ...f, business_id: v })}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Selecciona…" /></SelectTrigger>
              <SelectContent>
                {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><span className={lbl}>Monto ($) *</span><Input className={inp} type="number" step="0.01" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} placeholder="35.00" /></div>
            <div>
              <span className={lbl}>Estado</span>
              <Select value={f.status} onValueChange={v => setF({ ...f, status: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pendiente</SelectItem>
                  <SelectItem value="paid">Pagado</SelectItem>
                  <SelectItem value="overdue">Vencido</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><span className={lbl}>Inicio del período</span><Input className={inp} type="date" value={f.period_start} onChange={e => setF({ ...f, period_start: e.target.value })} /></div>
            <div><span className={lbl}>Fin del período</span><Input className={inp} type="date" value={f.period_end} onChange={e => setF({ ...f, period_end: e.target.value })} /></div>
          </div>
          <div><span className={lbl}>Notas</span><Input className={inp} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        {error && <p className="text-sm text-destructive mt-3">✗ {error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="outline" type="button" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </div>
  )
}
