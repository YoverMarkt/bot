import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as salesApi from './api'
import { api } from '../../api/client'
import { Receipt, Lightbulb } from 'lucide-react'
import type { Order, SaleItem } from './api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { money, cents } = salesApi

const ORDER_BADGE: Record<Order['status'], string> = {
  pendiente:  'bg-amber-50 text-amber-700',
  confirmado: 'bg-blue-50 text-blue-700',
  pagado:     'bg-primary/10 text-primary',
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
        <div className="flex gap-1 bg-card border rounded-lg p-1">
          {([['orders', 'Pedidos del bot'], ['register', 'Registrar venta'], ['history', 'Por contacto']] as const).map(([v, l]) => (
            <Button variant="ghost" key={v} onClick={() => setTab(v)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>
              {l}
            </Button>
          ))}
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
  const { data: orders = [], isLoading } = useQuery({ queryKey: ['orders'], queryFn: salesApi.getOrders, refetchInterval: 15_000 })
  if (isLoading) return <p className="text-muted-foreground">Cargando pedidos…</p>
  if (!orders.length) return (
    <div className="bg-card rounded-xl border p-8 text-center">
      <div className="text-3xl mb-2">🧾</div>
      <p className="text-foreground/90 font-medium">Aún no hay pedidos del bot.</p>
      <p className="text-sm text-muted-foreground mt-1">Cuando un cliente confirme una compra por WhatsApp, el pedido aparece aquí con su total oficial calculado por el sistema.</p>
    </div>
  )
  return (
    <div className="space-y-3">
      {orders.map(o => (
        <div key={o.id} className="bg-card rounded-xl border p-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="font-semibold text-foreground">{o.contact_name || o.contact_phone}</span>
              <span className="text-xs text-muted-foreground/80 ml-2">{o.contact_phone}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-[11px] font-semibold rounded px-2 py-0.5 uppercase ${ORDER_BADGE[o.status]}`}>{o.status}</span>
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
          <div className="mt-2 pt-2 border-t border-border/60 flex justify-between items-center">
            {Number(o.discount) > 0 && <span className="text-xs text-muted-foreground">Descuento: −{money(o.discount)}</span>}
            <span className="ml-auto font-bold text-foreground">💰 Total: {money(o.total)}</span>
          </div>
        </div>
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
      setItems([]); setPhone(''); setName(''); setMsg('✓ Venta registrada — ya cuenta en tus reportes')
      qc.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (e) => setMsg(`✗ ${e instanceof Error ? e.message : 'Error al registrar'}`),
  })

  const input = 'rounded-lg border border-input px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <div className="bg-card rounded-xl border p-5 max-w-2xl">
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Teléfono del cliente</label>
          <div className="flex gap-2">
            <Input className={`${input} flex-1`} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+593…" />
            <Button variant="ghost" onClick={loadQuote} type="button" className="rounded-lg border border-border px-3 text-sm hover:bg-muted/50" title="Traer lo cotizado en la conversación"><Lightbulb className="w-4 h-4" /></Button>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Nombre</label>
          <Input className={`${input} w-full`} value={name} onChange={e => setName(e.target.value)} placeholder="opcional" />
        </div>
      </div>

      <label className="text-xs font-medium text-muted-foreground">Agregar producto</label>
      <select className={`${input} w-full mb-3`} value="" onChange={e => addItem(e.target.value)}>
        <option value="" disabled>Elige un producto del catálogo…</option>
        {products.map(p => <option key={p.id} value={p.id}>{p.name} — {money(Number(p.price_sale) > 0 ? p.price_sale! : p.price)}</option>)}
      </select>

      {items.map((it, idx) => (
        <div key={idx} className="flex items-center gap-2 mb-2 text-sm">
          <span className="flex-1 truncate text-foreground">{it.product_name}</span>
          <Input type="number" min={1} max={99} value={it.quantity}
            onChange={e => setItems(prev => prev.map((x, i) => i === idx ? { ...x, quantity: Math.max(1, parseInt(e.target.value) || 1) } : x))}
            className={`${input} w-16 text-center`} />
          <span className="text-muted-foreground">× {money(it.unit_price)}</span>
          <span className="w-20 text-right font-medium">{money(cents(it.quantity * it.unit_price))}</span>
          <Button variant="ghost" onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))} className="text-red-500 px-1">✕</Button>
        </div>
      ))}

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/60">
        <span className="font-bold text-lg text-foreground">Total: {money(total)}</span>
        <Button variant="ghost"
          onClick={() => mSave.mutate()} disabled={!items.length || mSave.isPending}
          className="rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-semibold px-5 py-2 text-sm">
          {mSave.isPending ? 'Registrando…' : '✓ Registrar venta'}
        </Button>
      </div>
      {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
    </div>
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
        <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Teléfono del cliente (+593…)"
          className="flex-1 rounded-lg border border-input px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        <Button variant="ghost" className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-4 text-sm">Buscar</Button>
      </form>
      {isFetching && <p className="text-muted-foreground text-sm">Buscando…</p>}
      {searched && !isFetching && sales.length === 0 && <p className="text-muted-foreground text-sm">Sin ventas registradas para ese número.</p>}
      <div className="space-y-3">
        {sales.map(s => (
          <div key={s.id} className={`bg-white rounded-xl border p-4 ${s.status === 'anulada' ? 'border-border opacity-60' : 'border-border'}`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">{money(s.total)} {s.status === 'anulada' && <span className="text-xs font-normal text-red-500 ml-2">ANULADA</span>}</span>
              <span className="text-xs text-muted-foreground/80">{fmtDate(s.sold_at)}</span>
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              {(s.sale_items ?? s.items ?? []).map((i, idx) => <div key={idx}>{i.quantity} × {i.product_name} — {money(i.line_total)}</div>)}
            </div>
            {s.status === 'completada' && (
              <Button variant="ghost" onClick={() => { if (confirm('¿Anular esta venta? Se revierte de los reportes.')) mVoid.mutate(s.id) }}
                className="mt-2 text-xs text-destructive border border-red-200 rounded px-2 py-1 hover:bg-destructive/10">Anular venta</Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
