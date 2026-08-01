import type { CartLine, Extra, Product, Variant } from './types'

// Carrito.
//
// ⚠️ Los importes de aquí son PARA PINTAR. El total que se cobra lo calcula el
// servidor contra su propio catálogo (regla inviolable #8): la app solo manda
// ids y cantidades. Si algún día no coinciden, manda el servidor y hay que
// arreglar el catálogo, no este archivo.

/**
 * Identidad de una línea. Dos "pizzas grandes" con extras distintos son dos
 * líneas; dos idénticas se suman en cantidad, como espera cualquiera.
 */
export const lineKey = (
  product: Product,
  variant: Variant | null,
  extras: Extra[],
  note: string,
): string => [
  product.id,
  variant?.id || '',
  extras.map(extra => extra.id).sort().join(','),
  note.trim().toLowerCase(),
].join('|')

/** Precio unitario mostrado: base (o variante) más los extras elegidos. */
export const unitPrice = (
  product: Product,
  variant: Variant | null,
  extras: Extra[],
): number => {
  const base = variant
    ? (variant.priceSale ?? variant.price)
    : (product.priceFrom ?? 0)
  const suma = extras.reduce((total, extra) => total + (extra.price || 0), 0)
  return Math.round((base + suma) * 100) / 100
}

export const lineTotal = (line: CartLine): number =>
  Math.round(line.unitPrice * line.quantity * 100) / 100

export const cartTotal = (lines: CartLine[]): number =>
  Math.round(lines.reduce((total, line) => total + lineTotal(line), 0) * 100) / 100

export const cartCount = (lines: CartLine[]): number =>
  lines.reduce((total, line) => total + line.quantity, 0)

/** Agrega respetando la identidad de la línea. Devuelve un carrito nuevo. */
export function addLine(lines: CartLine[], nueva: CartLine): CartLine[] {
  const existente = lines.find(line => line.key === nueva.key)
  if (!existente) return [...lines, nueva]
  return lines.map(line => line.key === nueva.key
    ? { ...line, quantity: Math.min(99, line.quantity + nueva.quantity) }
    : line)
}

/** Cambia la cantidad; en cero la línea desaparece. */
export function setQuantity(lines: CartLine[], key: string, quantity: number): CartLine[] {
  if (quantity <= 0) return lines.filter(line => line.key !== key)
  return lines.map(line => line.key === key ? { ...line, quantity } : line)
}

/** Agrupa los extras por su título para pintarlos en bloques. */
export function groupExtras(extras: Extra[]): { group: string; items: Extra[] }[] {
  const grupos = new Map<string, Extra[]>()
  for (const extra of extras) {
    const clave = extra.group || 'Extras'
    grupos.set(clave, [...grupos.get(clave) || [], extra])
  }
  return [...grupos.entries()].map(([group, items]) => ({ group, items }))
}
