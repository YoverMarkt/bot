import type {
  CartLine,
  ChosenOption,
  Extra,
  OptionGroup,
  Product,
  Variant,
} from './types'

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
  options: ChosenOption[] = [],
): string => [
  product.id,
  variant?.id || '',
  extras.map(extra => extra.id).sort().join(','),
  // La cantidad entra en la identidad: dos parrilladas con los mismos cortes
  // pero repartidos distinto («2 lomo + 1 pollo» vs «1 lomo + 2 pollo») son dos
  // platos distintos, y sumarlas en una sola línea perdería lo que se pidió.
  options.map(opcion => `${opcion.optionId}x${opcion.quantity}`).sort().join(','),
  note.trim().toLowerCase(),
].join('|')

/**
 * Precio unitario mostrado: base (o variante), más los extras, más las opciones
 * elegidas por su cantidad. Los recargos pueden ser NEGATIVOS —«sin sopa
 * −0.50»—, así que el resultado se protege de bajar de cero: un plato gratis
 * por acumular descuentos sería un agujero, y el servidor lo rechazaría igual.
 */
export const unitPrice = (
  product: Product,
  variant: Variant | null,
  extras: Extra[],
  options: ChosenOption[] = [],
): number => {
  const base = variant
    ? (variant.priceSale ?? variant.price)
    : (product.priceFrom ?? 0)
  const suma = extras.reduce((total, extra) => total + (extra.price || 0), 0)
  const opciones = options.reduce(
    (total, opcion) => total + (opcion.price || 0) * (opcion.quantity || 1),
    0,
  )
  return Math.max(0, Math.round((base + suma + opciones) * 100) / 100)
}

/**
 * ¿Se puede agregar ya, o falta algo obligatorio?
 *
 * Devuelve el PRIMER grupo que falta, con el texto que va en el botón. Decir
 * «Elige el término» lleva al cliente al sitio; «Completa las opciones» lo deja
 * buscando cuál de seis bloques es.
 *
 * Es la mitad visible de la regla: la otra la aplica la base al crear el pedido,
 * que es la que de verdad manda.
 */
export function missingRequirement(
  groups: OptionGroup[],
  options: ChosenOption[],
): { group: OptionGroup; message: string } | null {
  for (const group of groups) {
    if (!group.required && group.minSelectable <= 0) continue

    const elegidas = options.filter(opcion => opcion.groupId === group.id)
    // En los contadores lo que cuenta son las porciones, no cuántas casillas
    // se tocaron: una parrillada de 4 se cumple con un solo corte por 4.
    const total = group.selectionType === 'quantity'
      ? elegidas.reduce((suma, opcion) => suma + opcion.quantity, 0)
      : elegidas.length

    const minimo = Math.max(group.required ? 1 : 0, group.minSelectable)
    if (total >= minimo) continue

    return {
      group,
      message: minimo > 1
        ? `Elige ${minimo} en ${group.name}`
        : `Elige ${group.name.toLowerCase()}`,
    }
  }
  return null
}

/** Cuánto se lleva elegido de un grupo, contando porciones en los contadores. */
export function chosenCount(group: OptionGroup, options: ChosenOption[]): number {
  const elegidas = options.filter(opcion => opcion.groupId === group.id)
  return group.selectionType === 'quantity'
    ? elegidas.reduce((suma, opcion) => suma + opcion.quantity, 0)
    : elegidas.length
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
