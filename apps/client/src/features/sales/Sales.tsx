import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as salesApi from './api'
import { api } from '../../api/client'
import { Receipt, Lightbulb, Check, X } from 'lucide-react'
import type { Order, SaleItem } from './api'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Badge } from '@botpanel/ui/components/badge'
import { Tabs, TabsList, TabsTrigger } from '@botpanel/ui/components/tabs'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Label } from '@botpanel/ui/components/label'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const { money, cents } = salesApi

const ORDER_BADGE: Record<Order['status'], string> = {
  pendiente:  'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  confirmado: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
  completado: 'bg-green-500/10 text-green-700 dark:text-green-300',
  cancelado:  'bg-muted text-muted-foreground',
  expirado:   'bg-muted text-muted-foreground',
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function Sales() {
  // Prellenado desde Conversaciones (botón "Registrar venta" del chat)
  const [params] = useSearchParams()
  const prefillPhone = params.get('phone') ?? ''
  const [tab, setTab] = useState<'orders' | 'register' | 'history'>(prefillPhone ? 'register' : 'orders')
  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Ventas</h1>
          <p className="text-sm text-muted-foreground">Pedidos del bot con total oficial + registro manual</p>
        </div>
        <div className="max-w-full overflow-x-auto pb-1">
          <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
            <TabsList>
              {([['orders', 'Pedidos del bot'], ['register', 'Registrar venta'], ['history', 'Por contacto']] as const).map(([v, l]) => (
                <TabsTrigger key={v} value={v}>{l}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>
      {tab === 'orders' && <BotOrders />}
      {tab === 'register' && (
        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <RegisterSale prefillPhone={prefillPhone} />
          <div>
            <h2 className="font-semibold text-foreground mb-3 flex items-center gap-2"><Receipt className="w-4 h-4 text-muted-foreground" /> Ventas que hizo el bot (resumen)</h2>
            <BotOrders />
          </div>
        </div>
      )}
      {tab === 'history' && <SalesByContact />}
    </div>
  )
}

// ── Pedidos del bot (núcleo de dinero: totales oficiales del server) ──
function BotOrders() {
  const queryClient = useQueryClient()
  const { data: orders = [], isLoading } = useQuery({ queryKey: ['orders'], queryFn: salesApi.getOrders, refetchInterval: 15_000 })
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'confirmado' | 'completado' | 'cancelado' }) => api(`/api/client/orders/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),
    onSuccess: (_data, variables) => {
      const messages = {
        confirmado: 'Pedido confirmado. Coordina la entrega directamente con el cliente.',
        completado: 'Pedido marcado como completado.',
        cancelado: 'Pedido cancelado.',
      }
      toast.success(messages[variables.status])
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: error => toast.error(error instanceof Error ? error.message : 'No se pudo actualizar el pedido'),
  })
  if (isLoading) return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="p-4 gap-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ))}
    </div>
  )
  if (!orders.length) return (
    <Card className="p-8 text-center gap-1">
      <Receipt className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
      <p className="text-foreground/90 font-medium">Aún no hay pedidos del bot.</p>
      <p className="text-sm text-muted-foreground mt-1">Cuando un cliente confirme una compra por WhatsApp, el pedido aparece aquí con su total oficial calculado por el sistema.</p>
    </Card>
  )
  return (
    <div className="space-y-3">
      {orders.map(o => (
        <Card key={o.id} className="p-4 gap-0">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="font-semibold text-foreground">{o.contact_name || o.contact_phone}</span>
              <span className="text-xs text-muted-foreground/80 ml-2">{o.contact_phone}</span>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant="secondary" className={`uppercase ${ORDER_BADGE[o.status]}`}>{o.status}</Badge>
              <span className="text-xs text-muted-foreground/80">{fmtDate(o.created_at)}</span>
            </div>
          </div>
          <div className="mt-2 text-sm text-muted-foreground space-y-0.5">
            {o.order_items.map((i, idx) => (
              <div key={idx} className="flex justify-between">
                <span>{i.quantity} × {i.product_name}</span>
                <span>{money(i.unit_price)} c/u = {money(i.line_total)}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-2">
            <div>
              {Number(o.discount) > 0 && <span className="mr-3 text-xs text-muted-foreground">Descuento: −{money(o.discount)}</span>}
              <span className="font-bold text-foreground">Total: {money(o.total)}</span>
            </div>
            {(o.status === 'pendiente' || o.status === 'confirmado') && (
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                <span className="max-w-xs text-right text-xs text-muted-foreground">
                  {o.status === 'pendiente' ? 'Confirma el pedido antes de prepararlo para la entrega.' : 'Ciérralo cuando la entrega haya terminado.'}
                </span>
                <ConfirmAction
                  trigger={<Button size="sm" disabled={updateStatus.isPending}><Check /> {o.status === 'pendiente' ? 'Confirmar pedido' : 'Marcar completado'}</Button>}
                  title={o.status === 'pendiente' ? 'Confirmar pedido' : 'Completar pedido'}
                  description={o.status === 'pendiente' ? 'El pedido quedará confirmado para que el negocio coordine la entrega con el cliente.' : 'El pedido quedará cerrado como completado y contará en su estado final.'}
                  confirmLabel={o.status === 'pendiente' ? 'Confirmar pedido' : 'Marcar completado'}
                  onConfirm={() => updateStatus.mutate({ id: o.id, status: o.status === 'pendiente' ? 'confirmado' : 'completado' })}
                />
                <ConfirmAction
                  trigger={<Button variant="outline" size="sm" disabled={updateStatus.isPending}><X /> Cancelar</Button>}
                  title="Cancelar pedido"
                  description="El pedido quedará cerrado como cancelado. Esta acción no se puede revertir."
                  confirmLabel="Cancelar pedido"
                  destructive
                  onConfirm={() => updateStatus.mutate({ id: o.id, status: 'cancelado' })}
                />
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}

// ── Registrar venta manual (con prellenado desde la conversación) ──
function RegisterSale({ prefillPhone = '' }: { prefillPhone?: string }) {
  const qc = useQueryClient()
  const { data: products = [] } = useQuery({ queryKey: ['products'], queryFn: salesApi.getProducts })
  const [phone, setPhone] = useState(prefillPhone)
  const [name, setName] = useState('')
  const [items, setItems] = useState<Omit<SaleItem, 'line_total'>[]>([])
  const [msg, setMsg] = useState('')

  const total = useMemo(() => cents(items.reduce((s, i) => s + cents(i.quantity * i.unit_price), 0)), [items])

  function addItem(productId: string) {
    const p = products.find(x => x.id === productId)
    if (!p) return
    const price = Number(p.price_sale) > 0 ? Number(p.price_sale) : Number(p.price) || 0
    setItems(prev => [...prev, { product_id: p.id, product_name: p.name, quantity: 1, unit_price: price }])
  }

  // Al llegar desde el chat: traer la cotización de ese contacto automáticamente
  useEffect(() => { if (prefillPhone) loadQuote() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  async function loadQuote() {
    if (!phone.trim()) return
    try {
      const q = await salesApi.getQuote(phone.trim())
      if (q.contact_name) setName(q.contact_name)
      if (q.suggested.length) {
        setItems(q.suggested.map(s => ({ product_id: s.product_id, product_name: s.product_name, quantity: s.quantity, unit_price: s.unit_price })))
        setMsg(`${q.suggested.length} producto(s) sugeridos desde la conversación`)
      } else setMsg('Sin sugerencias de la conversación — agrega los productos abajo')
    } catch { setMsg('No se encontró conversación con ese número') }
  }

  const mSave = useMutation({
    mutationFn: async () => {
      await salesApi.registerSale({ contact_phone: phone.trim() || null, contact_name: name.trim() || null, items })
      // Si venimos de una conversación, registrarla también la CIERRA (el bot arranca contexto nuevo)
      if (prefillPhone) await api(`/api/client/sessions/${encodeURIComponent(prefillPhone)}/close`, { method: 'PUT' }).catch(() => {})
    },
    onSuccess: () => {
      setItems([]); setPhone(''); setName(''); setMsg(''); toast.success('Venta registrada — ya cuenta en tus reportes')
      qc.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error al registrar'),
  })


  return (
    <Card className="p-5 max-w-2xl gap-0">
      <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="sale-contact-phone">Teléfono del cliente</Label>
          <div className="flex gap-2">
            <Input id="sale-contact-phone" className="flex-1" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+593…" />
            <Button variant="outline" size="icon" onClick={loadQuote} type="button" title="Traer lo cotizado en la conversación" aria-label="Traer cotización"><Lightbulb /></Button>
          </div>
        </div>
        <div>
          <Label htmlFor="sale-contact-name">Nombre</Label>
          <Input id="sale-contact-name" value={name} onChange={e => setName(e.target.value)} placeholder="opcional" />
        </div>
      </div>

      <Label htmlFor="sale-product">Agregar producto</Label>
      <Select value="" onValueChange={addItem}>
        <SelectTrigger id="sale-product" className="w-full mb-3"><SelectValue placeholder="Elige un producto del catálogo…" /></SelectTrigger>
        <SelectContent>
          {products.map(p => <SelectItem key={p.id} value={p.id}>{p.name} — {money(Number(p.price_sale) > 0 ? p.price_sale! : p.price)}</SelectItem>)}
        </SelectContent>
      </Select>

      {items.map((it, idx) => (
        <div key={idx} className="flex items-center gap-2 mb-2 text-sm">
          <span className="flex-1 truncate text-foreground">{it.product_name}</span>
          <Input id={`sale-item-${idx}-quantity`} aria-label={`Cantidad de ${it.product_name}`} type="number" min={1} max={99} value={it.quantity}
            onChange={e => setItems(prev => prev.map((x, i) => i === idx ? { ...x, quantity: Math.max(1, parseInt(e.target.value) || 1) } : x))}
            className="w-16 text-center" />
          <span className="text-muted-foreground">× {money(it.unit_price)}</span>
          <span className="w-20 text-right font-medium">{money(cents(it.quantity * it.unit_price))}</span>
          <Button variant="ghost" size="icon" onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))} aria-label={`Quitar ${it.product_name}`}><X /></Button>
        </div>
      ))}

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/60">
        <span className="font-bold text-lg text-foreground">Total: {money(total)}</span>
        <Button
          onClick={() => mSave.mutate()} disabled={!items.length || mSave.isPending}>
          {mSave.isPending ? 'Registrando…' : <span className="inline-flex items-center gap-1.5"><Check className="w-4 h-4" /> Registrar venta</span>}
        </Button>
      </div>
      {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
    </Card>
  )
}

// ── Ventas por contacto (ver + anular) ──
function SalesByContact() {
  const qc = useQueryClient()
  const [phone, setPhone] = useState('')
  const [searched, setSearched] = useState('')

  const { data: sales = [], isFetching } = useQuery({
    queryKey: ['sales-by-phone', searched],
    queryFn: () => salesApi.getSalesByPhone(searched),
    enabled: !!searched,
  })

  const mVoid = useMutation({
    mutationFn: salesApi.voidSale,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales-by-phone', searched] }),
  })

  return (
    <div className="max-w-2xl">
      <form onSubmit={e => { e.preventDefault(); setSearched(phone.trim()) }} className="flex gap-2 mb-4">
        <Input id="sales-search-phone" aria-label="Teléfono del cliente" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Teléfono del cliente (+593…)" className="flex-1" />
        <Button>Buscar</Button>
      </form>
      {isFetching && <p className="text-muted-foreground text-sm">Buscando…</p>}
      {searched && !isFetching && sales.length === 0 && <p className="text-muted-foreground text-sm">Sin ventas registradas para ese número.</p>}
      <div className="space-y-3">
        {sales.map(s => (
          <Card key={s.id} className={`p-4 gap-0 ${s.status === 'anulada' ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">{money(s.total)} {s.status === 'anulada' && <span className="text-xs font-normal text-red-500 ml-2">ANULADA</span>}</span>
              <span className="text-xs text-muted-foreground/80">{fmtDate(s.sold_at)}</span>
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              {(s.sale_items ?? s.items ?? []).map((i, idx) => <div key={idx}>{i.quantity} × {i.product_name} — {money(i.line_total)}</div>)}
            </div>
            {s.status === 'completada' && (
              <ConfirmAction
                trigger={<Button variant="outline" size="sm" className="mt-2">Anular venta</Button>}
                title="Anular venta"
                description="La venta se marcará como anulada y dejará de contar en los reportes."
                confirmLabel="Anular venta"
                destructive
                onConfirm={() => mVoid.mutate(s.id)}
              />
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
