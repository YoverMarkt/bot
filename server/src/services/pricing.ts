// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE PRECIOS DE LOS GRUPOS DE OPCIONES
// ═══════════════════════════════════════════════════════════════════════════
//
// Cuánto suma un grupo según cómo lo cobre el negocio. Existe porque `sum` —lo
// único que sabía hacer el motor— es incorrecto para la mitad de los casos
// reales:
//
//   Media Suprema ($10) + media Hawaiana ($9) con `sum` cuesta $19: el doble
//   de una pizza entera. Con `highest_selected` cuesta $10, que es como lo
//   cobra el negocio de verdad.
//
// ⚠️ ESTE ARCHIVO NO ES LA AUTORIDAD. El importe que se cobra lo calcula
// PostgreSQL dentro de `create_storefront_order` (regla inviolable #8). Aquí
// vive la misma lógica en TypeScript para que la app pinte lo mismo que se va
// a cobrar y para poder cotizar sin crear el pedido.
//
// Que las dos existan no es duplicar por gusto: si el navegador calculara el
// total, cualquiera compraría una pizza a $0.01 abriendo las herramientas del
// desarrollador. Y si solo lo supiera la base, el cliente elegiría a ciegas y
// vería el precio al confirmar. Por eso hay una prueba que las contrasta con
// los mismos casos.

export type PricingStrategy =
  | 'sum'
  | 'fixed'
  | 'highest_selected'
  | 'lowest_selected'
  | 'average'
  | 'included'
  | 'included_up_to_limit'
  | 'extra_after_limit'

export interface PricedSelection {
  /** Recargo unitario de la opción. Puede ser NEGATIVO: «sin sopa −0.50». */
  price: number
  /** Porciones elegidas. Siempre 1 fuera de los grupos por cantidad. */
  quantity: number
}

export interface PricedGroup {
  strategy: PricingStrategy
  /** Cuántas van sin recargo en las dos estrategias con límite. */
  freeSelections?: number
  selections: PricedSelection[]
}

const centavos = (valor: number): number => Math.round(valor * 100) / 100

/**
 * Lo que suma un grupo entero al precio del plato.
 *
 * Las decisiones que no son obvias y por qué se tomaron así:
 *
 * · **`highest_selected` mira el precio UNITARIO, no el total.** Es la mitad y
 *   mitad: dos medias pizzas son una pizza, no dos. Multiplicar por la
 *   cantidad devolvería a cobrar el doble por otra puerta.
 *
 * · **Las estrategias con límite incluyen las opciones MÁS CARAS.** «Los tres
 *   primeros toppings van incluidos» tiene que dar el mismo precio sin importar
 *   en qué orden se tocaron las casillas — si dependiera del clic, dos clientes
 *   con lo mismo en el carrito pagarían distinto. Incluir las caras es además
 *   lo que el cliente espera.
 *
 * · **`included_up_to_limit` cuenta OPCIONES; `extra_after_limit` cuenta
 *   PORCIONES.** Es la única diferencia entre las dos, y solo se nota en los
 *   grupos por cantidad: «3 sabores incluidos» no es lo mismo que «3 bolas
 *   incluidas» cuando alguien pide dos bolas del mismo sabor.
 */
export function applyPricingStrategy(group: PricedGroup): number {
  const elegidas = group.selections.filter(seleccion => seleccion.quantity > 0)
  if (!elegidas.length) return 0

  switch (group.strategy) {
    case 'fixed':
    case 'included':
      return 0

    case 'highest_selected':
      return centavos(Math.max(...elegidas.map(seleccion => seleccion.price)))

    case 'lowest_selected':
      return centavos(Math.min(...elegidas.map(seleccion => seleccion.price)))

    case 'average':
      return centavos(
        elegidas.reduce((total, seleccion) => total + seleccion.price, 0) / elegidas.length,
      )

    case 'included_up_to_limit':
      return cobrarPasadoElLimite(elegidas, group.freeSelections ?? 0, 'opciones')

    case 'extra_after_limit':
      return cobrarPasadoElLimite(elegidas, group.freeSelections ?? 0, 'porciones')

    case 'sum':
    default:
      return centavos(elegidas.reduce(
        (total, seleccion) => total + seleccion.price * seleccion.quantity,
        0,
      ))
  }
}

/**
 * Las primeras `libres` van incluidas y el resto suma su precio.
 *
 * Se descuentan siempre empezando por las más caras, y el desempate lo decide
 * el precio, nunca el orden de llegada: el mismo carrito tiene que costar lo
 * mismo aunque se arme al revés.
 */
function cobrarPasadoElLimite(
  selections: PricedSelection[],
  libres: number,
  cuenta: 'opciones' | 'porciones',
): number {
  if (libres <= 0) {
    return centavos(selections.reduce((t, s) => t + s.price * s.quantity, 0))
  }

  // De más cara a más barata: lo gratis se lo llevan las de arriba.
  const ordenadas = [...selections].sort((a, b) => b.price - a.price)

  if (cuenta === 'opciones') {
    return centavos(ordenadas
      .slice(libres)
      .reduce((total, seleccion) => total + seleccion.price * seleccion.quantity, 0))
  }

  // Por porciones: una opción puede quedar a medias —dos de sus tres bolas
  // incluidas y la tercera cobrada—, así que se va gastando el cupo.
  let restantes = libres
  let total = 0
  for (const seleccion of ordenadas) {
    const gratis = Math.min(restantes, seleccion.quantity)
    restantes -= gratis
    total += seleccion.price * (seleccion.quantity - gratis)
  }
  return centavos(total)
}

/**
 * El precio unitario de un producto ya configurado: la base, más lo que sume
 * cada grupo con SU estrategia.
 *
 * Nunca baja de cero. Los recargos negativos son reales —«sin sopa −0.50»—,
 * pero acumulados dejarían el plato regalado, y eso lo rechaza también la base.
 */
export function calculateProductPrice(input: {
  basePrice: number
  groups: PricedGroup[]
}): number {
  const opciones = input.groups.reduce(
    (total, group) => total + applyPricingStrategy(group),
    0,
  )
  return Math.max(0, centavos(input.basePrice + opciones))
}
