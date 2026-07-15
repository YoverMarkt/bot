export interface ParsedOrderItem {
  name: string
  qty: number
}

export interface CatalogProduct {
  id?: string
  name?: string | null
  price?: string | number | null
  price_sale?: string | number | null
  stock?: string | null
}

export interface ResolvedOrderItem {
  product: CatalogProduct
  qty: number
  unit: number
}

export interface ComputedOrderItem {
  product_id?: string
  product_name?: string | null
  quantity: number
  unit_price: number
  line_total: number
}

export interface ComputedOrder {
  items: ComputedOrderItem[]
  subtotal: number
  discount: number
  total: number
}

// Redondeo seguro a centavos; todos los totales oficiales pasan por aquí.
const money = (value: number): number => (
  Math.round((value + Number.EPSILON) * 100) / 100
)

const normalize = (value?: string | null): string => (value || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').trim()

function parseItems(payload: unknown): ParsedOrderItem[] {
  return String(payload || '')
    .split(/[;,\n]/)
    .map(value => value.trim())
    .filter(Boolean)
    .map((part) => {
      let name = part
      let quantity = 1
      const suffix = part.match(/^(.+?)\s*[xX]\s*(\d{1,2})$/)
      const prefix = part.match(/^(\d{1,2})\s*[xX]\s+(.+)$/)
      if (suffix) {
        name = (suffix[1] || '').trim()
        quantity = Number.parseInt(suffix[2] || '', 10)
      } else if (prefix) {
        quantity = Number.parseInt(prefix[1] || '', 10)
        name = (prefix[2] || '').trim()
      }
      quantity = Math.min(Math.max(quantity || 1, 1), 99)
      return { name, qty: quantity }
    })
    .filter(item => item.name.length > 1)
}

function resolveItems(
  parsed: ParsedOrderItem[],
  products: CatalogProduct[] | null | undefined,
): { resolved: ResolvedOrderItem[]; unresolved: string[] } {
  const resolved: ResolvedOrderItem[] = []
  const unresolved: string[] = []
  const active = (products || []).filter(product => product?.name)

  for (const item of parsed) {
    const query = normalize(item.name)
    let match = active.find(product => normalize(product.name) === query)
    if (!match) {
      const candidates = active.filter(product => (
        normalize(product.name).includes(query)
        || query.includes(normalize(product.name))
      ))
      if (candidates.length === 1) match = candidates[0]
    }
    if (!match) {
      unresolved.push(item.name)
      continue
    }
    if (match.stock === 'agotado') {
      unresolved.push(`${match.name} (agotado)`)
      continue
    }

    const salePrice = Number.parseFloat(String(match.price_sale))
    const unit = salePrice > 0
      ? salePrice
      : Number.parseFloat(String(match.price))
    if (!(unit > 0)) {
      unresolved.push(`${match.name} (sin precio cargado)`)
      continue
    }
    resolved.push({ product: match, qty: item.qty, unit: money(unit) })
  }
  return { resolved, unresolved }
}

function computeOrder(resolved: ResolvedOrderItem[]): ComputedOrder {
  const items = resolved.map(item => ({
    product_id: item.product.id,
    product_name: item.product.name,
    quantity: item.qty,
    unit_price: item.unit,
    line_total: money(item.unit * item.qty),
  }))
  const subtotal = money(items.reduce(
    (sum, item) => sum + item.line_total,
    0,
  ))
  const discount = 0
  return { items, subtotal, discount, total: money(subtotal - discount) }
}

function buildSummary(order: ComputedOrder): string {
  const format = (value: number) => `$${value.toFixed(2)}`
  const lines = order.items.map(item => item.quantity > 1
    ? `• ${item.quantity} x ${item.product_name} — ${format(item.unit_price)} c/u = ${format(item.line_total)}`
    : `• 1 x ${item.product_name} — ${format(item.unit_price)}`)
  let message = `🧾 *Resumen de su pedido*\n${lines.join('\n')}\n———————————\n💰 *Total: ${format(order.total)}*`
  if (order.discount > 0) {
    message += `\n(incluye descuento de ${format(order.discount)})`
  }
  message += '\n\nEl negocio coordinará con usted el pago y la entrega ✅'
  return message
}

export { buildSummary, computeOrder, money, normalize, parseItems, resolveItems }
