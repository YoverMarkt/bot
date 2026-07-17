import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as adm from './api'
import type { BusinessRow } from './api'
import ClientModal from './ClientModal'
import { ViewModal, PromptModal } from './ClientTools'
import { Check, Trash2, Bot as BotIcon, Plus, Eye, Pencil, MoreHorizontal } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@botpanel/ui/components/dropdown-menu'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

export default function Clients() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [viewing, setViewing] = useState<BusinessRow | null>(null)
  const [prompting, setPrompting] = useState<BusinessRow | null>(null)
  const [vfy, setVfy] = useState<Record<string, string>>({})
  const { data: clients = [], isLoading, isError, refetch } = useQuery({ queryKey: ['adm-clients'], queryFn: adm.getClients })

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

  function statusPill(c: BusinessRow) {
    if (c.suspended) return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Suspendido</Badge>
    if (c.active) return <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">Activo</Badge>
    return <Badge variant="secondary">Inactivo</Badge>
  }
  function botPill(c: BusinessRow) {
    if (c.suspended) return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Pausado</Badge>
    if (c.bot_active) return <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">Activo</Badge>
    return <Badge variant="secondary">Pausado</Badge>
  }
  // Vencimiento con pills de días (igual que el viejo; T12:00:00 evita desfase de zona)
  function expLabel(c: BusinessRow) {
    if (!c.plan_expires_at) return <span className="text-muted-foreground/70 text-xs">—</span>
    const exp = new Date(c.plan_expires_at.split('T')[0] + 'T12:00:00')
    const daysLeft = Math.ceil((exp.getTime() - Date.now()) / 86400000)
    if (daysLeft < 0) return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Vencido</Badge>
    if (daysLeft <= 10) return <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 tabular-nums" title={exp.toLocaleDateString('es')}>{daysLeft}d</Badge>
    return <span className="text-xs text-muted-foreground">{exp.toLocaleDateString('es')}</span>
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Clientes</h1>
          <p className="text-sm text-muted-foreground">Gestiona todos los negocios de tu plataforma</p>
        </div>
        <Button onClick={() => setEditing('new')}><span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Nuevo cliente</span></Button>
      </div>

      {isLoading ? (
        <Card className="p-4 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </Card>
      ) : isError ? (
        <QueryError onRetry={() => { void refetch() }} />
      ) : (
        <Card className="flex-1 w-full gap-0 overflow-hidden py-0">
          <Table className="min-w-[1040px]">
            <TableHeader>
              <TableRow>
                <TableHead>Negocio</TableHead>
                <TableHead>WhatsApp</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Vencimiento</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Bot</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!filtered.length && <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">No hay clientes aún</TableCell></TableRow>}
              {filtered.map(c => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.type || '—'}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/80">{c.whatsapp_number || '—'}</TableCell>
                  <TableCell><Badge variant="secondary" className="capitalize">{c.plan || 'basic'}</Badge></TableCell>
                  <TableCell>{expLabel(c)}</TableCell>
                  <TableCell>{statusPill(c)}</TableCell>
                  <TableCell>{botPill(c)}</TableCell>
                  <TableCell className="w-[1%]">
                    <div className="flex flex-nowrap justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setViewing(c)}><Eye /> Ver</Button>
                      <Button variant="outline" size="sm" onClick={() => setEditing(c.id)}><Pencil /> Editar</Button>
                      {c.suspended
                        ? <Button size="sm" onClick={() => mReactivate.mutate(c.id)}>Reactivar</Button>
                        : <ConfirmAction
                            trigger={<Button variant="outline" size="sm">Suspender</Button>}
                            title={`Suspender a ${c.name}`}
                            description="El bot dejará de atender hasta que el negocio sea reactivado."
                            confirmLabel="Suspender"
                            destructive
                            onConfirm={() => mSuspend.mutate(c.id)}
                          />}
                      <ConfirmAction
                        trigger={<Button variant="outline" size="icon-sm" aria-label={`Eliminar ${c.name}`} title="Eliminar cliente"><Trash2 className="w-3.5 h-3.5" /></Button>}
                        title={`Eliminar permanentemente a ${c.name}`}
                        description="Se eliminarán sus productos, conversaciones y registros de pago. Esta acción no se puede deshacer."
                        confirmLabel="Eliminar negocio"
                        destructive
                        onConfirm={() => mDelete.mutate(c.id)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="icon-sm" aria-label={`Más acciones para ${c.name}`}><MoreHorizontal /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onSelect={() => quickVerify(c)}><Check /> Verificar conexión</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setPrompting(c)}><BotIcon /> Configurar bot</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setViewing(c)}><Eye /> Ver información</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {vfy[c.id] && <div className="ml-auto mt-2 max-w-80 text-right text-xs text-muted-foreground">{vfy[c.id]}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
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
