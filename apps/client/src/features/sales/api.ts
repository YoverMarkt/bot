// ── API de Ventas (tipada) ───────────────────────────────────────────
// Mismos endpoints que el panel viejo (routes/sales.routes.js y
// routes/orders.routes.js). El TOTAL oficial siempre lo calcula el
// servidor; lo que se muestra aquí es informativo con centavos exactos.
import { api } from '../../api/client'

export type SaleItem = {
  product_id: string | null
  product_name: string
  quantity: number
  unit_price: number
  line_total: number
}

export type Sale = {
  id: string
  contact_phone: string | null
  contact_name: string | null
  total: number | string
  status: 'completada' | 'anulada'
  sold_at: string
  sale_items?: SaleItem[]
  items?: SaleItem[]
}

// Pedido del bot (núcleo de dinero: total calculado por CÓDIGO en el server)
export type Order = {
  id: string
  contact_phone: string
  contact_name: string | null
  status: 'pendiente' | 'confirmado' | 'pagado' | 'cancelado' | 'expirado'
  subtotal: number | string
  discount: number | string
  total: number | string
  created_at: string
  order_items: SaleItem[]
}

export type QuoteData = {
  contact_name: string
  products: { id: string; name: string; price: number }[]
  suggested: SaleItem[]
}

export const getOrders = () => api<Order[]>('/api/client/orders')

export const getQuote = (phone: string) =>
  api<QuoteData>(`/api/client/sessions/${encodeURIComponent(phone)}/quote`)

export const getSalesByPhone = (phone: string) =>
  api<Sale[]>(`/api/client/sales?phone=${encodeURIComponent(phone)}`)

export const registerSale = (payload: { contact_phone: string | null; contact_name: string | null; items: Omit<SaleItem, 'line_total'>[] }) =>
  api<Sale>('/api/client/sales', { method: 'POST', body: JSON.stringify(payload) })

export const voidSale = (id: string) =>
  api(`/api/client/sales/${id}/void`, { method: 'POST' })

export const getProducts = () =>
  api<{ id: string; name: string; price: string | number; price_sale: string | number | null }[]>('/api/client/products')

// Redondeo seguro a centavos (idéntico criterio que money.js del server)
export const cents = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
export const money = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`
