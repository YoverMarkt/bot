// ── API de Pedidos ───────────────────────────────────────────────────────
// Un pedido LLEGA y hay que atenderlo; una venta se registra cuando ya se
// cobró. Por eso viven en secciones distintas, y este archivo es el de los
// pedidos: la bandeja de entrada del negocio.
//
// Ningún importe se calcula aquí. Subtotal, envío y total los trae el servidor
// tal como los guardó PostgreSQL (regla inviolable #8).
import { api } from '../../api/client'

export type OrderStatus =
  | 'pendiente' | 'esperando_pago' | 'pago_en_revision' | 'confirmado'
  | 'aceptado' | 'preparacion' | 'listo_para_retiro' | 'en_camino'
  | 'completado' | 'cancelado' | 'rechazado' | 'expirado'

/**
 * Estados en los que el pedido todavía pide algo del negocio.
 *
 * `pago_en_revision` entra porque es lo que MÁS pide: hay un comprobante
 * esperando a que alguien lo mire, y mientras tanto el cliente no sabe si su
 * pedido existe.
 */
export const ACTIVOS: OrderStatus[] = [
  'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado',
  'aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
]

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
  payment_method?: 'transferencia' | 'efectivo' | 'pago_al_retirar' | null
  /** Lo que el cliente escribió para ESTE pedido: «llame al llegar». */
  delivery_notes?: string | null
  payment_proof_url?: string | null
  /** Para cuándo lo quiere el cliente. Nulo = lo antes posible. */
  scheduled_for?: string | null
  created_at: string
  order_items: OrderItem[]
  /** Incrustada por el servidor desde `address_id`. */
  customer_addresses?: { label: string; address: string; reference: string | null } | null
}

export const getOrders = () => api<Order[]>('/api/client/orders')

/** Catálogo para el pedido de mostrador. Los precios son informativos: el
 *  importe oficial lo resuelve la base con los ids que se le manden. */
export const getProducts = () =>
  api<{ id: string; name: string; price: string | number; price_sale: string | number | null }[]>(
    '/api/client/products',
  )

/**
 * Pedido de mostrador: nace entregado y la base le crea su venta.
 * Se mandan ids y cantidades; ningún precio viaja desde el navegador.
 */
export const createCounterOrder = (input: {
  contact_phone?: string | null
  contact_name?: string | null
  items: { product_id: string; quantity: number }[]
}) => api<{ id: string; total: number | string }>('/api/client/orders', {
  method: 'POST',
  body: JSON.stringify(input),
})

/**
 * El comprobante ya no vive en una URL pública: es un movimiento bancario de
 * un cliente real. El servidor firma un acceso temporal —diez minutos— cada
 * vez que el dueño quiere verlo, así que se pide justo al tocar el enlace y
 * nunca se guarda en la pantalla.
 */
export const getOrderProof = (id: string) =>
  api<{ url: string; firmada: boolean }>(`/api/client/orders/${id}/proof`)

export const setOrderStatus = (id: string, status: OrderStatus) =>
  api(`/api/client/orders/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  })

export const money = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`

export const ESTADO_TEXTO: Record<OrderStatus, string> = {
  pendiente: 'Nuevo',
  esperando_pago: 'Esperando pago',
  pago_en_revision: 'Comprobante por revisar',
  confirmado: 'Confirmado',
  aceptado: 'Aceptado',
  preparacion: 'En preparación',
  listo_para_retiro: 'Listo para retirar',
  en_camino: 'En camino',
  completado: 'Entregado',
  cancelado: 'Cancelado',
  rechazado: 'Rechazado',
  expirado: 'Expirado',
}

export const ESTADO_COLOR: Record<OrderStatus, string> = {
  pendiente: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  // El comprobante por revisar va en rojo a propósito: es lo único que frena
  // un pedido esperando a que una persona lo mire.
  esperando_pago: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  pago_en_revision: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  confirmado: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  aceptado: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  preparacion: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  listo_para_retiro: 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300',
  en_camino: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300',
  completado: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  cancelado: 'bg-muted text-muted-foreground',
  rechazado: 'bg-muted text-muted-foreground',
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
  if (pedido.status === 'pendiente' || pedido.status === 'esperando_pago') return {
    status: 'confirmado',
    etiqueta: 'Aceptar pedido',
    descripcion: 'Queda aceptado y entra en la cola de preparación.',
  }
  // El comprobante ya está subido y alguien lo miró: aceptarlo confirma el
  // pedido. Rechazarlo es la otra salida, y va por el botón de cancelar.
  if (pedido.status === 'pago_en_revision') return {
    status: 'confirmado',
    etiqueta: 'Aceptar el pago',
    descripcion: 'El comprobante cuadra: el pedido queda confirmado.',
  }
  if (pedido.status === 'confirmado' || pedido.status === 'aceptado') return {
    status: 'preparacion',
    etiqueta: 'Poner en preparación',
    descripcion: 'Se marca como que ya se está preparando.',
  }
  if (pedido.status === 'preparacion' && reparte) return {
    status: 'en_camino',
    etiqueta: 'Marcar en camino',
    descripcion: 'El pedido sale a entregarse.',
  }
  // Quien retira en el local no pasa por «en camino»: pasa por «listo». Sin
  // este paso, el cliente no sabe cuándo ir a buscarlo.
  if (pedido.status === 'preparacion' && !reparte) return {
    status: 'listo_para_retiro',
    etiqueta: 'Marcar listo para retirar',
    descripcion: 'Avísale al cliente que ya puede venir a recogerlo.',
  }
  if (pedido.status === 'listo_para_retiro') return {
    status: 'completado',
    etiqueta: 'Marcar entregado',
    descripcion: 'El cliente ya lo retiró.',
  }
  if (pedido.status === 'en_camino') return {
    status: 'completado',
    etiqueta: 'Marcar entregado',
    descripcion: 'El pedido queda cerrado como entregado.',
  }
  return null
}
