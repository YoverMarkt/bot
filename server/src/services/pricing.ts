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

// ═══════════════════════════════════════════════════════════════════════════
// EL PLATO POR PARTES — el almuerzo de una familia
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño de una almuercería pone UN precio al almuerzo completo y un precio
// suelto a cada parte (sopa, segundo). La familia marca cuántas porciones
// quiere de cada cosa y aquí se arman los platos:
//
//   · una porción de CADA parte es un plato completo, al precio del dueño —
//     aunque las partes sueltas sumen menos: el dueño manda;
//   · lo que sobra de una parte se cobra a su precio suelto, y si el dueño no
//     le puso precio suelto, esa parte no se vende sola;
//   · un adicional con precio va en su propia línea;
//   · lo gratis va con el plato y no suma, sin tope: el dueño sabe que cinco
//     almuerzos llevan cinco jugos.
//
// ⚠️ ESTE ARCHIVO NO ES LA AUTORIDAD. Lo mismo, línea por línea, lo hace
// `lineas_del_plato_por_partes` dentro de `create_storefront_order`, que es lo
// que cobra (regla inviolable #8). Aquí vive para cotizar y pintar, y
// `tests/plato-por-partes.test.js` y `verificar-esquema.sql` los contrastan con
// los mismos casos.
//
// ⚠️ Salen LÍNEAS y no un total, a propósito: «2 × Almuerzo a $3» y «1 × Solo
// segundo a $2.50» tienen cada una un precio unitario exacto. Así el margen de
// la plataforma se sigue calculando por línea como en cualquier otro plato, la
// comanda dice cuántos almuerzos son y el reporte los cuenta bien.

export interface MealGroup {
  id: string
  name: string
  sort: number
  /** El grupo es una PARTE del plato: una porción de cada parte forma uno. */
  isMealPart: boolean
  /** Lo que cuesta una porción de esta parte que no completa un plato. */
  loosePrice: number | null
}

export interface MealChoice {
  optionId: string
  groupId: string
  name: string
  /** El orden que el dueño le dio a la opción dentro de su grupo. */
  sort: number
  quantity: number
  price: number
}

export interface MealLine {
  name: string
  quantity: number
  unitPrice: number
  options: { optionId: string; groupId: string; name: string; quantity: number }[]
}

/**
 * El orden del dueño, y el id como desempate.
 *
 * ⚠️ El desempate es el id y no el nombre: la base ordena los uuid byte a byte,
 * que es lo mismo que comparar su texto en minúsculas, mientras que ordenar
 * nombres dependería de la intercalación de cada lado.
 */
const enOrden = (a: { sort: number; id: string }, b: { sort: number; id: string }): number =>
  a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function buildMealLines(input: {
  productName: string
  /** El precio del plato completo. */
  price: number
  /** Los grupos del producto. Las partes, solo las que tienen algo disponible. */
  groups: MealGroup[]
  choices: MealChoice[]
}): { lines: MealLine[]; error?: undefined } | { lines?: undefined; error: string } {
  const grupoDe = new Map(input.groups.map(grupo => [grupo.id, grupo]))
  const elegidas = input.choices.filter(eleccion => eleccion.quantity > 0)
  const porcionesDe = (groupId: string): number => elegidas
    .filter(eleccion => eleccion.groupId === groupId)
    .reduce((total, eleccion) => total + eleccion.quantity, 0)

  const partes = input.groups.filter(grupo => grupo.isMealPart).sort(enOrden)
  if (!partes.some(parte => porcionesDe(parte.id) > 0)) {
    return { error: `Elige qué quieres en ${input.productName}` }
  }

  // Tantos platos completos como porciones tenga la parte MÁS CORTA.
  const completos = Math.min(...partes.map(parte => porcionesDe(parte.id)))
  if (completos > 99) return { error: 'La cantidad debe estar entre 1 y 99' }

  const delCompleto: MealLine['options'] = []
  const sueltas: MealLine[] = []
  let sueltosTotal = 0

  for (const parte of partes) {
    const sobran = porcionesDe(parte.id) - completos
    if (sobran > 0 && parte.loosePrice === null) {
      return {
        error: `En ${input.productName} no se vende ${parte.name.toLocaleLowerCase('es')} `
          + 'por separado: completa el plato',
      }
    }
    if (sobran > 99) return { error: 'La cantidad debe estar entre 1 y 99' }

    // Las porciones llenan primero los platos completos siguiendo la carta del
    // dueño; las que sobran son las ÚLTIMAS. No cambia un centavo —todas las
    // porciones de una parte cuestan lo mismo sueltas—, pero así la comanda
    // sale igual se marque en el orden que se marque.
    let paraCompletar = completos
    const opcionesSueltas: MealLine['options'] = []
    const deLaParte = elegidas
      .filter(eleccion => eleccion.groupId === parte.id)
      .map(eleccion => ({ ...eleccion, id: eleccion.optionId }))
      .sort(enOrden)
    for (const eleccion of deLaParte) {
      const toma = Math.min(eleccion.quantity, paraCompletar)
      paraCompletar -= toma
      const opcion = { optionId: eleccion.optionId, groupId: eleccion.groupId, name: eleccion.name }
      if (toma > 0) delCompleto.push({ ...opcion, quantity: toma })
      if (eleccion.quantity - toma > 0) {
        opcionesSueltas.push({ ...opcion, quantity: eleccion.quantity - toma })
      }
    }

    if (sobran > 0) {
      sueltosTotal += sobran
      sueltas.push({
        name: `Solo ${parte.name.toLocaleLowerCase('es')}`,
        quantity: sobran,
        unitPrice: centavos(parte.loosePrice ?? 0),
        options: opcionesSueltas,
      })
    }
  }

  // ── Lo que acompaña: gratis con el plato, o su propia línea ─────────────
  const gratis: MealLine['options'] = []
  const conPrecio: MealLine[] = []
  const acompanantes = elegidas
    .filter(eleccion => grupoDe.get(eleccion.groupId)?.isMealPart !== true)
    .sort((a, b) => enOrden(
      { sort: grupoDe.get(a.groupId)?.sort ?? 0, id: a.groupId },
      { sort: grupoDe.get(b.groupId)?.sort ?? 0, id: b.groupId },
    ) || enOrden({ sort: a.sort, id: a.optionId }, { sort: b.sort, id: b.optionId }))

  // ── LO GRATIS VA POR PLATO ──────────────────────────────────────────────
  //
  // Un plato completo o una parte suelta llevan cada uno lo suyo: 2 almuerzos
  // y un segundo suelto son TRES platos, y caben tres jugos.
  //
  // ⚠️ Hasta el 2026-09-16 esto no lo contaba NADIE —ni aquí, ni en la app, ni
  // en la base—, así que el único tope era `max_selectable` del grupo. En un
  // local real valía 100: un almuerzo de $3.50 se llevaba cien jugos gratis.
  // Lo vio el dueño probando su propia tienda, no una prueba.
  //
  // ⚠️ Solo topa lo GRATIS. Quien quiera cinco porciones de carne las paga.
  const platos = completos + sueltosTotal
  const gratisPorGrupo = new Map<string, number>()
  for (const eleccion of acompanantes) {
    if (eleccion.price !== 0) continue
    const llevadas = (gratisPorGrupo.get(eleccion.groupId) || 0) + eleccion.quantity
    gratisPorGrupo.set(eleccion.groupId, llevadas)
    if (llevadas > platos) {
      const grupo = grupoDe.get(eleccion.groupId)?.name || eleccion.name
      return {
        error: `En ${input.productName}, ${grupo.toLocaleLowerCase('es')} va con cada plato: `
          + `llevas ${platos} y marcaste ${llevadas}`,
      }
    }
  }

  for (const eleccion of acompanantes) {
    if (eleccion.price < 0) {
      return { error: `${eleccion.name} tiene un precio no válido en ${input.productName}` }
    }
    if (eleccion.price === 0) {
      gratis.push({
        optionId: eleccion.optionId,
        groupId: eleccion.groupId,
        name: eleccion.name,
        quantity: eleccion.quantity,
      })
      continue
    }
    if (eleccion.quantity > 99) return { error: 'La cantidad debe estar entre 1 y 99' }
    conPrecio.push({
      name: eleccion.name,
      quantity: eleccion.quantity,
      unitPrice: centavos(eleccion.price),
      options: [],
    })
  }

  const lineas: MealLine[] = []
  if (completos > 0) {
    lineas.push({
      name: input.productName,
      quantity: completos,
      unitPrice: centavos(input.price),
      options: [...delCompleto, ...gratis],
    })
  } else {
    // Sin plato completo, lo gratis acompaña a lo primero que se sirve suelto.
    // Siempre hay una: hubo porciones y ninguna formó plato.
    sueltas[0]?.options.push(...gratis)
  }
  return { lines: [...lineas, ...sueltas, ...conPrecio] }
}
