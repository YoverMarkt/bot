import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as adm from './api'
import type { BusinessRow } from './api'

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

export default function Clients() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const { data: clients = [], isLoading } = useQuery({ queryKey: ['adm-clients'], queryFn: adm.getClients })

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return clients
    return clients.filter(c => c.name.toLowerCase().includes(q) || (c.whatsapp_number ?? '').includes(q))
  }, [clients, search])

  const refresh = () => qc.invalidateQueries({ queryKey: ['adm-clients'] })
  const mSuspend = useMutation({ mutationFn: (id: string) => adm.suspendClient(id, 'Pago pendiente'), onSettled: refresh })
  const mReactivate = useMutation({ mutationFn: (id: string) => adm.reactivateClient(id), onSettled: refresh })
  const mBot = useMutation({ mutationFn: (v: { id: string; on: boolean }) => adm.setBotActive(v.id, v.on), onSettled: refresh })

  function status(c: BusinessRow) {
    if (c.suspended) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-red-500/10 text-red-400">⛔ Suspendido</span>
    if (!c.bot_active) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-amber-500/10 text-amber-400">⏸️ Bot pausado</span>
    return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-green-500/10 text-green-400">✅ Activo</span>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Negocios</h1>
          <p className="text-sm text-stone-400">{clients.length} cliente(s) del SaaS</p>
        </div>
        <div className="flex gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o número…"
            className="rounded-lg bg-stone-800 border border-stone-700 text-white px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-green-500" />
          <a href="/admin" className="rounded-lg border border-stone-700 text-stone-300 px-3 py-2 text-sm hover:bg-stone-800"
            title="Crear/editar negocios sigue en el panel actual mientras se migra">➕ Crear (panel actual)</a>
        </div>
      </div>

      {isLoading ? <p className="text-stone-400">Cargando negocios…</p> : (
        <div className="bg-stone-900 rounded-xl border border-stone-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-stone-500 border-b border-stone-800">
                <th className="px-4 py-3">Negocio</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Vence</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b border-stone-800/60 hover:bg-stone-800/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{c.name}</div>
                    <div className="text-xs text-stone-500">{c.type || '—'} · {c.whatsapp_number || 'sin número'}</div>
                  </td>
                  <td className="px-4 py-3">{status(c)}</td>
                  <td className="px-4 py-3 text-stone-300 capitalize">{c.plan || '—'}</td>
                  <td className="px-4 py-3 text-stone-400">{fmtDate(c.plan_expires_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => mBot.mutate({ id: c.id, on: !c.bot_active })}
                        className="rounded-lg border border-stone-700 text-stone-300 text-xs px-2.5 py-1.5 hover:bg-stone-800"
                        title={c.bot_active ? 'Pausar el bot (deja de responder)' : 'Reactivar el bot'}>
                        {c.bot_active ? '⏸️ Pausar bot' : '▶️ Activar bot'}
                      </button>
                      {c.suspended
                        ? <button onClick={() => mReactivate.mutate(c.id)}
                            className="rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-semibold px-2.5 py-1.5">✅ Reactivar</button>
                        : <button onClick={() => { if (confirm(`¿Suspender a ${c.name}? Su bot dejará de atender.`)) mSuspend.mutate(c.id) }}
                            className="rounded-lg border border-red-900 text-red-400 text-xs px-2.5 py-1.5 hover:bg-red-950">⛔ Suspender</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-stone-500 mt-3">Crear/editar negocios (credenciales, prompt, calculadora, simulador) sigue en el <a className="underline" href="/admin">panel actual</a> hasta migrar esas secciones.</p>
    </div>
  )
}
