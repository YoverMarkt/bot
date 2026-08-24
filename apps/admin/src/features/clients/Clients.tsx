import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as adm from './api'
import { enElMarketplace, type BusinessRow } from './api'
import ClientModal from './ClientModal'
import { ViewModal, BienvenidaModal } from './ClientTools'
import { Trash2, MessageSquareText, Plus, Eye, Pencil, MoreHorizontal, Store, EyeOff } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@botpanel/ui/components/dropdown-menu'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { planLabel } from './plans'

export default function Clients() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [viewing, setViewing] = useState<BusinessRow | null>(null)
  const [prompting, setPrompting] = useState<BusinessRow | null>(null)
  const { data: clients = [], isLoading, isError, refetch } = useQuery({ queryKey: ['adm-clients'], queryFn: adm.getClients })

  const filtered = clients

  // ⚠️ Aquí vivían el semáforo del canal POR NEGOCIO y el estado del bot, y se
  // fueron los dos el 2026-08-23:
  //
  //   · El semáforo leía `channel.businesses`, alimentado por una consulta a
  //     `webhook_inbound_events` filtrada por `business_id`. Los mensajes del
  //     marketplace se encolan con ese campo NULL, así que ningún local volvía
  //     a registrar un entrante y todos caían en «Sin mensajes» a las 12 h.
  //     La salud del canal —que ahora es la del NÚMERO— vive en el Dashboard,
  //     donde una sola fila dice la verdad de todos.
  //
  //   · «Bot» leía `bot_active`, que solo consulta `bot-conversation.ts`. El
  //     marketplace no pasa por ahí: la columna decía «Activo» o «Pausado»
  //     sobre algo que no cambia el comportamiento de nada.
  //
  // Los sustituye una sola columna que SÍ se puede comprobar desde fuera:
  // ¿encuentra un cliente este local escribiendo al número de Umbani?

  const refresh = () => qc.invalidateQueries({ queryKey: ['adm-clients'] })
  const mSuspend = useMutation({ mutationFn: (id: string) => adm.suspendClient(id, 'Pago pendiente'), onSettled: refresh })
  const mReactivate = useMutation({ mutationFn: (id: string) => adm.reactivateClient(id), onSettled: refresh })
  const mDelete = useMutation({ mutationFn: (id: string) => adm.deleteClient(id), onSettled: refresh })

  // ⚠️ Aquí vivía «Verificar conexión», retirada el 2026-08-23. Llamaba a
  // `/api/admin/clients/:id/verify`, que resuelve el proveedor con
  // `providerFrom(business.whatsapp_provider)` y solo conoce ycloud, meta y
  // telegram: con `'marketplace'` devolvía `null` y respondía SIEMPRE
  // «✗ Proveedor no reconocido», para todos los negocios y sin consultar nada.
  //
  // Es el MISMO fallo que ya se cazó en `ClientModal`: se quitó del modal y se
  // quedó vivo aquí. La verificación del número del marketplace es otra y sigue
  // en Ajustes del servidor (`/api/admin/verify-platform-channel`).

  function statusPill(c: BusinessRow) {
    if (c.suspended) return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Suspendido</Badge>
    if (c.active) return <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400">Activo</Badge>
    return <Badge variant="secondary">Inactivo</Badge>
  }

  /**
   * ¿Lo encuentra un cliente en el menú de Umbani?
   *
   * Es la única pregunta de esta lista que se puede comprobar desde fuera, y
   * la respuesta sale de las MISMAS condiciones que usa la base. El detalle
   * dice qué falta, porque «Oculto» sin motivo obliga a abrir la ficha.
   */
  function marketplacePill(c: BusinessRow) {
    if (enElMarketplace(c)) {
      return (
        <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400" title="Aparece en el menú del número de Umbani">
          <Store className="mr-1 h-3 w-3 shrink-0" /> Visible
        </Badge>
      )
    }
    const motivo = c.suspended ? 'Suspendido'
      : !c.active ? 'Dado de baja'
        : !c.takes_orders ? 'No crea pedidos'
          : 'Sin tienda encendida'
    return (
      <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400" title={`No sale en el menú: ${motivo}`}>
        <EyeOff className="mr-1 h-3 w-3 shrink-0" /> {motivo}
      </Badge>
    )
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
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow>
                <TableHead>Negocio</TableHead>
                <TableHead>Tienda</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Marketplace</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!filtered.length && <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">No hay clientes aún</TableCell></TableRow>}
              {filtered.map(c => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.type || '—'}</div>
                  </TableCell>
                  {/* ⚠️ El enlace de su tienda, no su número: el número está
                      vacío en TODOS los locales del marketplace —la base se lo
                      prohíbe— y la columna enseñaba «—» en cada fila. El slug
                      sí identifica al local y es lo que se le manda al cliente. */}
                  <TableCell className="font-mono text-xs text-foreground/80">/t/{c.slug}</TableCell>
                  <TableCell><Badge variant="secondary">{planLabel(c.plan)}</Badge></TableCell>
                  <TableCell>{statusPill(c)}</TableCell>
                  <TableCell>{marketplacePill(c)}</TableCell>
                  <TableCell className="w-[1%]">
                    <div className="flex flex-nowrap justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setViewing(c)}><Eye /> Ver</Button>
                      <Button variant="outline" size="sm" onClick={() => setEditing(c.id)}><Pencil /> Editar</Button>
                      {c.suspended
                        ? <Button size="sm" onClick={() => mReactivate.mutate(c.id)}>Reactivar</Button>
                        : <ConfirmAction
                            trigger={<Button variant="outline" size="sm">Suspender</Button>}
                            title={`Suspender a ${c.name}`}
                            description="Dejará de aparecer en el marketplace y su tienda no aceptará pedidos hasta reactivarlo."
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
                        {/* ⚠️ Se fueron «Verificar conexión» —que respondía
                            siempre «Proveedor no reconocido»— y «Pausar bot»,
                            que prometía dejar al local mudo y no cortaba nada:
                            `bot_active` solo lo lee `bot-conversation.ts`, y el
                            marketplace no pasa por ahí. Para ocultar un local
                            está «Aparece en el marketplace», en su ficha; para
                            cortarle el servicio, Suspender. */}
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onSelect={() => setPrompting(c)}>
                            <MessageSquareText /> Mensaje de bienvenida
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setViewing(c)}><Eye /> Ver información</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
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
      {prompting && <BienvenidaModal c={prompting} onClose={() => setPrompting(null)} />}
    </div>
  )
}
