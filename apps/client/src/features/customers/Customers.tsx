import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import * as custApi from './api'
import { Repeat2, Sparkles, Download, Ban, Undo2 } from 'lucide-react'
import type { Customer } from './api'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Badge } from '@botpanel/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const { money } = custApi

// Esqueleto compartido por las dos tablas de esta pantalla (directorio y reactivar)
function TableSkeleton() {
  return (
    <Card className="p-4 gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </Card>
  )
}

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

/** Mismos dígitos: el teléfono llega con `+` por un canal y sin él por otro. */
const soloDigitos = (phone: string) => String(phone || '').replace(/\D/g, '')

// ── Directorio: quiénes te han comprado, cuánto y hace cuánto ──
function Directory() {
  const qc = useQueryClient()
  const { data: customers = [], isLoading, isError, refetch } = useQuery({ queryKey: ['customers'], queryFn: custApi.getCustomers })
  // ⚠️ Los bloqueados vienen aparte y no dentro del directorio: son pocos —y
  // en casi todos los negocios, ninguno— y quien molesta puede no haber
  // comprado nunca, así que no siempre está en esta tabla.
  const { data: blocked = [] } = useQuery({ queryKey: ['blocked'], queryFn: custApi.getBlocked })
  const [search, setSearch] = useState('')

  // ⚠️ `Array.isArray` y no `blocked.map` a secas. Es la REGRESIÓN del
  // 2026-08-15, que se muda con el bloqueo: cuando esta petición devolvió `{}`
  // en vez de una lista —un 502 del proxy, un despliegue a medias—, el `.map`
  // reventaba y se llevaba por delante la pantalla ENTERA. El dueño se quedaba
  // sin su directorio de clientes por un dato accesorio.
  //
  // El panel compara SIEMPRE normalizado: la ficha guarda `593…` y el pedido
  // llega como `+593…`. Sin eso un bloqueado volvía a salir como si no lo
  // estuviera en cuanto se recargaba la pantalla.
  const bloqueados = useMemo(
    () => new Set((Array.isArray(blocked) ? blocked : []).map(soloDigitos)),
    [blocked],
  )
  const listaBloqueados = Array.isArray(blocked) ? blocked : []

  const mBlock = useMutation({
    mutationFn: ({ phone, blocked: value }: { phone: string; blocked: boolean }) =>
      custApi.setBlocked(phone, value),
    onSuccess: (_data, variables) => {
      toast.success(variables.blocked ? 'Cliente bloqueado' : 'Cliente desbloqueado')
      qc.invalidateQueries({ queryKey: ['blocked'] })
    },
    onError: error => toast.error(error instanceof Error ? error.message : 'No se pudo actualizar'),
  })

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return q ? customers.filter(c => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q)) : customers
  }, [customers, search])

  if (isLoading) return (
    <div>
      <Skeleton className="h-9 w-full max-w-sm mb-4" />
      <TableSkeleton />
    </div>
  )
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
                  <TableHead className="text-right">Acciones</TableHead>
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
                      {bloqueados.has(soloDigitos(c.phone))
                        ? <Badge variant="secondary" className="bg-destructive/10 text-destructive">Bloqueado</Badge>
                        : <Badge variant="secondary" className={STATUS_BADGE[c.status].cls}>{STATUS_BADGE[c.status].label}</Badge>}
                    </TableCell>
                    <TableCell className="w-[1%] text-right">
                      {bloqueados.has(soloDigitos(c.phone)) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => mBlock.mutate({ phone: c.phone, blocked: false })}
                        >
                          <Undo2 /> Desbloquear
                        </Button>
                      ) : (
                        <ConfirmAction
                          trigger={
                            <Button variant="outline" size="sm" aria-label={`Bloquear a ${c.name}`}>
                              <Ban /> Bloquear
                            </Button>
                          }
                          title={`Bloquear a ${c.name}`}
                          description="No podrá hacer pedidos en tu tienda, ni siquiera con su enlace guardado. No se le avisa de nada. Puedes desbloquearlo desde aquí mismo."
                          confirmLabel="Bloquear"
                          destructive
                          onConfirm={() => mBlock.mutate({ phone: c.phone, blocked: true })}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <p className="text-xs text-muted-foreground/80 mt-2.5">{filtered.length} cliente(s){search ? ' (filtrados)' : ''} · "Inactivo" = sin comprar hace más de 60 días.</p>
        </>
      )}
      <OtrosBloqueados
        numeros={listaBloqueados.filter(phone => !customers.some(c => soloDigitos(c.phone) === soloDigitos(phone)))}
        onDesbloquear={phone => mBlock.mutate({ phone, blocked: false })}
      />
    </div>
  )
}

/**
 * Los bloqueados que NO están en el directorio.
 *
 * ⚠️ Sin esto quedaban atrapados para siempre: el directorio sale de `sales`
 * —quien COMPRÓ— y quien pide para molestar normalmente no ha comprado nada,
 * así que su fila no existe ahí y no habría dónde tocar «Desbloquear».
 *
 * No se pinta si no hay ninguno, que es el caso de casi todos los negocios.
 */
function OtrosBloqueados({ numeros, onDesbloquear }: {
  numeros: string[]
  onDesbloquear: (phone: string) => void
}) {
  if (!numeros.length) return null
  return (
    <Card className="mt-6 p-4 gap-2">
      <h2 className="text-sm font-semibold text-foreground">Otros números bloqueados</h2>
      <p className="text-xs text-muted-foreground">
        No han comprado, así que no salen en el directorio. No pueden hacer pedidos en tu tienda.
      </p>
      {numeros.map(phone => (
        <div key={phone} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
          <span className="flex-1 font-mono text-sm text-foreground/80">{phone}</span>
          <Button variant="outline" size="sm" onClick={() => onDesbloquear(phone)}>
            <Undo2 /> Desbloquear
          </Button>
        </div>
      ))}
    </Card>
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

      {isLoading ? <TableSkeleton /> :
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
