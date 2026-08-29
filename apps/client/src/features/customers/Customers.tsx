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
import { Label } from '@botpanel/ui/components/label'
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

/**
 * Qué dice la insignia de un bloqueado.
 *
 * ⚠️ Son DOS cosas distintas y el panel las pintaba igual:
 *
 *   · **Bloqueado por ti** — lo puso el dueño, no caduca, solo él lo levanta.
 *   · **Bloqueado 25 min** — lo puso Umbani por incumplir las políticas, y se
 *     va solo cuando pasa el plazo.
 *
 * Hasta el 2026-08-29 las dos salían como «Bloqueado» y el automático **no
 * desaparecía nunca de esta pantalla**, aunque el cliente ya pudiera pedir.
 * El dueño lo preguntó mirando su lista: «¿ese tiempo va con el de bloqueado
 * aquí en el panel, o tengo que quitarlo yo?».
 */
const etiquetaDelBloqueo = (
  estado: { until: string | null; permanent: boolean },
): string => {
  if (estado.permanent || !estado.until) return 'Bloqueado por ti'
  const restan = new Date(estado.until).getTime() - Date.now()
  // Sin plazo legible se dice lo neutro: nunca un «0 min» que parece un error.
  if (!Number.isFinite(restan) || restan <= 0) return 'Bloqueado'
  const minutos = Math.ceil(restan / 60000)
  if (minutos >= 60) {
    const horas = Math.floor(minutos / 60)
    const sueltos = minutos % 60
    return sueltos ? `Bloqueado ${horas} h ${sueltos} min` : `Bloqueado ${horas} h`
  }
  return `Bloqueado ${minutos} min`
}

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
  //
  // ⚠️ Un MAPA y ya no un `Set` de teléfonos (2026-08-29): hay dos clases de
  // bloqueo y el dueño necesita distinguirlas. El suyo no caduca y solo él lo
  // levanta; el automático de Umbani se va solo, y hasta ahora el panel los
  // pintaba igual — así que un cliente que ya podía pedir seguía saliendo
  // «Bloqueado» aquí para siempre.
  const bloqueados = useMemo(() => {
    const mapa = new Map<string, { until: string | null; permanent: boolean }>()
    for (const fila of (Array.isArray(blocked) ? blocked : [])) {
      if (!fila?.phone) continue
      mapa.set(soloDigitos(fila.phone), {
        until: fila.until ?? null,
        permanent: fila.permanent === true,
      })
    }
    return mapa
  }, [blocked])
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
                        ? (
                            <Badge variant="secondary" className="bg-destructive/10 text-destructive">
                              {etiquetaDelBloqueo(bloqueados.get(soloDigitos(c.phone))!)}
                            </Badge>
                          )
                        : <Badge variant="secondary" className={STATUS_BADGE[c.status].cls}>{STATUS_BADGE[c.status].label}</Badge>}
                    </TableCell>
                    <TableCell className="w-[1%] text-right">
                      {bloqueados.has(soloDigitos(c.phone)) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => mBlock.mutate({ phone: c.phone, blocked: false })}
                        >
                          {/* «Levantar ahora» en el automático: no lo bloqueaste
                              tú, así que «Desbloquear» suena a deshacer algo que
                              no hiciste. Lo que hace el botón es adelantar el
                              final del plazo, y eso sí lo decide el dueño. */}
                          <Undo2 />
                          {bloqueados.get(soloDigitos(c.phone))!.permanent
                            ? 'Desbloquear'
                            : 'Levantar ahora'}
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
          {/* El dueño preguntó esto mirando esta misma lista: si el bloqueo
              con plazo se lo tenía que quitar él. La respuesta va donde surge
              la duda, no en un manual que nadie abre. */}
          <p className="text-xs text-muted-foreground/80 mt-2.5">{filtered.length} cliente(s){search ? ' (filtrados)' : ''} · "Inactivo" = sin comprar hace más de 60 días.</p>
          <p className="text-xs text-muted-foreground/80 mt-1">
            <span className="text-destructive">Bloqueado por ti</span> lo levantas tú.{' '}
            <span className="text-destructive">Bloqueado 25 min</span> lo puso Umbani por incumplir
            las políticas y se va solo al cumplirse el plazo — no tienes que hacer nada.
          </p>
        </>
      )}
      <Bloqueados
        numeros={listaBloqueados
          .map(fila => fila.phone)
          .filter(phone => !customers.some(c => soloDigitos(c.phone) === soloDigitos(phone)))}
        onBloquear={phone => mBlock.mutate({ phone, blocked: true })}
        onDesbloquear={phone => mBlock.mutate({ phone, blocked: false })}
      />
    </div>
  )
}

/**
 * Bloquear por NÚMERO, y la lista de los que no salen en el directorio.
 *
 * ⚠️ ESTO ES LO QUE FALTABA, y sin ello el bloqueo no servía para el caso que
 * existe para cubrir. El directorio de arriba sale de `sales` —quien COMPRÓ y
 * recibió su pedido—, y **quien pide para molestar nunca llega ahí**: su pedido
 * se cancela, así que jamás se convierte en venta. El dueño podía bloquear a
 * sus buenos clientes y a nadie más.
 *
 * El servidor ya estaba preparado: `setContactBlocked` crea el cliente si no
 * existía, y su comentario dice literalmente «quien escribe por molestar puede
 * no haber pedido nunca, y es justo a ese al que hay que poder bloquear». Lo
 * que faltaba era la casilla donde escribirlo.
 *
 * Se pinta SIEMPRE, aunque no haya ninguno: si solo apareciera cuando ya hay un
 * bloqueado, el dueño no descubriría nunca que puede bloquear a alguien que no
 * le ha comprado — que es justo cuando lo necesita.
 */
function Bloqueados({ numeros, onBloquear, onDesbloquear }: {
  numeros: string[]
  onBloquear: (phone: string) => void
  onDesbloquear: (phone: string) => void
}) {
  const [nuevo, setNuevo] = useState('')
  const digitos = nuevo.replace(/\D/g, '')
  // E.164: entre 8 y 15 dígitos. Ni un teléfono a medias ni un número pegado
  // con espacios de más pueden acabar bloqueando a otra persona.
  const valido = digitos.length >= 8 && digitos.length <= 15

  function bloquear() {
    if (!valido) return
    onBloquear(digitos)
    setNuevo('')
  }

  return (
    <Card className="mt-6 p-4 gap-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Números bloqueados</h2>
        <p className="text-xs text-muted-foreground">
          Un bloqueado no puede hacer pedidos en tu tienda, ni siquiera con su enlace guardado,
          y el menú de Umbani deja de ofrecerle tu local. No se le avisa de nada.
          El que bloqueas tú no caduca: se queda hasta que lo levantes.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor="customers-block-phone">Bloquear un número</Label>
          <Input
            id="customers-block-phone"
            value={nuevo}
            onChange={e => setNuevo(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); bloquear() } }}
            placeholder="+593…"
            className="mt-1 max-w-xs"
          />
        </div>
        <ConfirmAction
          trigger={
            <Button variant="outline" disabled={!valido}>
              <Ban /> Bloquear
            </Button>
          }
          title={`Bloquear el número ${digitos}`}
          description="No podrá hacer pedidos en tu tienda ni ver tu local en el menú de Umbani. No se le avisa. Puedes desbloquearlo desde aquí mismo."
          confirmLabel="Bloquear"
          destructive
          onConfirm={bloquear}
        />
      </div>
      {nuevo && !valido && (
        <p className="text-xs text-destructive">
          Escribe el número completo con su código de país (entre 8 y 15 dígitos).
        </p>
      )}

      {numeros.length > 0 && (
        <div className="mt-1">
          <p className="mb-1 text-xs text-muted-foreground">
            Bloqueados que no aparecen arriba porque no te han comprado:
          </p>
          {numeros.map(phone => (
            <div key={phone} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
              <span className="flex-1 font-mono text-sm text-foreground/80">{phone}</span>
              <Button variant="outline" size="sm" onClick={() => onDesbloquear(phone)}>
                <Undo2 /> Desbloquear
              </Button>
            </div>
          ))}
        </div>
      )}
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
