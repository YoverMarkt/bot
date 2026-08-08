// ── PEDIDOS ───────────────────────────────────────────────────────────────
//
// La bandeja de entrada del negocio. Existe separada de Ventas porque son dos
// momentos distintos: un pedido LLEGA y hay que atenderlo ya —lo inicia el
// cliente—; una venta se REGISTRA cuando ya se cobró, y la cierra el negocio.
// Mientras los pedidos vivieron dentro de Ventas, el dueño tenía que entrar a
// "registrar una venta" para ver algo que todavía no había vendido, y por eso
// nadie conectó nunca la alarma ahí.
//
// El orden manda: primero lo que espera respuesta, y dentro de eso, lo más
// viejo arriba. Un pedido que lleva 20 minutos sin aceptar es el problema más
// urgente de la pantalla, no el que acaba de entrar.
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Banknote, Bike, Clock, Landmark, MapPin, Receipt, ShoppingBag, Check, X, FileText, Plus,
} from 'lucide-react'
import {
  ACTIVOS, ESTADO_COLOR, ESTADO_TEXTO, getOrderProof, getOrders, money,
  setOrderStatus, siguientePaso,
  type Order, type OrderStatus,
} from './api'
import CounterOrder from './CounterOrder'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@botpanel/ui/components/tabs'

const hora = (iso: string) =>
  new Date(iso).toLocaleString('es-EC', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })

/** Cuánto lleva esperando. Es el dato que dice si algo va mal. */
const espera = (iso: string) => {
  const minutos = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutos < 1) return 'ahora mismo'
  if (minutos < 60) return `hace ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `hace ${horas} h`
  return `hace ${Math.floor(horas / 24)} d`
}

export default function Orders() {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState<'activos' | 'todos'>('activos')
  const [mostrador, setMostrador] = useState(false)

  const { data: pedidos = [], isLoading } = useQuery({
    queryKey: ['orders'],
    queryFn: getOrders,
    // Mismo ritmo que la alarma: si suena, la lista ya tiene el pedido.
    refetchInterval: 12_000,
  })

  const cambiar = useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrderStatus }) => setOrderStatus(id, status),
    onSuccess: (_data, variables) => {
      const textos: Record<OrderStatus, string> = {
        confirmado: 'Pedido aceptado.',
        aceptado: 'Pedido aceptado.',
        preparacion: 'Pedido en preparación.',
        listo_para_retiro: 'Listo. Avísale al cliente que ya puede venir.',
        en_camino: 'En camino. Avísale al cliente que ya salió.',
        completado: 'Pedido entregado.',
        cancelado: 'Pedido cancelado.',
        rechazado: 'Pedido rechazado.',
        pendiente: 'Pedido actualizado.',
        esperando_pago: 'A la espera del pago.',
        pago_en_revision: 'Comprobante en revisión.',
        expirado: 'Pedido expirado.',
      }
      toast.success(textos[variables.status])
      void qc.invalidateQueries({ queryKey: ['orders'] })
      // La alarma mira la misma lista: se refresca para que deje de sonar.
      void qc.invalidateQueries({ queryKey: ['orders-watch'] })
    },
    onError: error => toast.error(
      error instanceof Error ? error.message : 'No se pudo actualizar el pedido',
    ),
  })

  const activos = useMemo(
    () => pedidos.filter(p => ACTIVOS.includes(p.status)),
    [pedidos],
  )

  const visibles = useMemo(() => {
    const lista = filtro === 'activos' ? activos : pedidos
    // Los que esperan, primero; y entre ellos, el más viejo arriba.
    return [...lista].sort((a, b) => {
      const activoA = ACTIVOS.includes(a.status) ? 0 : 1
      const activoB = ACTIVOS.includes(b.status) ? 0 : 1
      if (activoA !== activoB) return activoA - activoB
      const fechaA = new Date(a.created_at).getTime()
      const fechaB = new Date(b.created_at).getTime()
      return activoA === 0 ? fechaA - fechaB : fechaB - fechaA
    })
  }, [pedidos, activos, filtro])

  const cuenta = (estado: OrderStatus) => activos.filter(p => p.status === estado).length

  /**
   * Los cuatro estados que más trabajo tienen parado ahora mismo.
   *
   * `pago_en_revision` va SIEMPRE que tenga algo: es un comprobante esperando
   * a que una persona lo mire, y mientras tanto el cliente no sabe si su
   * pedido existe.
   */
  const resumen = useMemo(() => {
    const conPedidos = ACTIVOS.filter(estado => cuenta(estado) > 0)
    const urgentes = conPedidos.filter(estado => estado === 'pago_en_revision')
    const resto = conPedidos.filter(estado => estado !== 'pago_en_revision')
    return [...urgentes, ...resto].slice(0, 4)
  }, [activos])

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pedidos</h1>
          <p className="text-sm text-muted-foreground">
            Lo que llega por la tienda y por el bot, de que entra hasta que se entrega
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={filtro} onValueChange={v => setFiltro(v as typeof filtro)}>
            <TabsList>
              <TabsTrigger value="activos">
                En curso{activos.length ? ` (${activos.length})` : ''}
              </TabsTrigger>
              <TabsTrigger value="todos">Historial</TabsTrigger>
            </TabsList>
          </Tabs>
          {!mostrador && (
            <Button onClick={() => setMostrador(true)}><Plus /> Nuevo pedido</Button>
          )}
        </div>
      </div>

      {mostrador && (
        <div className="mb-4">
          <CounterOrder onListo={() => setMostrador(false)} />
        </div>
      )}

      {/* Resumen del momento: dónde está atascado el trabajo. */}
      {!isLoading && activos.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* Se enseñan los cuatro estados con más pedidos parados: con doce,
              una rejilla fija dejaría cuadros en cero ocupando la pantalla y
              escondería justo el que hay que atender. */}
          {resumen.map(estado => (
            <Card key={estado} className="p-3 gap-0">
              <span className="text-xs text-muted-foreground">{ESTADO_TEXTO[estado]}</span>
              <span className="text-xl font-bold text-foreground tabular-nums">{cuenta(estado)}</span>
            </Card>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-4 gap-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          ))}
        </div>
      )}

      {!isLoading && !visibles.length && (
        <Card className="p-10 text-center gap-1">
          <Receipt className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="font-medium text-foreground/90">
            {filtro === 'activos' ? 'Ningún pedido en curso.' : 'Todavía no hay pedidos.'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Cuando un cliente pida por la tienda o por WhatsApp, aparece aquí y suena la alarma.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {visibles.map(pedido => (
          <TarjetaPedido
            key={pedido.id}
            pedido={pedido}
            ocupado={cambiar.isPending}
            onCambiar={(status) => cambiar.mutate({ id: pedido.id, status })}
          />
        ))}
      </div>
    </div>
  )
}

function TarjetaPedido({ pedido, ocupado, onCambiar }: {
  pedido: Order
  ocupado: boolean
  onCambiar: (status: OrderStatus) => void
}) {
  const paso = siguientePaso(pedido)
  const domicilio = !pedido.fulfillment || pedido.fulfillment === 'delivery'
  const direccion = pedido.customer_addresses
  const enCurso = ACTIVOS.includes(pedido.status)
  const [abriendo, setAbriendo] = useState(false)

  /**
   * Se pide la URL firmada AL TOCAR, no al pintar la lista: firmarla antes
   * sería repartir accesos a comprobantes que nadie va a mirar, y cada uno
   * caduca desde que se emite.
   */
  const abrirComprobante = async () => {
    setAbriendo(true)
    try {
      const { url } = await getOrderProof(pedido.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error('No pudimos abrir el comprobante')
    } finally {
      setAbriendo(false)
    }
  }

  return (
    <Card className={`p-4 gap-0 ${enCurso ? '' : 'opacity-70'}`}>
      {/* Quién y cuándo */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold text-foreground">
            {pedido.contact_name || pedido.contact_phone}
          </span>
          <span className="ml-2 text-xs text-muted-foreground/80">{pedido.contact_phone}</span>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {espera(pedido.created_at)} · {hora(pedido.created_at)}
          </div>
        </div>
        <Badge variant="secondary" className={ESTADO_COLOR[pedido.status]}>
          {ESTADO_TEXTO[pedido.status]}
        </Badge>
        {/* Un pedido programado no se prepara ahora. Si esto no se ve, la
            cocina lo saca cuatro horas antes de tiempo. */}
        {pedido.scheduled_for && (
          <Badge
            variant="secondary"
            className="bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300"
          >
            <Clock className="mr-1 h-3 w-3" />
            Para {new Date(pedido.scheduled_for).toLocaleString('es-EC', {
              timeZone: 'America/Guayaquil',
              weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
          </Badge>
        )}
      </div>

      {/* Qué pidió */}
      <div className="mt-3 space-y-1 text-sm">
        {pedido.order_items.map((item, indice) => (
          <div key={indice} className="flex justify-between gap-3">
            <span className="min-w-0">
              <span className="font-medium text-foreground">{item.quantity}× {item.product_name}</span>
              {item.variant_name && (
                <span className="text-muted-foreground"> · {item.variant_name}</span>
              )}
              {item.extras_names?.length ? (
                <span className="block text-xs text-muted-foreground">
                  {item.extras_names.join(' · ')}
                </span>
              ) : null}
              {item.item_note && (
                <span className="block text-xs italic text-muted-foreground">“{item.item_note}”</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {money(item.line_total)}
            </span>
          </div>
        ))}
      </div>

      {/* A dónde va y cómo paga: lo que necesita quien lo entrega */}
      <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 text-sm sm:grid-cols-2">
        <div className="flex items-start gap-2">
          {domicilio
            ? <Bike className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            : <ShoppingBag className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="font-medium text-foreground">
              {domicilio ? 'A domicilio' : 'Retira en el local'}
            </div>
            {domicilio && (
              direccion
                ? (
                    <div className="text-xs text-muted-foreground">
                      <span className="flex items-start gap-1">
                        <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          {direccion.address}
                          {direccion.reference && <span className="block">{direccion.reference}</span>}
                        </span>
                      </span>
                      {/* Lo que el cliente pidió para ESTE pedido. Va aquí, con
                          la dirección, que es donde lo busca quien reparte. */}
                      {pedido.delivery_notes && (
                        <span className="mt-1 block font-medium text-foreground">
                          «{pedido.delivery_notes}»
                        </span>
                      )}
                    </div>
                  )
                : (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      Sin dirección — coordínala por WhatsApp
                    </div>
                  )
            )}
          </div>
        </div>

        <div className="flex items-start gap-2">
          {pedido.payment_method === 'efectivo'
            ? <Banknote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            : <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="font-medium text-foreground">
              {pedido.payment_method === 'efectivo'
                ? 'Paga en efectivo'
                : pedido.payment_method === 'transferencia'
                  ? 'Transferencia'
                  : pedido.payment_method === 'pago_al_retirar'
                    ? 'Paga al retirar'
                    : 'Pago por coordinar'}
            </div>
            {pedido.payment_method === 'transferencia' && (
              pedido.payment_proof_url
                ? (
                    <button
                      type="button"
                      onClick={abrirComprobante}
                      disabled={abriendo}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-primary underline underline-offset-2 disabled:opacity-50"
                    >
                      <FileText className="h-3 w-3" />
                      {abriendo ? 'Abriendo…' : 'Ver comprobante'}
                    </button>
                  )
                : (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      Sin comprobante todavía
                    </span>
                  )
            )}
          </div>
        </div>
      </div>

      {/* El dinero, tal como lo calculó el servidor */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        <div className="text-sm">
          <span className="text-muted-foreground">Subtotal {money(pedido.subtotal)}</span>
          {Number(pedido.discount) > 0 && (
            <span className="ml-3 text-muted-foreground">Descuento −{money(pedido.discount)}</span>
          )}
          {Number(pedido.shipping) > 0 && (
            <span className="ml-3 text-muted-foreground">Envío {money(pedido.shipping!)}</span>
          )}
          <span className="ml-3 font-bold text-foreground">Total {money(pedido.total)}</span>
        </div>

        {/* Las acciones: avanzar o rechazar. Nunca retroceder. */}
        {paso && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <ConfirmAction
              trigger={
                <Button size="sm" disabled={ocupado}>
                  <Check /> {paso.etiqueta}
                </Button>
              }
              title={paso.etiqueta}
              description={paso.descripcion}
              confirmLabel={paso.etiqueta}
              onConfirm={() => onCambiar(paso.status)}
            />
            {/* Atajo para quien no reparte: cerrar sin recorrer todo el flujo. */}
            {pedido.status !== 'pendiente' && paso.status !== 'completado' && (
              <ConfirmAction
                trigger={<Button variant="outline" size="sm" disabled={ocupado}><Check /> Marcar entregado</Button>}
                title="Marcar entregado"
                description="El pedido queda cerrado como entregado."
                confirmLabel="Marcar entregado"
                onConfirm={() => onCambiar('completado')}
              />
            )}
            {/* Rechazar el COMPROBANTE no es cancelar el pedido: son cosas
                distintas y el cliente merece saber cuál pasó. `rechazado`
                significa «el pago no cuadra», y deja la puerta abierta a que
                mande otro; `cancelado` cierra el pedido. */}
            {pedido.status === 'pago_en_revision' && (
              <ConfirmAction
                trigger={
                  <Button variant="outline" size="sm" disabled={ocupado}>
                    <X /> Rechazar el pago
                  </Button>
                }
                title="Rechazar el comprobante"
                description="El comprobante no cuadra. Avísale al cliente por WhatsApp para que mande otro."
                confirmLabel="Rechazar el pago"
                destructive
                onConfirm={() => onCambiar('rechazado')}
              />
            )}
            <ConfirmAction
              trigger={
                <Button variant="outline" size="sm" disabled={ocupado}>
                  <X /> {pedido.status === 'pendiente' ? 'Rechazar' : 'Cancelar'}
                </Button>
              }
              title={pedido.status === 'pendiente' ? 'Rechazar pedido' : 'Cancelar pedido'}
              description="El pedido queda cerrado y no se puede reabrir. Avísale al cliente por WhatsApp."
              confirmLabel={pedido.status === 'pendiente' ? 'Rechazar' : 'Cancelar pedido'}
              destructive
              onConfirm={() => onCambiar('cancelado')}
            />
          </div>
        )}
      </div>
    </Card>
  )
}
