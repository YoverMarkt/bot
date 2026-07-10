import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as adm from './api'
import type { BusinessRow } from './api'
import ClientModal from './ClientModal'
import { ViewModal, PromptModal } from './ClientTools'
import { Check, Trash2, Bot as BotIcon, Plus, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function Clients() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [viewing, setViewing] = useState<BusinessRow | null>(null)
  const [prompting, setPrompting] = useState<BusinessRow | null>(null)
  const [vfy, setVfy] = useState<Record<string, string>>({})
  const { data: clients = [], isLoading } = useQuery({ queryKey: ['adm-clients'], queryFn: adm.getClients })

  const filtered = clients

  const refresh = () => qc.invalidateQueries({ queryKey: ['adm-clients'] })
  const mSuspend = useMutation({ mutationFn: (id: string) => adm.suspendClient(id, 'Pago pendiente'), onSettled: refresh })
  const mReactivate = useMutation({ mutationFn: (id: string) => adm.reactivateClient(id), onSettled: refresh })
  const mDelete = useMutation({ mutationFn: (id: string) => adm.deleteClient(id), onSettled: refresh })

  // Verificar credenciales GUARDADAS del negocio (igual que la tabla del viejo)
  async function quickVerify(c: BusinessRow) {
    setVfy(v => ({ ...v, [c.id]: 'Verificando…' }))
    try {
      const r = await adm.verifyClient(c.id)
      setVfy(v => ({ ...v, [c.id]: `${r.ok ? '✓' : '✗'} ${r.info}` }))
    } catch (e) { setVfy(v => ({ ...v, [c.id]: `✗ ${e instanceof Error ? e.message : 'Error'}` })) }
  }

  function del(c: BusinessRow) {
    if (!confirm(`¿Eliminar permanentemente a "${c.name}"?\n\nSe eliminarán también sus productos, conversaciones y registros de pago. Esta acción no se puede deshacer.`)) return
    mDelete.mutate(c.id)
  }

  function statusPill(c: BusinessRow) {
    if (c.suspended) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-destructive/10 text-destructive">Suspendido</span>
    if (c.active) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-green-500/10 text-primary">Activo</span>
    return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-stone-500/10 text-muted-foreground">Inactivo</span>
  }
  function botPill(c: BusinessRow) {
    if (c.suspended) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-destructive/10 text-destructive">Pausado</span>
    if (c.bot_active) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-green-500/10 text-primary">Activo</span>
    return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-stone-500/10 text-muted-foreground">Pausado</span>
  }
  // Vencimiento con pills de días (igual que el viejo; T12:00:00 evita desfase de zona)
  function expLabel(c: BusinessRow) {
    if (!c.plan_expires_at) return <span className="text-muted-foreground/70 text-xs">—</span>
    const exp = new Date(c.plan_expires_at.split('T')[0] + 'T12:00:00')
    const daysLeft = Math.ceil((exp.getTime() - Date.now()) / 86400000)
    if (daysLeft < 0) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-destructive/10 text-destructive">Vencido</span>
    if (daysLeft <= 10) return <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-amber-500/10 text-amber-400" title={exp.toLocaleDateString('es')}>{daysLeft}d</span>
    return <span className="text-xs text-muted-foreground">{exp.toLocaleDateString('es')}</span>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Clientes</h1>
          <p className="text-sm text-muted-foreground">Gestiona todos los negocios de tu plataforma</p>
        </div>
        <Button onClick={() => setEditing('new')}
          className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-4 py-2 text-sm"><span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Nuevo cliente</span></Button>
      </div>

      {isLoading ? <p className="text-muted-foreground">Cargando negocios…</p> : (
        <div className="bg-card rounded-xl border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                <th className="px-3 py-3">Negocio</th>
                <th className="px-3 py-3">WhatsApp</th>
                <th className="px-3 py-3">Plan</th>
                <th className="px-3 py-3">Vencimiento</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3">Bot</th>
                <th className="px-3 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {!filtered.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No hay clientes aún</td></tr>}
              {filtered.map(c => (
                <tr key={c.id} className="border-b border-border/60 hover:bg-muted/40">
                  <td className="px-3 py-3">
                    <div className="font-medium text-foreground">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.type || '—'}</div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-foreground/80">{c.whatsapp_number || '—'}</td>
                  <td className="px-3 py-3"><span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-stone-500/10 text-foreground/80 capitalize">{c.plan || 'basic'}</span></td>
                  <td className="px-3 py-3">{expLabel(c)}</td>
                  <td className="px-3 py-3">{statusPill(c)}</td>
                  <td className="px-3 py-3">{botPill(c)}</td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1 flex-wrap">
                      <Button onClick={() => quickVerify(c)} title="Verificar conexión del proveedor"
                        className="rounded-lg border border-input text-foreground/80 text-xs px-2 py-1.5 hover:bg-muted"><Check className="w-3.5 h-3.5" /></Button>
                      <Button onClick={() => setViewing(c)}
                        className="rounded-lg border border-input text-foreground/80 text-xs px-2 py-1.5 hover:bg-muted"><span className="inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> Ver</span></Button>
                      <Button onClick={() => setEditing(c.id)}
                        className="rounded-lg border border-input text-foreground/80 text-xs px-2 py-1.5 hover:bg-muted">Editar</Button>
                      <Button onClick={() => setPrompting(c)}
                        className="rounded-lg border border-input text-foreground/80 text-xs px-2 py-1.5 hover:bg-muted"><span className="inline-flex items-center gap-1"><BotIcon className="w-3.5 h-3.5" /> Bot</span></Button>
                      {c.suspended
                        ? <Button onClick={() => mReactivate.mutate(c.id)}
                            className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold px-2 py-1.5">Reactivar</Button>
                        : <Button onClick={() => { if (confirm(`¿Suspender a ${c.name}? Su bot dejará de atender.`)) mSuspend.mutate(c.id) }}
                            className="rounded-lg border border-destructive/40 text-destructive text-xs px-2 py-1.5 hover:bg-destructive/10">Suspender</Button>}
                      <Button onClick={() => del(c)} title="Eliminar cliente"
                        className="rounded-lg border border-destructive/40 text-destructive text-xs px-2 py-1.5 hover:bg-destructive/10"><Trash2 className="w-3.5 h-3.5" /></Button>
                    </div>
                    {vfy[c.id] && <div className="text-[11px] text-muted-foreground mt-1 max-w-72">{vfy[c.id]}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ClientModal
          id={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
        />
      )}
      {viewing && <ViewModal c={viewing} onClose={() => setViewing(null)} />}
      {prompting && <PromptModal c={prompting} onClose={() => setPrompting(null)} />}
    </div>
  )
}
