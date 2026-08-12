import type {
  CartLine,
  ChosenOption,
  Extra,
  Fulfillment,
  OptionGroup,
  PricingStrategy,
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
 * Lo que suma UN grupo, según cómo lo cobre el negocio.
 *
 * Es la copia en el teléfono de `server/src/services/pricing.ts`, y existe por
 * un motivo concreto: sin ella, media Suprema ($10) y media Hawaiana ($9) se
 * pintarían como $19 —el doble de una pizza— y al confirmar el pedido el
 * cliente vería $10. Enterarse del precio real al final es la peor forma de
 * enterarse.
 *
 * Las dos reglas que no son obvias, iguales que en la base:
 *   · `highest_selected` mira el precio UNITARIO: dos medias pizzas son una.
 *   · las estrategias con límite descuentan las MÁS CARAS, nunca por orden de
 *     clic, o el mismo carrito costaría distinto según cómo se armara.
 */
export function groupPrice(
  strategy: PricingStrategy,
  freeSelections: number,
  options: ChosenOption[],
): number {
  const elegidas = options.filter(opcion => (opcion.quantity || 1) > 0)
  if (!elegidas.length) return 0
  const centavos = (valor: number) => Math.round(valor * 100) / 100
  const precios = elegidas.map(opcion => opcion.price || 0)

  if (strategy === 'fixed' || strategy === 'included') return 0
  if (strategy === 'highest_selected') return centavos(Math.max(...precios))
  if (strategy === 'lowest_selected') return centavos(Math.min(...precios))
  if (strategy === 'average') {
    return centavos(precios.reduce((t, p) => t + p, 0) / precios.length)
  }

  if (strategy === 'included_up_to_limit' || strategy === 'extra_after_limit') {
    if (freeSelections <= 0) {
      return centavos(elegidas.reduce((t, o) => t + (o.price || 0) * (o.quantity || 1), 0))
    }
    const ordenadas = [...elegidas].sort((a, b) => (b.price || 0) - (a.price || 0))
    if (strategy === 'included_up_to_limit') {
      return centavos(ordenadas
        .slice(freeSelections)
        .reduce((t, o) => t + (o.price || 0) * (o.quantity || 1), 0))
    }
    // Por porciones: una opción puede quedar a medias.
    let restantes = freeSelections
    let total = 0
    for (const opcion of ordenadas) {
      const cantidad = opcion.quantity || 1
      const gratis = Math.min(restantes, cantidad)
      restantes -= gratis
      total += (opcion.price || 0) * (cantidad - gratis)
    }
    return centavos(total)
  }

  return centavos(elegidas.reduce((t, o) => t + (o.price || 0) * (o.quantity || 1), 0))
}

/**
 * Precio unitario mostrado: base (o variante), más los extras, más lo que
 * aporte cada grupo con SU estrategia. Los recargos pueden ser NEGATIVOS
 * —«sin sopa −0.50»—, así que el resultado se protege de bajar de cero: un
 * plato gratis por acumular descuentos sería un agujero, y el servidor lo
 * rechazaría igual.
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

  // Cada grupo con lo suyo: sumarlo todo a bulto sería el error de la mitad y
  // mitad. Un grupo que ya no está en el catálogo se cobra como `sum`, que es
  // lo que hacía antes.
  const porGrupo = new Map<string, ChosenOption[]>()
  for (const opcion of options) {
    porGrupo.set(opcion.groupId, [...porGrupo.get(opcion.groupId) || [], opcion])
  }
  let opciones = 0
  for (const [groupId, elegidas] of porGrupo) {
    const grupo = product.optionGroups.find(g => g.id === groupId)
    opciones += groupPrice(
      grupo?.pricingStrategy || 'sum',
      grupo?.freeSelections || 0,
      elegidas,
    )
  }

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

/**
 * ¿Este grupo admite UNA sola opción?
 *
 * No basta con mirar `selectionType`. Un grupo guardado como `multiple` con
 * `maxSelectable: 1` es funcionalmente una elección única —la base solo deja
 * elegir una—, pero se pintaba con casillas: el cliente veía checkboxes,
 * marcaba uno y no entendía por qué no podía marcar otro. Pasó de verdad con
 * los 19 sabores de pizza.
 *
 * Se decide aquí, y no en el componente, para que la FORMA del control y el
 * COMPORTAMIENTO al tocarlo salgan de la misma respuesta. Separarlos daba un
 * radio que se podía desmarcar, o una casilla que sustituía a la anterior.
 */
export const singleChoice = (group: OptionGroup): boolean =>
  group.selectionType === 'single'
  || (group.selectionType === 'multiple' && group.maxSelectable === 1)

/**
 * ¿Este grupo se pinta como píldoras en fila, en vez de lista vertical?
 *
 * «Masa: Tradicional · Delgada · Pan Pizza» ocupa una línea y se entiende de
 * un vistazo; en lista vertical gasta tres filas para decir lo mismo.
 *
 * Los topes NO son estéticos, evitan que se rompa:
 *   · Elección única — varias marcadas en fila no se distinguen bien.
 *   · Hasta 4 opciones — con 19 sabores la fila se vuelve ilegible.
 *   · Nombres cortos — «Pizza cuatro quesos artesanal» no cabe en una píldora.
 *   · Sin foto ni descripción — una píldora no tiene dónde ponerlas, y en un
 *     combo la foto es justo lo que ayuda a elegir.
 *   · Nada INCLUIDO — la píldora no tiene sitio para la palabra «Incluida», y
 *     esa palabra es lo que le dice al cliente que ya la pagó. Sin ella, la
 *     bebida del combo parece una opción más que quizá cobren. Se vio al
 *     probarlo: el grupo entraba en píldoras y la palabra desaparecía.
 */
export const pillLayout = (group: OptionGroup): boolean =>
  singleChoice(group)
  && group.options.length > 0
  && group.options.length <= 4
  && group.pricingStrategy !== 'included'
  && group.pricingStrategy !== 'included_up_to_limit'
  && group.options.every(opcion =>
    opcion.name.length <= 14 && !opcion.imageUrl && !opcion.description)

/**
 * Qué se escribe donde iría el precio de una opción.
 *
 * En un combo la bebida VIENE con el plato, y poner «$0.00» ahí se lee como un
 * error de precio en vez de como algo que ya pagaste. La palabra «Incluida» lo
 * dice sin ambigüedad, y las mejoras del mismo grupo siguen con su recargo:
 * «Pepsi 1L · Incluida» junto a «Pepsi 2L · +$1.50».
 *
 * La señal es la ESTRATEGIA del grupo, no el precio a secas: en un grupo normal
 * un «Sin borde» a cero sí debe verse como `$0.00`, porque no viene incluido en
 * nada — simplemente no añade.
 *
 * Devuelve null cuando no hay nada que escribir.
 */
export const optionPriceLabel = (
  group: OptionGroup,
  price: number,
): { incluida: true } | { incluida: false; amount: number } | null => {
  if (price !== 0) return { incluida: false, amount: price }
  const vieneIncluido = group.pricingStrategy === 'included'
    || group.pricingStrategy === 'included_up_to_limit'
  return vieneIncluido ? { incluida: true } : null
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

// ── Cómo lo recibe ─────────────────────────────────────────────────────────
//
// Se elige en DOS pantallas —la portada y el carrito— y decide dos cosas que
// el cliente ve: cuánto paga y qué datos le pedimos. Vive aquí, fuera de los
// componentes, para que las dos pantallas cuenten lo mismo y para que se pueda
// comprobar de verdad: cuando esto vivía dentro del carrito, elegir «Retiro»
// arriba y abrir el carrito lo devolvía a «Entrega» sin avisar.

/** A domicilio, que es lo que quiere casi todo el mundo. */
export const ENTREGA_POR_DEFECTO: Fulfillment = 'delivery'

/** Solo a domicilio hace falta saber a dónde. En retiro no se piden datos. */
export const needsAddress = (fulfillment: Fulfillment): boolean =>
  fulfillment === 'delivery'

/**
 * El total que se PINTA, con el envío incluido solo si se lo llevan a casa.
 *
 * Quien retira en el local no paga envío, y cobrárselo en la pantalla —aunque
 * el servidor luego no lo cobre— es prometer un número y cumplir otro. El
 * importe que manda sigue siendo el que devuelve la base al crear el pedido.
 */
export const orderTotal = (
  lines: CartLine[],
  fulfillment: Fulfillment,
  deliveryFee: number,
): number => {
  const envio = needsAddress(fulfillment) ? Math.max(0, deliveryFee || 0) : 0
  return Math.round((cartTotal(lines) + envio) * 100) / 100
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

/**
 * Lo que el cliente eligió, agrupado para PINTARLO en el carrito.
 *
 * ⚠️ Replica a propósito `services/order-detail.ts` del servidor, igual que
 * `groupPrice` replica `services/pricing.ts`. Aquí no hay servidor al que
 * preguntar: el carrito todavía no es un pedido, existe solo en este teléfono.
 * Las reglas son las mismas —grupos y opciones en orden alfabético, el x1 no se
 * dice— para que el carrito y la pantalla de seguimiento cuenten el MISMO plato
 * de la misma forma. Si divergen, el cliente cree que pidió otra cosa.
 */
export function groupChosen(
  options: ChosenOption[],
  groups: OptionGroup[] = [],
): { group: string; items: { name: string; quantity: number }[] }[] {
  const grupos = new Map<string, { name: string; quantity: number }[]>()
  for (const opcion of options) {
    const grupo = (opcion.groupName || '').trim()
    const nombre = (opcion.name || '').trim()
    // Sin grupo o sin nombre no se puede contar nada: pintar «: algo» sería
    // peor que callarlo.
    if (!grupo || !nombre) continue
    const cantidad = Math.max(1, Math.trunc(opcion.quantity || 1))
    grupos.set(grupo, [...grupos.get(grupo) || [], { name: nombre, quantity: cantidad }])
  }

  // ⚠️ El orden es el que puso EL DUEÑO, que aquí sale gratis: `groups` viene
  // del catálogo ya ordenado por su `sort`, y es el MISMO orden en que el
  // cliente acaba de armar el plato en la ficha. Ordenarlo distinto en el
  // carrito le haría releer de arriba abajo para comprobar lo que eligió.
  // El alfabético queda de desempate, para los grupos que ya no están en el
  // catálogo y para los que el dueño nunca ordenó.
  const posicion = new Map(groups.map((grupo, indice) => [grupo.name, indice]))
  const puesto = (nombre: string) => posicion.get(nombre) ?? Number.MAX_SAFE_INTEGER

  return [...grupos.entries()]
    .sort(([a], [b]) => puesto(a) - puesto(b) || a.localeCompare(b, 'es'))
    .map(([group, items]) => ({
      group,
      items: [...items].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    }))
}

/** Una línea de texto por grupo: «Sabor: Criolla, Monster». */
export const chosenLines = (
  options: ChosenOption[],
  groups: OptionGroup[] = [],
): string[] =>
  groupChosen(options, groups).map(grupo => `${grupo.group}: ${grupo.items
    .map(item => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name))
    .join(', ')}`)
