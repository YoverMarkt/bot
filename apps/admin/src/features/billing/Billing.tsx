import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as bill from './api'
import type { BillingRow } from './api'
import { getClients } from '../clients/api'

// Facturación — paridad con el panel viejo: filtros por cliente/estado
// (incluye "Próximo" = período futuro), paginación y marcar pagado.

const PER_PAGE = 12   // BILLING_PER_PAGE del viejo
const input = 'rounded-lg bg-stone-800 border border-stone-700 text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

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
  if (isFuture(b)) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-stone-500/10 text-stone-400">Próximo</span>
  if (b.status === 'paid') return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-green-500/10 text-green-400">Pagado</span>
  if (b.status === 'overdue') return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-red-500/10 text-red-400">Vencido</span>
  return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-amber-500/10 text-amber-400">Pendiente</span>
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
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Facturación</h1>
          <p className="text-sm text-stone-400">Historial de pagos y cobros pendientes</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <select className={input} value={fClient} onChange={e => { setFClient(e.target.value); setPage(1) }}>
            <option value="">Todos los clientes</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className={input} value={fStatus} onChange={e => { setFStatus(e.target.value); setPage(1) }}>
            <option value="">Todos</option>
            <option value="pending">Pendiente</option>
            <option value="overdue">Vencido</option>
            <option value="paid">Pagado</option>
            <option value="future">Próximo</option>
          </select>
          <button onClick={() => setShowNew(true)}
            className="rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold px-4 py-2 text-sm">+ Nuevo registro</button>
        </div>
      </div>

      {isLoading ? <p className="text-stone-400">Cargando facturación…</p> : (
        <div className="bg-stone-900 rounded-xl border border-stone-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-stone-500 border-b border-stone-800">
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Mes</th>
                <th className="px-4 py-3">Monto</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {!pageData.length && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-stone-500">Sin registros para los filtros aplicados</td></tr>
              )}
              {pageData.map(b => (
                <tr key={b.id} className={`border-b border-stone-800/60 hover:bg-stone-800/40 ${isFuture(b) ? 'opacity-45' : ''}`}>
                  <td className="px-4 py-3 font-medium text-white">{b.businesses?.name || '—'}</td>
                  <td className="px-4 py-3 text-stone-300 capitalize text-xs">{mesLabel(b.period_start)}</td>
                  <td className="px-4 py-3 font-mono text-stone-200">{money(b.amount)}</td>
                  <td className="px-4 py-3"><StatusPill b={b} /></td>
                  <td className="px-4 py-3 text-right">
                    {b.status !== 'paid' && (
                      <button onClick={() => mPaid.mutate(b.id)} disabled={isFuture(b) || mPaid.isPending}
                        className="rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-semibold px-2.5 py-1.5">
                        Marcar pagado
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 flex-wrap gap-2">
          <span className="text-xs text-stone-500">
            Mostrando {(curPage - 1) * PER_PAGE + 1}–{Math.min(curPage * PER_PAGE, filtered.length)} de {filtered.length}
          </span>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={curPage <= 1}
              className="rounded-lg border border-stone-700 text-stone-300 text-xs px-2.5 py-1.5 disabled:opacity-30">←</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - curPage) <= 2)
              .map((p, i, arr) => (
                <span key={p} className="flex">
                  {i > 0 && arr[i - 1] !== p - 1 && <span className="px-1 text-stone-600">…</span>}
                  <button onClick={() => setPage(p)}
                    className={`rounded-lg text-xs px-2.5 py-1.5 ${p === curPage ? 'bg-green-600 text-white font-semibold' : 'border border-stone-700 text-stone-300'}`}>
                    {p}
                  </button>
                </span>
              ))}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={curPage >= totalPages}
              className="rounded-lg border border-stone-700 text-stone-300 text-xs px-2.5 py-1.5 disabled:opacity-30">→</button>
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
  const lbl = 'text-xs font-medium text-stone-400'
  const inp = 'w-full rounded-lg bg-stone-800 border border-stone-700 text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

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
      <form onSubmit={save} onClick={e => e.stopPropagation()} className="w-full max-w-md bg-stone-900 border border-stone-800 rounded-2xl p-6 my-12">
        <h2 className="text-lg font-bold text-white mb-4">Nuevo registro</h2>
        <div className="space-y-3">
          <div>
            <span className={lbl}>Cliente *</span>
            <select className={inp} value={f.business_id} onChange={e => setF({ ...f, business_id: e.target.value })}>
              <option value="">Selecciona…</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><span className={lbl}>Monto ($) *</span><input className={inp} type="number" step="0.01" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} placeholder="35.00" /></div>
            <div>
              <span className={lbl}>Estado</span>
              <select className={inp} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>
                <option value="pending">Pendiente</option>
                <option value="paid">Pagado</option>
                <option value="overdue">Vencido</option>
              </select>
            </div>
            <div><span className={lbl}>Inicio del período</span><input className={inp} type="date" value={f.period_start} onChange={e => setF({ ...f, period_start: e.target.value })} /></div>
            <div><span className={lbl}>Fin del período</span><input className={inp} type="date" value={f.period_end} onChange={e => setF({ ...f, period_end: e.target.value })} /></div>
          </div>
          <div><span className={lbl}>Notas</span><input className={inp} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        {error && <p className="text-sm text-red-400 mt-3">❌ {error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="rounded-lg border border-stone-700 text-stone-300 px-4 py-2 text-sm hover:bg-stone-800">Cancelar</button>
          <button disabled={saving} className="rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  )
}
