// ── API de Pedidos ───────────────────────────────────────────────────────
// Un pedido LLEGA y hay que atenderlo; una venta se registra cuando ya se
// cobró. Por eso viven en secciones distintas, y este archivo es el de los
// pedidos: la bandeja de entrada del negocio.
//
// Ningún importe se calcula aquí. Subtotal, envío y total los trae el servidor
// tal como los guardó PostgreSQL (regla inviolable #8).
import { api } from '../../api/client'

export type OrderStatus =
  | 'pendiente' | 'confirmado' | 'preparacion' | 'en_camino'
  | 'completado' | 'cancelado' | 'expirado'

/** Estados en los que el pedido todavía pide algo del negocio. */
export const ACTIVOS: OrderStatus[] = ['pendiente', 'confirmado', 'preparacion', 'en_camino']

export type OrderItem = {
  product_id: string | null
  product_name: string
  variant_name?: string | null
  extras_names?: string[] | null
  item_note?: string | null
  quantity: number
  unit_price: number | string
  line_total: number | string
}

export type Order = {
  id: string
  contact_phone: string
  contact_name: string | null
  status: OrderStatus
  source?: string | null
  fulfillment?: 'delivery' | 'pickup' | 'onsite' | null
  subtotal: number | string
  discount: number | string
  shipping?: number | string | null
  total: number | string
  currency?: string
  payment_method?: 'transferencia' | 'efectivo' | null
  payment_proof_url?: string | null
  created_at: string
  order_items: OrderItem[]
  /** Incrustada por el servidor desde `address_id`. */
  customer_addresses?: { label: string; address: string; reference: string | null } | null
}

export const getOrders = () => api<Order[]>('/api/client/orders')

export const setOrderStatus = (id: string, status: OrderStatus) =>
  api(`/api/client/orders/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  })

export const money = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`

export const ESTADO_TEXTO: Record<OrderStatus, string> = {
  pendiente: 'Nuevo',
  confirmado: 'Confirmado',
  preparacion: 'En preparación',
  en_camino: 'En camino',
  completado: 'Entregado',
  cancelado: 'Rechazado',
  expirado: 'Expirado',
}

export const ESTADO_COLOR: Record<OrderStatus, string> = {
  pendiente: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  confirmado: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  preparacion: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  en_camino: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300',
  completado: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  cancelado: 'bg-muted text-muted-foreground',
  expirado: 'bg-muted text-muted-foreground',
}

/**
 * El paso natural hacia adelante. Va SIEMPRE en el mismo sentido: la RPC
 * `set_order_status` rechaza cualquier retroceso, así que aquí ni se ofrece.
 *
 * «En camino» solo existe para lo que sale a la calle: un pedido que el
 * cliente retira en el local lo bloquea la base, y enseñar un botón que va a
 * fallar es peor que no enseñarlo.
 */
export const siguientePaso = (pedido: Order): {
  status: OrderStatus; etiqueta: string; descripcion: string
} | null => {
  const reparte = !pedido.fulfillment || pedido.fulfillment === 'delivery'
  if (pedido.status === 'pendiente') return {
    status: 'confirmado',
    etiqueta: 'Aceptar pedido',
    descripcion: 'Queda aceptado y entra en la cola de preparación.',
  }
  if (pedido.status === 'confirmado') return {
    status: 'preparacion',
    etiqueta: 'Poner en preparación',
    descripcion: 'Se marca como que ya se está preparando.',
  }
  if (pedido.status === 'preparacion' && reparte) return {
    status: 'en_camino',
    etiqueta: 'Marcar en camino',
    descripcion: 'El pedido sale a entregarse.',
  }
  if (pedido.status === 'en_camino') return {
    status: 'completado',
    etiqueta: 'Marcar entregado',
    descripcion: 'El pedido queda cerrado como entregado.',
  }
  return null
}
