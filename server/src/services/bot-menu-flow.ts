// Modo MENÚ (estilo banco): toda la conversación la conduce el CÓDIGO con
// opciones generadas desde los datos reales del negocio. La IA no participa:
// los textos son plantillas mínimas y los precios salen del catálogo. Si el
// cliente escribe algo fuera del menú, se le vuelve
// a mostrar el menú (fallo cerrado) o se deriva al equipo. Los totales los
// calcula SIEMPRE el servidor.

interface FlowBusiness {
  id: string
  name?: string | null
  takes_orders?: boolean | null
}

interface FlowProduct {
  id: string
  name?: string | null
  price?: number | string | null
  price_sale?: number | string | null
  description?: string | null
  stock?: string | null
  tags?: string[] | null
  image_url?: string | null
  video_url?: string | null
  active?: boolean | null
}

// Modificador de menú (p. ej. el SABOR de la pizza): opción que el cliente
// elige además del producto, sin cambiar el precio. Agrupado por category_tag.
interface FlowModifier {
  category_tag?: string | null
  group_label?: string | null
  name?: string | null
  description?: string | null
}

interface CartItem {
  productId: string
  name: string
  quantity: number
  priceCents: number
  // Modificador elegido (p. ej. el sabor). Viaja pegado a la línea del pedido.
  //
  // ⚠️ Es el sistema VIEJO (`menu_modifiers`): un texto suelto, colgado de la
  // categoría entera. Se conserva para los negocios que aún lo usan, pero lo
  // que se elige por `option_groups` va en `options` — estructurado, con su
  // id, y lo guarda `order_item_options`.
  modifier?: string
  /** Opciones del motor de personalización, con su id real. */
  options?: ChosenOption[]
}

/** Una opción elegida del motor: id real, para que la base la valide. */
export interface ChosenOption {
  optionId: string
  groupName: string
  name: string
  /**
   * Cuántas PORCIONES de esta opción. Solo la usan los grupos `quantity`:
   * «4 almuerzos → 3 caldos de res + 1 crema de zapallo» son dos elecciones
   * del mismo grupo con cantidad 3 y 1.
   *
   * ⚠️ Fuera de un grupo `quantity`, `create_storefront_order` RECHAZA una
   * cantidad distinta de 1 («no se elige por cantidad»), así que se omite.
   */
  quantity?: number
}

/** Un grupo de opciones tal como lo lee `getStorefrontOptionGroups`. */
export interface FlowOptionGroup {
  id: string
  product_id?: string | null
  category_id?: string | null
  name?: string | null
  selection_type?: string | null
  required?: boolean | null
  sort?: number | null
}

/** Una opción de un grupo, tal como la lee `getStorefrontOptions`. */
export interface FlowOption {
  id: string
  option_group_id?: string | null
  name?: string | null
  price_adjustment?: number | string | null
  stock?: string | null
  sort?: number | null
}

type FlowView =
  | { kind: 'main' }
  | { kind: 'categories'; intent: 'order' | 'browse'; page: number }
  // Paso de modificador (sabor): antes de elegir el producto/tamaño, cuando la
  // categoría tiene modificadores y el cliente está pidiendo.
  | { kind: 'modifier'; tag: string; page: number }
  | { kind: 'products'; intent: 'order' | 'browse'; tag: string | null; page: number }
  | { kind: 'product'; intent: 'order' | 'browse'; productId: string; tag: string | null; page: number; mediaShown?: boolean }
  // Un grupo de opciones del motor, de uno en uno. `groupIndex` dice por cuál
  // va: así el cliente contesta una pregunta por mensaje, como en el banco.
  | { kind: 'options'; productId: string; tag: string | null; groupIndex: number }
  // ── Pedido de VARIAS unidades que no tienen por qué ser iguales ────────
  // Solo aparecen cuando el producto trae grupos `quantity` (contadores).
  // La cantidad se pregunta ANTES de configurar, para poder repartirla.
  // `asking` = ya tocó «4 o más» y se espera un número escrito. Sin este
  // estado, el «4» que escribe el cliente vuelve a casar con la fila 4 de la
  // lista —que es «4 o más»— y la pregunta se repite para siempre.
  | { kind: 'units'; productId: string; tag: string | null; asking?: boolean }
  // Con 2 unidades hay un atajo que ahorra media conversación: si son
  // iguales, se configura una vez y se multiplica.
  | { kind: 'same'; productId: string; tag: string | null }
  // El reparto de un grupo: «los 4 iguales» o «combinar».
  | { kind: 'spread'; productId: string; tag: string | null; groupIndex: number }
  // Combinando: cuál opción (solo cuando el grupo tiene muchas) y cuántas.
  | { kind: 'spread-pick'; productId: string; tag: string | null; groupIndex: number }
  | { kind: 'spread-count'; productId: string; tag: string | null; groupIndex: number; optionId: string }
  | { kind: 'quantity'; productId: string }
  | { kind: 'after-add' }
  // Quitar una línea del carrito sin tener que vaciarlo entero, que era la
  // única salida y castigaba un error con perder el pedido completo.
  | { kind: 'edit-cart' }
  | { kind: 'order-confirm' }

interface FlowState {
  view: FlowView
  cart: CartItem[]
  // Modificador elegido (sabor) pendiente de adjuntar al producto/tamaño
  pendingModifier?: string
  /** Opciones ya elegidas para el producto que se está armando. */
  pendingOptions?: ChosenOption[]
  /** Cuántas unidades del producto se están armando (pedido de varios). */
  pendingUnits?: number
  /** El reparto del grupo que se está preguntando ahora mismo. */
  spread?: {
    groupId: string
    /** Porciones del grupo que faltan por asignar. */
    restante: number
    /** Por qué opción va el recorrido, cuando se pregunta una a una. */
    optionIndex: number
    elegidas: ChosenOption[]
  }
  updatedAt: number
}

type FlowAction =
  | { type: 'handoff' }
  // `payload` va en el MISMO formato que ##PEDIDO:producto x cantidad; ...##
  // para que el canal real lo procese con money.ts y las RPC atómicas de
  // siempre: el menú no crea un camino de dinero paralelo.
  // `payload` es respaldo (formato ##PEDIDO##); `items` lleva cada línea con su
  // modificador (sabor) para que money.ts calcule el precio por el producto y
  // pliegue el sabor en el nombre visible.
  | {
      type: 'order'
      summary: string
      totalCents: number
      payload: string
      // `note` es el modificador VIEJO (texto). `options` son las del motor,
      // con su id real, y son las que acaban en `order_item_options`.
      items: {
        name: string
        qty: number
        note?: string | null
        productId?: string
        options?: ChosenOption[]
      }[]
    }

// Ítems del último pedido del contacto. Solo se reutilizan producto y cantidad:
// el precio SIEMPRE se recalcula con el catálogo vigente, nunca el histórico.
export interface LastOrderItem {
  product_id?: string | null
  product_name?: string | null
  quantity?: number | null
}

export interface MenuFlowInput {
  business: FlowBusiness
  contact: string
  message: string
  products: FlowProduct[]
  // El prompt no decide precios, disponibilidad ni transiciones. Solo permite
  // respetar el nombre, tono o saludo que configuró el dueño al dar la
  // bienvenida en este flujo determinista.
  /** El saludo que escribió el dueño. Se muestra TAL CUAL. */
  welcomeMessage?: string | null
  modifiers?: FlowModifier[]
  lastOrderItems?: LastOrderItem[]
  /**
   * El motor de personalización: los mismos grupos y opciones que usa la mini
   * app. Cuando un producto tiene grupos, se preguntan DESPUÉS de elegirlo —
   * al revés que `menu_modifiers`, que preguntaba el sabor antes de saber si
   * el cliente quería un jugo o una cola, y se lo pegaba a las dos cosas.
   */
  optionGroups?: FlowOptionGroup[]
  options?: FlowOption[]
  /** La categoría de cada producto, para los grupos que cuelgan de ella. */
  productCategories?: Record<string, string | null>
}

// Una opción puede ser texto simple (las fijas del menú, ya cortas) o un
// objeto con descripción, como las filas de lista de WhatsApp: título corto
// arriba y el detalle debajo (precio, capacidad). Igual que el menú del banco.
export type MenuOption = string | { title: string; description?: string }

// Archivo de un producto que el bot envía cuando el cliente
// pide verlo. `isVideo` decide si va por sendVideo o sendImage en el canal real.
export interface FlowMediaItem {
  url: string
  isVideo: boolean
}

export interface MenuFlowResult {
  reply: string
  options: MenuOption[]
  image?: string | null
  // Fotos y videos a enviar (paso "Ver fotos y videos"): fotos primero, video
  // al final. El ejecutor los manda con sendImage/sendVideo existentes.
  media?: FlowMediaItem[]
  action?: FlowAction
  // El cliente acaba de llegar (o volvió al inicio). Lo usa el ejecutor para
  // adjuntar el enlace de la tienda, que necesita base de datos y por eso no
  // se puede armar aquí: este servicio es puro a propósito.
  isWelcome?: boolean
}

// ── Etiquetas fijas del menú (el cliente ve exactamente estos textos) ──
//
// ⚠️ MÁXIMO 20 CARACTERES, y no es una preferencia de estilo: WhatsApp RECORTA
// el título de un botón a 20 y devuelve el recorte cuando el cliente lo toca.
// Una etiqueta más larga vuelve como «💬 Hablar con el eq…», no casa con nada,
// y el cliente recibe «no te entendí» cada vez que la toca — es decir, esa
// opción se vuelve IMPOSIBLE de elegir.
//
// Pasó de verdad el 2026-08-23: seis de las diez opciones se pasaban, así que
// «Repetir mi último pedido», «Ver productos y precios», «Hablar con el
// equipo» y «Sí, empezar de nuevo» no funcionaban en absoluto.
//
// Lo vigila `opciones-que-caben.test.js`. `elegir` además tolera el recorte,
// pero eso es la red de seguridad: lo que el cliente debe leer es el texto
// entero, no uno cortado.
const OPT_ORDER = '🛒 Hacer un pedido'
const OPT_REPEAT = '🔄 Repetir pedido'
const OPT_BROWSE = '📋 Ver la carta'
const OPT_MEDIA = '📷 Fotos y videos'
const OPT_TEAM = '💬 Escribir al local'
const OPT_BACK = '⬅️ Volver'
const OPT_HOME = '🏠 Menú principal'
const OPT_MORE = '➡️ Ver más'
const OPT_ASK = '🛒 Pedirlo'
const OPT_FINISH = '✅ Finalizar pedido'
const OPT_CONFIRM = '✅ Confirmar pedido'
const OPT_EMPTY = '🗑️ Vaciar carrito'
const OPT_OTHER = '✍️ Otra cantidad'
// Pedido de varias unidades: el atajo de «iguales» y el reparto.
const OPT_SAME = '✅ Sí, iguales'
const OPT_DIFFERENT = '🍽️ Diferentes'
const OPT_MIX = '🔀 Combinar'
const OPT_MANY = '✍️ Otra cantidad'
// El carrito, como en una app de pedidos: añadir, quitar y seguir.
const OPT_ADD = '➕ Agregar algo'
const OPT_REMOVE = '✏️ Quitar algo'

const PAGE_SIZE = 6
// WhatsApp permite 10 filas por lista: 9 opciones + "Ver más" entran justas.
const CATEGORY_PAGE_SIZE = 9
// Modificadores (sabores): 8 + "Ver más" + "Volver" = 10.
const MODIFIER_PAGE_SIZE = 8
const FLOW_TTL_MS = 30 * 60 * 1000
const PROMPT_CHOOSE = 'Elige una opción del menú 👇'
const NOT_UNDERSTOOD = `🙏 No te entendí. ${PROMPT_CHOOSE}`

const normalizeText = (value: string): string => value
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{M}+/gu, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const parseQuantity = (message: string, max: number): number | null => {
  const match = normalizeText(message).match(/^(\d{1,3})\b/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null
}

// El título es la identidad de la opción: es lo que se compara y lo que viaja
// como texto. La descripción es solo presentación.
const optionTitle = (option: MenuOption): string => (
  typeof option === 'string' ? option : option.title
)

// El cliente puede tocar la opción (llega el título exacto) o escribir su
// número de lista, como en el banco ("1", "2", …)
const matchOption = (message: string, options: MenuOption[]): string | null => {
  const text = normalizeText(message)
  if (!text) return null
  const titles = options.map(optionTitle)
  const byLabel = titles.find(title => normalizeText(title) === text)
  if (byLabel) return byLabel
  if (/^\d{1,2}$/.test(text)) {
    const index = Number(text) - 1
    if (index >= 0 && index < titles.length) return titles[index]
  }
  return null
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`

const priceCentsOf = (product: FlowProduct): number | null => {
  const raw = product.price_sale ?? product.price
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
}

const capitalize = (value: string): string => value ? value.charAt(0).toUpperCase() + value.slice(1) : value

/**
 * Los grupos que aplican a ESTE producto: los suyos y los de su categoría.
 *
 * ⚠️ `single` (elegir uno) y `quantity` (contador por opción). `multiple`
 * sigue fuera: son casillas con tope, y en una lista de WhatsApp —donde cada
 * toque es un mensaje— marcar varias y luego decir «ya está» es una
 * conversación larga y confusa. Esos productos se piden en la mini app.
 *
 * ⚠️ `quantity` entró el 2026-09-07 porque es lo que hace falta para pedir
 * VARIOS de lo mismo con distinto relleno: «4 almuerzos, 3 con caldo de res y
 * 1 con crema» cabe en UNA línea de carrito, sin obligar al cliente a decir
 * qué sopa va con qué segundo (que la cocina no necesita saber). Se pregunta
 * repartiendo cantidades, nunca con un contador por opción.
 */
const gruposDelProducto = (
  input: MenuFlowInput,
  productId: string,
): FlowOptionGroup[] => {
  const categoria = input.productCategories?.[productId] ?? null
  return (input.optionGroups || [])
    .filter(grupo => (
      (grupo.selection_type === 'single' || grupo.selection_type === 'quantity')
      && (grupo.product_id === productId
        || (Boolean(grupo.category_id) && grupo.category_id === categoria))
    ))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
}

/** Un producto con un grupo OBLIGATORIO que el chat no sabe preguntar. */
const exigeLaApp = (input: MenuFlowInput, productId: string): boolean => {
  const categoria = input.productCategories?.[productId] ?? null
  return (input.optionGroups || []).some(grupo => (
    grupo.required === true
    && grupo.selection_type !== 'single'
    && grupo.selection_type !== 'quantity'
    && (grupo.product_id === productId
      || (Boolean(grupo.category_id) && grupo.category_id === categoria))
  ))
}

/**
 * ¿Este producto se puede pedir de varios con relleno distinto?
 *
 * Lo dice el catálogo, no el tipo de negocio: basta con que tenga un grupo
 * contador. Así el mismo motor sirve a un almuerzo, a un desayuno o a una
 * parrillada de cuatro cortes sin una sola línea que los nombre.
 */
const tieneContadores = (input: MenuFlowInput, productId: string): boolean =>
  gruposDelProducto(input, productId).some(g => g.selection_type === 'quantity')

const opcionesDelGrupo = (input: MenuFlowInput, groupId: string): FlowOption[] => (
  (input.options || [])
    .filter(opcion => opcion.option_group_id === groupId && opcion.stock !== 'agotado')
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
)

// ── Repartir N unidades entre las opciones de un grupo ────────────────
//
// El objetivo de todo este bloque es UNO: gastar los menos mensajes posibles.
// Cada pregunta que se ahorra es un mensaje que Meta no cobra y un toque menos
// para el cliente. De ahí las tres reglas que lo gobiernan:
//
//   1. La ÚLTIMA opción nunca se pregunta: se calcula con lo que resta.
//   2. Cuando no queda nada por repartir, el resto de preguntas se salta.
//   3. Con dos unidades se pregunta «¿iguales?» antes que nada, porque un sí
//      convierte dos configuraciones en una.

/** Con pocas opciones se pregunta una a una; con muchas, cuál y cuántas. */
const RECORRIDO_MAX = 3
/** Una lista de WhatsApp admite 10 filas y la última se la lleva «Volver». */
const SPREAD_ROWS = 9

/**
 * Todos los repartos posibles de `unidades` entre `opciones`, en una lista.
 *
 * Es el atajo bueno: «2 almuerzos diferentes» con dos sopas son exactamente
 * tres respuestas —`2 de res`, `1 y 1`, `2 de crema`— y caben en un mensaje,
 * así que preguntarlo en dos pasos es peor por todos lados. Con cuatro
 * almuerzos y dos sopas son cinco. Con seis segundos son veintiuna y NO caben:
 * de ahí que esto devuelva `null` y el flujo caiga al reparto por pasos.
 *
 * ⚠️ Se corta en cuanto se pasa del tope en vez de generarlo entero: con
 * muchas opciones y muchas unidades esto crece muy rápido, y solo hace falta
 * saber si cabe.
 */
const repartosPosibles = (
  unidades: number,
  opciones: FlowOption[],
  tope: number,
): { cantidades: number[] }[] | null => {
  const salida: { cantidades: number[] }[] = []
  const recorrer = (indice: number, resto: number, acumulado: number[]): boolean => {
    if (salida.length > tope) return false
    if (indice === opciones.length - 1) {
      salida.push({ cantidades: [...acumulado, resto] })
      return salida.length <= tope
    }
    for (let n = resto; n >= 0; n -= 1) {
      if (!recorrer(indice + 1, resto - n, [...acumulado, n])) return false
    }
    return true
  }
  if (!opciones.length) return null
  return recorrer(0, unidades, []) ? salida : null
}

/**
 * Cómo se lee un reparto en una fila: «1 Caldo de res + 1 Crema».
 *
 * ⚠️ Las opciones con 0 se OMITEN — «0 Ceviche + 2 Pollo» obliga a leer un
 * cero para descartarlo. Y el título de una fila de lista se recorta a 24
 * caracteres, así que si no cabe se devuelve `null` y ese grupo se reparte
 * por pasos: una fila cortada a la mitad no se puede elegir ni leer.
 */
const ROW_TITLE_MAX = 24
const etiquetaDeReparto = (
  cantidades: number[],
  opciones: FlowOption[],
  unidades: number,
): { title: string; description: string } | null => {
  const cortos = nombresCortos(opciones)
  const vivas = cantidades
    .map((cuantas, i) => ({ cuantas, corto: cortos[i], largo: nombreDeOpcion(opciones[i]) }))
    .filter(p => p.cuantas > 0)
  if (!vivas.length) return null
  // Todas a la misma opción: «4 × Pollo apanado» se lee mejor que «4 Pollo».
  const title = vivas.length === 1
    ? `${unidades} × ${vivas[0].corto}`
    : vivas.map(p => `${p.cuantas} ${p.corto}`).join(' + ')
  if ([...title].length > ROW_TITLE_MAX) return null
  return { title, description: vivas.map(p => `${p.cuantas} ${p.largo}`).join(' + ') }
}

const nombreDeOpcion = (opcion: FlowOption): string => String(opcion.name || '').trim()

/**
 * Un nombre CORTO y único por opción, para que quepan varias en una fila.
 *
 * El título de una fila de lista se corta a 24 caracteres, y con nombres de
 * carta reales eso no da ni para uno: «2 × Caldo de hueso de res» son 25. Sin
 * esto, el atajo de «todas las combinaciones en un mensaje» no se activaba
 * nunca y el cliente acababa en la pantalla absurda de «¿Cuántos Caldo de
 * hueso de res?» con [1] como única respuesta posible.
 *
 * Se empieza por la primera palabra y se añaden más SOLO mientras haya empate:
 * «Caldo de hueso de res»→`Caldo`, «Crema de zapallo»→`Crema`, pero «Pollo en
 * salsa…» y «Pollo apanado» crecen a `Pollo en` y `Pollo apanado` porque
 * compartían la primera. Nunca se inventa una abreviatura: siempre es un
 * prefijo del nombre real, y el nombre entero va en la descripción de la fila.
 */
const nombresCortos = (opciones: FlowOption[]): string[] => {
  const palabras = opciones.map(o => nombreDeOpcion(o).split(/\s+/).filter(Boolean))
  const cortos = palabras.map(p => p[0] || '')
  for (let intento = 1; intento < 6; intento += 1) {
    const repetidos = new Set(
      cortos.filter((corto, i) => cortos.some((otro, j) => i !== j && otro === corto)),
    )
    if (!repetidos.size) break
    for (let i = 0; i < cortos.length; i += 1) {
      if (repetidos.has(cortos[i]) && palabras[i].length > intento) {
        cortos[i] = palabras[i].slice(0, intento + 1).join(' ')
      }
    }
  }
  return cortos.map((corto, i) => corto || nombreDeOpcion(opciones[i]))
}

/** Las cantidades que se ofrecen como filas, sin pasarse del tope de la lista. */
const filasDeCantidad = (desde: number, hasta: number): MenuOption[] => {
  const filas: MenuOption[] = []
  for (let n = desde; n <= hasta && filas.length < SPREAD_ROWS; n += 1) filas.push(String(n))
  return filas
}

/** Cuántas unidades se están armando ahora mismo (1 si no hay pedido múltiple). */
const unidadesDe = (state: FlowState): number => Math.max(1, state.pendingUnits || 1)

/**
 * Guarda lo repartido y devuelve el índice del grupo siguiente.
 *
 * ⚠️ Las opciones con cantidad 0 NO se guardan: mandarlas haría que la RPC
 * contara una elección que el cliente no hizo, y el dueño vería «0× Ceviche»
 * en su comanda.
 */
const cerrarReparto = (state: FlowState): void => {
  const elegidas = (state.spread?.elegidas || []).filter(o => (o.quantity || 0) > 0)
  state.pendingOptions = [...(state.pendingOptions || []), ...elegidas]
  state.spread = undefined
}

/** Cuántas porciones lleva ya asignadas una opción del reparto en curso. */
const yaAsignadas = (state: FlowState): number =>
  (state.spread?.elegidas || []).reduce((suma, o) => suma + (o.quantity || 0), 0)

/**
 * Lo elegido, tal como el cliente tiene que poder comprobarlo.
 *
 * ⚠️ En cuanto la línea lleva más de una unidad se escriben TODAS las
 * cantidades, también los unos. Omitir el «1×» ahí daba «2× Caldo de res,
 * Crema de zapallo», que no dice cuántas cremas hay y obliga a restar de
 * cabeza — justo en el mensaje donde el cliente comprueba si se le entendió.
 * Con una sola unidad no hay nada que contar y el número sobra.
 */
const detalleDeOpciones = (opciones?: ChosenOption[], unidades = 1): string => (
  (opciones || [])
    .map(o => (unidades > 1 && o.quantity ? `${o.quantity}× ${o.name}` : o.name))
    .join(', ')
)

/**
 * El carrito tal como lo enseña una app de pedidos: cada línea con su precio,
 * lo elegido agrupado DEBAJO por su grupo, y el total al final.
 *
 * ⚠️ Antes esto solo existía en el resumen final, así que durante todo el
 * pedido el cliente no veía qué llevaba ni cuánto iba costando — tenía que
 * acordarse. En una app se ve el carrito después de cada cosa que se añade, y
 * es lo que evita el «¿pedí bien?» que acaba en una llamada al local.
 *
 * ⚠️ Agrupar por el NOMBRE del grupo («Sopa: 3× res, 1× crema») y no volcar
 * las siete elecciones seguidas: con un pedido familiar, una sola línea de
 * texto corrido es ilegible justo donde hay que comprobar el pedido.
 */
const textoDelCarrito = (state: FlowState): string => {
  const bloques = state.cart.map((item) => {
    const cabecera = `*${item.quantity} × ${item.name}* — ${money(item.priceCents * item.quantity)}`
    const porGrupo = new Map<string, ChosenOption[]>()
    for (const opcion of item.options || []) {
      const grupo = opcion.groupName || 'Opciones'
      porGrupo.set(grupo, [...(porGrupo.get(grupo) || []), opcion])
    }
    const detalles = [...porGrupo.entries()].map(([grupo, elegidas]) => (
      `   ${grupo}: ${detalleDeOpciones(elegidas, item.quantity)}`
    ))
    if (item.modifier) detalles.unshift(`   ${item.modifier}`)
    return [cabecera, ...detalles].join('\n')
  })
  const total = state.cart.reduce((suma, item) => suma + item.priceCents * item.quantity, 0)
  return `🛒 *Tu pedido*\n\n${bloques.join('\n\n')}\n\n*Total: ${money(total)}*`
}

// ── Datos derivados del negocio ───────────────────────────────────────
const activeProducts = (products: FlowProduct[]): FlowProduct[] =>
  products.filter(item => item.active !== false && String(item.name || '').trim())

// La identidad de una categoría es canónica y sin tildes/puntuación, tanto para
// el dato guardado como para la opción elegida. La etiqueta visible conserva la
// escritura original del catálogo.
const canonicalTag = (value: unknown): string => normalizeText(String(value || ''))

// Las categorías son los tags reales del catálogo; sin tags suficientes se
// listan los productos directo (nada de categorías inventadas)
const categoriesOf = (products: FlowProduct[]): string[] => {
  const seen = new Set<string>()
  const labels: string[] = []
  let untagged = 0
  for (const product of activeProducts(products)) {
    const label = String(product.tags?.[0] || '').trim().toLowerCase()
    const tag = canonicalTag(label)
    if (!tag) { untagged += 1; continue }
    if (!seen.has(tag)) { seen.add(tag); labels.push(capitalize(label)) }
  }
  if (labels.length < 2) return []
  if (untagged > 0) labels.push('Otros')
  return labels
}

const productsInCategory = (products: FlowProduct[], tag: string | null): FlowProduct[] => {
  const list = activeProducts(products)
  if (tag === null) return list
  const canonical = canonicalTag(tag)
  if (canonical === 'otros') {
    return list.filter(item => !canonicalTag(item.tags?.[0]))
  }
  return list.filter(item => canonicalTag(item.tags?.[0]) === canonical)
}

// Rearma el carrito del último pedido con el catálogo VIGENTE. Si un producto
// dejó de existir, se desactivó o se agotó, se omite y se avisa: jamás se
// reutiliza el precio viejo ni se vende algo que ya no está.
const rebuildCartFromLastOrder = (
  input: MenuFlowInput,
): { cart: CartItem[]; skipped: string[] } => {
  const cart: CartItem[] = []
  const skipped: string[] = []
  const available = activeProducts(input.products)
  for (const item of input.lastOrderItems || []) {
    const quantity = Number(item.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) continue
    const wantedName = normalizeText(String(item.product_name || ''))
    const product = available.find(candidate => (
      (item.product_id && candidate.id === item.product_id)
      || (wantedName && normalizeText(String(candidate.name || '')) === wantedName)
    ))
    const cents = product ? priceCentsOf(product) : null
    if (!product || cents === null || product.stock === 'agotado') {
      skipped.push(String(item.product_name || '').trim() || 'un producto')
      continue
    }
    cart.push({
      productId: product.id,
      name: String(product.name).trim(),
      quantity,
      priceCents: cents,
    })
  }
  return { cart, skipped }
}

// El nombre va de título (corto, es lo que se compara) y el precio/stock de
// descripción. Así entra en una fila de lista de WhatsApp y se lee mejor.
const productLabel = (product: FlowProduct): string => String(product.name).trim()

const productOption = (product: FlowProduct): MenuOption => {
  const cents = priceCentsOf(product)
  const detail = [
    cents ? money(cents) : 'precio a confirmar',
    product.stock === 'agotado' ? 'agotado' : '',
  ].filter(Boolean).join(' · ')
  return { title: productLabel(product), description: detail }
}

// ── Modificadores (sabores) ───────────────────────────────────────────
const modifierLabel = (modifier: FlowModifier): string => String(modifier.name || '').trim()

// El sabor va de título y sus ingredientes de descripción, igual que el menú.
const modifierOption = (modifier: FlowModifier): MenuOption => ({
  title: modifierLabel(modifier),
  description: String(modifier.description || '').trim(),
})

// Modificadores activos de una categoría (tag), en orden y con nombre válido.
const modifiersForTag = (input: MenuFlowInput, tag: string): FlowModifier[] =>
  (input.modifiers || []).filter(modifier => (
    modifierLabel(modifier)
    && canonicalTag(modifier.category_tag) === canonicalTag(tag)
  ))

// ── Media de un producto (foto + video) para el paso "Ver fotos y videos" ──
const isHttps = (url: unknown): url is string => typeof url === 'string' && /^https:\/\//i.test(url.trim())

// Producto: su imagen y su video del catálogo (foto primero).
const productMediaList = (product?: FlowProduct | null): FlowMediaItem[] => {
  const items: FlowMediaItem[] = []
  if (isHttps(product?.image_url)) items.push({ url: product!.image_url!.trim(), isVideo: false })
  if (isHttps(product?.video_url)) items.push({ url: product!.video_url!.trim(), isVideo: true })
  return items
}

// Título del mensaje que acompaña a la media enviada ("fotos" / "fotos y el video").
const mediaCaption = (name: string, media: FlowMediaItem[]): string => {
  const hasVideo = media.some(item => item.isVideo)
  const hasPhoto = media.some(item => !item.isVideo)
  const what = hasPhoto && hasVideo ? 'las fotos y el video' : hasVideo ? 'el video' : 'las fotos'
  return `📷 Aquí tienes ${what} de *${name.trim()}* 👇`
}

const personalizarBienvenida = (valor: string, businessName: string): string => valor
  .replace(/\{\{\s*(?:nombre_negocio|negocio)\s*\}\}/gi, businessName)
  .trim()

// La bienvenida la escribe el DUEÑO y se muestra tal cual.
//
// ⚠️ Hasta el 2026-08-21 esto MINABA el prompt de la IA con expresiones
// regulares: buscaba `saludo inicial: "..."` y, si no, la identidad declarada
// («Eres Andrea, la asistente de...») para armar un saludo con ella. Tenía
// sentido mientras el dueño escribía instrucciones para un modelo; retirada la
// IA, escribe el saludo y punto.
//
// El valor por defecto sigue existiendo porque un negocio recién creado no ha
// escrito nada, y quedarse sin saludar sería peor que saludar genérico.
const configuredWelcome = (input: MenuFlowInput): string => {
  const businessName = String(input.business.name || '').trim()
  const escrito = personalizarBienvenida(
    String(input.welcomeMessage || '').trim(), businessName,
  )
  if (escrito) return escrito

  return `¡Hola! 👋 ${businessName ? `Gracias por escribir a ${businessName}` : 'Gracias por escribirnos'} 😊`
}

// ── Menú principal por capacidades reales ─────────────────────────────
const mainOptions = (input: MenuFlowInput): string[] => {
  const options: string[] = []
  const hasProducts = activeProducts(input.products).length > 0
  if (input.business.takes_orders && hasProducts) {
    options.push(OPT_ORDER)
    // Clientes recurrentes: repetir vale más que navegar todo el catálogo
    if (input.lastOrderItems?.length) options.push(OPT_REPEAT)
  }
  if (hasProducts) options.push(OPT_BROWSE)
  options.push(OPT_TEAM)
  return options
}

/**
 * La carta del día en UN mensaje: lo que un local de almuerzos tiene escrito
 * en su cartel, y lo primero que quiere ver quien va a pedir.
 *
 * ⚠️ Sale de los datos, no de una plantilla por tipo de negocio: cada producto
 * con su precio y, debajo, las opciones de sus grupos obligatorios. Una
 * cevichería con «Ceviche» + tamaños se pinta igual de bien que una
 * almuercería, y un local con veinte productos NO pinta ninguna (no cabría, y
 * para eso está la lista paginada de siempre).
 *
 * ⚠️ Se pinta a lo sumo `CARTA_MAX_PRODUCTOS` y los grupos de UN solo producto:
 * enseñar la carta entera de un supermercado sería un muro que nadie lee, y el
 * mensaje de WhatsApp se corta a 1024 caracteres en un interactivo.
 */
const CARTA_MAX_PRODUCTOS = 6
const CARTA_MAX_OPCIONES = 8

const cartaDelDia = (input: MenuFlowInput): string => {
  const productos = activeProducts(input.products)
  if (!productos.length || productos.length > CARTA_MAX_PRODUCTOS) return ''
  const conGrupos = productos.filter(p => gruposDelProducto(input, p.id).length)
  if (!conGrupos.length) return ''

  // Los grupos del producto principal: las sopas y los segundos del día.
  const principal = conGrupos[0]
  const bloques = gruposDelProducto(input, principal.id).map((grupo) => {
    const opciones = opcionesDelGrupo(input, grupo.id)
    if (opciones.length < 2 || opciones.length > CARTA_MAX_OPCIONES) return ''
    return `*${String(grupo.name || '').trim()}*\n`
      + opciones.map(o => `· ${nombreDeOpcion(o)}`).join('\n')
  }).filter(Boolean)
  if (!bloques.length) return ''

  const precios = productos.map((producto) => {
    const cents = priceCentsOf(producto)
    return `· ${String(producto.name).trim()}${cents ? ` — ${money(cents)}` : ''}`
  })
  return `${bloques.join('\n\n')}\n\n*Precios*\n${precios.join('\n')}`
}

const welcomeReply = (input: MenuFlowInput): MenuFlowResult => {
  return {
    reply: `${configuredWelcome(input)}\n${PROMPT_CHOOSE}`,
    options: mainOptions(input),
    isWelcome: true,
  }
}

// ── Renderizado de cada vista (reply + opciones deterministas) ────────
const renderView = (view: FlowView, state: FlowState, input: MenuFlowInput): MenuFlowResult => {
  switch (view.kind) {
    case 'main':
      return { reply: `¿En qué te ayudamos? ${PROMPT_CHOOSE}`, options: mainOptions(input) }
    case 'categories': {
      // Paginadas: un negocio puede tener más de 10 categorías y la lista de
      // WhatsApp solo admite 10 filas.
      const all = categoriesOf(input.products)
      const shown = all.slice(view.page * CATEGORY_PAGE_SIZE, (view.page + 1) * CATEGORY_PAGE_SIZE)
      const hasMore = all.length > (view.page + 1) * CATEGORY_PAGE_SIZE
      return {
        reply: view.intent === 'order' ? `¿Qué te gustaría pedir? ${PROMPT_CHOOSE}` : `Estas son nuestras categorías 👇`,
        options: [
          ...shown.map(category => ({
            title: category,
            description: `${productsInCategory(input.products, normalizeText(category)).length} producto(s)`,
          })),
          ...(hasMore ? [OPT_MORE] : []),
          OPT_BACK,
        ],
      }
    }
    case 'modifier': {
      // Sabores de la categoría con sus ingredientes (título + descripción),
      // paginados. Es el primer paso al pedir: sabor → luego el tamaño.
      const mods = modifiersForTag(input, view.tag)
      const groupLabel = String(mods[0]?.group_label || 'opción').toLowerCase()
      const shown = mods.slice(view.page * MODIFIER_PAGE_SIZE, (view.page + 1) * MODIFIER_PAGE_SIZE)
      const hasMore = mods.length > (view.page + 1) * MODIFIER_PAGE_SIZE
      return {
        reply: `Elige el ${groupLabel} 👇`,
        options: [...shown.map(modifierOption), ...(hasMore ? [OPT_MORE] : []), OPT_BACK],
      }
    }
    case 'products': {
      const list = productsInCategory(input.products, view.tag)
      const page = list.slice(view.page * PAGE_SIZE, view.page * PAGE_SIZE + PAGE_SIZE)
      const hasMore = list.length > (view.page + 1) * PAGE_SIZE
      // Al pedir con sabor ya elegido, el paso siguiente es el tamaño.
      const orderPrompt = state.pendingModifier
        ? `Ahora elige el tamaño 👇`
        : `Elige el producto que deseas 👇`
      // ⚠️ La carta del día va AQUÍ y solo en la primera página del pedido: es
      // el momento en que el cliente decide, y hasta ahora tenía que elegir
      // «Almuerzo» sin saber qué sopas y qué segundos había hoy. En la
      // bienvenida sería demasiado pronto (aún no dijo que quiere pedir) y en
      // «Ver más» sería repetirla.
      const carta = view.intent === 'order' && view.page === 0 && !state.pendingModifier
        ? cartaDelDia(input)
        : ''
      return {
        reply: view.intent === 'order'
          ? `${carta ? `${carta}\n\n` : ''}${orderPrompt}`
          : `Estos son nuestros productos 👇`,
        options: [...page.map(productOption), ...(hasMore ? [OPT_MORE] : []), OPT_BACK],
      }
    }
    case 'product': {
      const product = input.products.find(item => item.id === view.productId)
      if (!product) return renderView({ kind: 'main' }, state, input)
      const cents = priceCentsOf(product)
      const lines = [
        `*${String(product.name).trim()}*`,
        product.description ? String(product.description).trim() : '',
        cents ? `Precio: ${money(cents)}` : 'Precio: lo confirma nuestro equipo',
        product.stock === 'agotado' ? 'Por ahora está agotado 😔' : '',
      ].filter(Boolean)
      const canOrder = Boolean(input.business.takes_orders) && cents !== null && product.stock !== 'agotado'
      const media = productMediaList(product)
      const canShowMedia = media.length > 0 && !view.mediaShown
      if (canShowMedia) lines.push('¿Quieres ver las fotos y videos? 👇')
      return {
        reply: lines.join('\n'),
        options: [...(canShowMedia ? [OPT_MEDIA] : []), ...(canOrder ? [OPT_ASK] : []), OPT_BACK, OPT_HOME],
      }
    }
    case 'options': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo) return renderView({ kind: 'main' }, state, input)
      const opciones = opcionesDelGrupo(input, grupo.id)
      const producto = input.products.find(item => item.id === view.productId)
      // El recargo se enseña solo cuando lo hay: «Extra queso · +$0.50». Un
      // «+$0.00» pegado a cada línea es ruido que además hace dudar.
      const filas = opciones.map((opcion) => {
        const recargo = Math.round(Number(opcion.price_adjustment || 0) * 100)
        return {
          title: String(opcion.name || '').trim(),
          ...(recargo > 0 ? { description: `+${money(recargo)}` } : {}),
        }
      })
      return {
        reply: `*${String(producto?.name || '').trim()}*\n${String(grupo.name || 'Elige una opción').trim()} 👇`,
        // Un grupo obligatorio no ofrece «Volver»: saltárselo dejaría un
        // pedido que la base va a rechazar, y el cliente no sabría por qué.
        options: [...filas, ...(grupo.required ? [] : [OPT_BACK])],
      }
    }
    case 'units': {
      if (view.asking) {
        return { reply: 'Escríbeme cuántos (solo el número) ✍️', options: [OPT_BACK] }
      }
      const product = input.products.find(item => item.id === view.productId)
      // ⚠️ Hasta SEIS, no tres. Con cuatro filas o más WhatsApp ya manda una
      // lista (los botones se acaban en tres), y una lista admite diez: poner
      // solo tres obligaba a «4 o más» + escribir el número, o sea DOS
      // mensajes de más en el pedido familiar, que es justo el que va apretado
      // contra el techo de 25 respuestas por hora.
      return {
        reply: `¿Cuántos *${String(product?.name || '').trim()}* deseas? 👇`,
        options: ['1', '2', '3', '4', '5', '6', OPT_MANY, OPT_BACK],
      }
    }
    case 'same': {
      // El atajo que más mensajes ahorra de todo el flujo: con dos unidades
      // iguales se configura UNA vez en vez de dos.
      const product = input.products.find(item => item.id === view.productId)
      const unidades = unidadesDe(state)
      return {
        reply: `${unidades} × *${String(product?.name || '').trim()}*\n¿Serán iguales? 👇`,
        options: [OPT_SAME, OPT_DIFFERENT, OPT_BACK],
      }
    }
    case 'spread': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo) return renderView({ kind: 'main' }, state, input)
      const opciones = opcionesDelGrupo(input, grupo.id)
      const unidades = unidadesDe(state)
      const etiqueta = String(grupo.name || 'Elige una opción').trim()
      // Un grupo de una sola elección (el tamaño, el término) no se reparte:
      // se pregunta una vez y vale para todas las unidades. Y con UNA unidad
      // tampoco hay nada que repartir, así que un contador se pregunta igual
      // que cualquier otra elección — que es el pedido más común de todos.
      if (grupo.selection_type !== 'quantity' || unidades === 1) {
        return {
          reply: `${etiqueta} 👇`,
          options: [
            ...opciones.map(o => ({ title: nombreDeOpcion(o) })),
            ...(grupo.required ? [] : [OPT_BACK]),
          ],
        }
      }
      // ── El atajo bueno: TODOS los repartos en un solo mensaje ──────────
      //
      // Con dos sopas y dos almuerzos son tres respuestas —«2 de res», «1 y
      // 1», «2 de crema»— y caben enteras. Preguntarlo en dos pasos daba una
      // pantalla absurda: «¿Cuántos Caldo de res?» con [1] como única opción.
      // Con seis segundos son veintiuna y no caben: ahí se reparte por pasos.
      const repartos = repartosPosibles(unidades, opciones, SPREAD_ROWS)
      const filas = repartos
        ?.map(r => etiquetaDeReparto(r.cantidades, opciones, unidades))
        .filter((x): x is { title: string; description: string } => x !== null)
      if (repartos && filas && filas.length === repartos.length) {
        return {
          reply: `${etiqueta} para ${unidades} 👇`,
          options: [...filas, OPT_BACK],
        }
      }
      return {
        reply: `${etiqueta} para ${unidades} 👇`,
        options: [
          // «4 × Caldo de hueso de res»: todas iguales de un solo toque, que
          // es lo que pide la mayoría.
          ...opciones.slice(0, SPREAD_ROWS - 1).map(o => ({
            title: `${unidades} × ${nombreDeOpcion(o)}`,
          })),
          ...(opciones.length > 1 ? [OPT_MIX] : []),
          OPT_BACK,
        ],
      }
    }
    case 'spread-pick': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      const restante = state.spread?.restante ?? 0
      const yaElegidas = new Set((state.spread?.elegidas || []).map(o => o.optionId))
      const opciones = opcionesDelGrupo(input, grupo?.id || '')
        .filter(o => !yaElegidas.has(o.id))
      return {
        reply: `${String(grupo?.name || 'Elige').trim()} — faltan ${restante} 👇`,
        options: opciones.slice(0, SPREAD_ROWS).map(o => ({ title: nombreDeOpcion(o) })),
      }
    }
    case 'spread-count': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      const opcion = opcionesDelGrupo(input, grupo?.id || '')
        .find(o => o.id === view.optionId)
      const restante = state.spread?.restante ?? 0
      const opciones = opcionesDelGrupo(input, grupo?.id || '')
      const sinAsignar = opciones.length - (state.spread?.elegidas.length ?? 0)
      // ⚠️ Con DOS opciones sin repartir y nada asignado todavía, el rango
      // empieza en 1 y acaba en restante−1: elegir 0 o el total sería «todas
      // iguales», que ya se ofreció en la pantalla anterior y volvería a
      // preguntar lo mismo. Con tres o más, 0 sí es una respuesta legítima
      // («de ceviche, ninguno»).
      const soloDos = sinAsignar === 2 && yaAsignadas(state) === 0
      return {
        reply: `¿Cuántos *${nombreDeOpcion(opcion || { id: '' })}*? 👇`,
        options: soloDos
          ? filasDeCantidad(1, Math.max(1, restante - 1))
          : filasDeCantidad(0, restante),
      }
    }
    case 'quantity': {
      const product = input.products.find(item => item.id === view.productId)
      return {
        reply: `¿Cuántas unidades de *${String(product?.name || '').trim()}* deseas? 👇`,
        options: ['1', '2', '3', OPT_OTHER, OPT_BACK],
      }
    }
    case 'after-add': {
      // ⚠️ El carrito ENTERO después de cada añadido. Hasta el 2026-09-07 aquí
      // solo se preguntaba «¿Deseas algo más?», así que el cliente recorría
      // todo el pedido sin ver qué llevaba ni cuánto iba costando y solo lo
      // descubría al final. Cuesta un mensaje más largo, no un mensaje más.
      return {
        reply: `${textoDelCarrito(state)}\n\n¿Algo más? 👇`,
        options: [
          OPT_ADD,
          OPT_FINISH,
          ...(state.cart.length ? [OPT_REMOVE] : []),
          OPT_HOME,
        ],
      }
    }
    case 'edit-cart': {
      return {
        reply: '¿Qué quieres quitar? 👇',
        options: [
          ...state.cart.slice(0, SPREAD_ROWS).map((item, i) => ({
            title: `${i + 1}. ${item.name}`,
            description: `${item.quantity} × ${money(item.priceCents)}`,
          })),
          OPT_BACK,
        ],
      }
    }
    case 'order-confirm': {
      // Lo elegido se enseña agrupado bajo su línea: el cliente tiene que
      // poder comprobar que se entendió su pedido ANTES de confirmarlo.
      return {
        reply: `${textoDelCarrito(state)}\n\n¿Lo confirmamos?`,
        options: [OPT_CONFIRM, OPT_ADD, OPT_EMPTY, OPT_HOME],
      }
    }
  }
  return { reply: `¿En qué te ayudamos? ${PROMPT_CHOOSE}`, options: mainOptions(input) }
}

// ── Estado en memoria por conversación (prototipo del simulador) ──────
const flowStates = new Map<string, FlowState>()

const stateKey = (businessId: string, contact: string): string => `${businessId}:${contact}`

const resetMenuFlow = (businessId: string, contact: string): void => {
  flowStates.delete(stateKey(businessId, contact))
}

// ── Transiciones ──────────────────────────────────────────────────────
const GLOBAL_HOME = new Set(['menu', 'menu principal', 'inicio', 'volver al menu', 'empezar'])
const GLOBAL_TEAM = new Set(['asesor', 'humano', 'una persona', 'persona', 'hablar con el equipo', 'ayuda humana'])

// Un saludo puede llegar acompañado de cortesía o de una frase adicional
// ("Hola buenas tardes", "Buenos días, quisiera información"). En modo menú
// lo recibimos como un nuevo inicio cordial, con el nombre real del negocio,
// en vez de responder "No te entendí".
const isGreeting = (text: string): boolean => (
  /^(?:hola+|holi|buen dia|buenos dias|buenas|muy buenas)(?:\s|$)/.test(text)
)

const goTo = (state: FlowState, view: FlowView, input: MenuFlowInput): MenuFlowResult => {
  state.view = view
  return renderView(view, state, input)
}

/**
 * Mete en el carrito lo que se acaba de armar y confirma qué se entendió.
 *
 * ⚠️ Sale de la vista `quantity` para poder reutilizarse desde el reparto,
 * donde la cantidad ya se preguntó al principio. Lo que hacía de paso —pegar
 * el sabor pendiente, limpiar lo pendiente y nombrar lo elegido— se conserva
 * entero: es lo que le dice al cliente que sus tres respuestas se entendieron.
 */
const agregarAlCarrito = (
  state: FlowState,
  input: MenuFlowInput,
  productId: string,
  quantity: number,
): MenuFlowResult | null => {
  const product = input.products.find(item => item.id === productId)
  const cents = product ? priceCentsOf(product) : null
  if (!product || cents === null) return null
  const modifier = state.pendingModifier
  const elegidas = state.pendingOptions || []
  state.cart.push({
    productId: product.id,
    name: String(product.name).trim(),
    quantity,
    priceCents: cents,
    ...(modifier ? { modifier } : {}),
    ...(elegidas.length ? { options: elegidas } : {}),
  })
  state.pendingModifier = undefined
  state.pendingOptions = undefined
  state.pendingUnits = undefined
  state.spread = undefined
  const added = { ...goTo(state, { kind: 'after-add' }, input) }
  const detalle = [modifier, detalleDeOpciones(elegidas, quantity)].filter(Boolean).join(' · ')
  added.reply = `Listo, agregué ${quantity}x ${String(product.name).trim()}`
    + `${detalle ? ` — ${detalle}` : ''} ✅\n${added.reply}`
  return added
}

/**
 * Entra en el grupo `groupIndex`, saltando los que no hay nada que preguntar.
 *
 * ⚠️ Un grupo de UNA sola opción se resuelve solo: la respuesta ya está dada y
 * enseñarla es un mensaje pagado que no decide nada. Es además la palanca que
 * tiene el dueño para abaratar su flujo — un almuerzo cuya bebida incluida sea
 * «Jugo del día» cuesta CERO mensajes en ese paso, mientras que ofrecer cuatro
 * sabores puede costar cinco.
 *
 * Si no quedan grupos, el producto ya está armado y va al carrito.
 */
const irAlGrupo = (
  state: FlowState,
  input: MenuFlowInput,
  view: { productId: string; tag: string | null; groupIndex: number },
): MenuFlowResult => {
  const grupos = gruposDelProducto(input, view.productId)
  let indice = view.groupIndex
  while (indice < grupos.length) {
    const grupo = grupos[indice]
    const opciones = opcionesDelGrupo(input, grupo.id)
    if (opciones.length !== 1) break
    state.pendingOptions = [...(state.pendingOptions || []), {
      optionId: opciones[0].id,
      groupName: String(grupo.name || '').trim(),
      name: nombreDeOpcion(opciones[0]),
      ...(grupo.selection_type === 'quantity' ? { quantity: unidadesDe(state) } : {}),
    }]
    indice += 1
  }
  if (indice < grupos.length) {
    return goTo(state, {
      kind: 'spread', productId: view.productId, tag: view.tag, groupIndex: indice,
    }, input)
  }
  const añadido = agregarAlCarrito(state, input, view.productId, unidadesDe(state))
  return añadido || goTo(state, { kind: 'main' }, input)
}

/** Termina el grupo actual del reparto y pasa al siguiente. */
const siguienteGrupo = (
  state: FlowState,
  input: MenuFlowInput,
  view: { productId: string; tag: string | null; groupIndex: number },
): MenuFlowResult => irAlGrupo(state, input, { ...view, groupIndex: view.groupIndex + 1 })

const advanceMenuFlow = (input: MenuFlowInput): MenuFlowResult => {
  const key = stateKey(input.business.id, input.contact)
  const now = Date.now()
  let state = flowStates.get(key)
  if (state && now - state.updatedAt > FLOW_TTL_MS) state = undefined

  // Primer contacto (o conversación vencida): bienvenida + menú principal,
  // escriba lo que escriba el cliente — igual que el banco
  if (!state) {
    state = { view: { kind: 'main' }, cart: [], updatedAt: now }
    flowStates.set(key, state)
    return welcomeReply(input)
  }
  state.updatedAt = now

  const text = normalizeText(input.message)
  const view = state.view
  const current = renderView(view, state, input)
  const choice = matchOption(input.message, current.options)

  // Una opción real siempre gana: así un producto cuyo nombre empiece por
  // "Hola" no se confunde con un saludo del cliente.
  if (!choice && isGreeting(text)) {
    state.view = { kind: 'main' }
    return welcomeReply(input)
  }
  if (GLOBAL_HOME.has(text)) return goTo(state, { kind: 'main' }, input)
  if (GLOBAL_TEAM.has(text)) {
    return { ...goTo(state, { kind: 'main' }, input), action: { type: 'handoff' }, reply: '', options: [OPT_HOME] }
  }

  // Opciones globales presentes en varias vistas
  if (choice === OPT_HOME) return goTo(state, { kind: 'main' }, input)
  if (choice === OPT_TEAM) {
    return { ...goTo(state, { kind: 'main' }, input), action: { type: 'handoff' }, reply: '', options: [OPT_HOME] }
  }

  switch (view.kind) {
    case 'main': {
      const categories = categoriesOf(input.products)
      if (choice === OPT_ORDER) {
        return goTo(state, categories.length
          ? { kind: 'categories', intent: 'order', page: 0 }
          : { kind: 'products', intent: 'order', tag: null, page: 0 }, input)
      }
      if (choice === OPT_BROWSE) {
        return goTo(state, categories.length
          ? { kind: 'categories', intent: 'browse', page: 0 }
          : { kind: 'products', intent: 'browse', tag: null, page: 0 }, input)
      }
      if (choice === OPT_REPEAT) {
        const { cart, skipped } = rebuildCartFromLastOrder(input)
        if (!cart.length) {
          return {
            reply: 'No pude rearmar tu pedido anterior porque esos productos ya no están disponibles 🙏 Arma uno nuevo:',
            options: mainOptions(input),
          }
        }
        state.cart = cart
        const summary = goTo(state, { kind: 'order-confirm' }, input)
        const note = skipped.length
          ? `\n⚠️ Ya no tenemos: ${skipped.join(', ')}. Lo quité del pedido.`
          : ''
        return {
          ...summary,
          reply: `Este es tu último pedido con los precios de hoy 👇${note}\n\n${summary.reply}`,
        }
      }
      break
    }
    case 'categories': {
      if (choice === OPT_BACK) return goTo(state, { kind: 'main' }, input)
      if (choice === OPT_MORE) return goTo(state, { ...view, page: view.page + 1 }, input)
      if (choice) {
        const tag = normalizeText(choice)
        // Al pedir, si la categoría tiene modificadores (sabores) se elige
        // primero el sabor y luego el producto/tamaño.
        if (view.intent === 'order' && modifiersForTag(input, tag).length) {
          return goTo(state, { kind: 'modifier', tag, page: 0 }, input)
        }
        return goTo(state, { kind: 'products', intent: view.intent, tag, page: 0 }, input)
      }
      break
    }
    case 'modifier': {
      if (choice === OPT_BACK) {
        state.pendingModifier = undefined
        return goTo(state, categoriesOf(input.products).length
          ? { kind: 'categories', intent: 'order', page: 0 }
          : { kind: 'main' }, input)
      }
      if (choice === OPT_MORE) return goTo(state, { ...view, page: view.page + 1 }, input)
      if (choice) {
        const modifier = modifiersForTag(input, view.tag).find(item => modifierLabel(item) === choice)
        if (modifier) {
          // Sabor elegido: se recuerda y se pasa a elegir el tamaño.
          state.pendingModifier = modifierLabel(modifier)
          return goTo(state, { kind: 'products', intent: 'order', tag: view.tag, page: 0 }, input)
        }
      }
      break
    }
    case 'products': {
      if (choice === OPT_BACK) {
        // Si veníamos de elegir sabor, "Volver" regresa a los sabores
        if (state.pendingModifier && view.tag) {
          state.pendingModifier = undefined
          return goTo(state, { kind: 'modifier', tag: view.tag, page: 0 }, input)
        }
        return goTo(state, categoriesOf(input.products).length
          ? { kind: 'categories', intent: view.intent, page: 0 }
          : { kind: 'main' }, input)
      }
      if (choice === OPT_MORE) {
        return goTo(state, { ...view, page: view.page + 1 }, input)
      }
      if (choice) {
        const list = productsInCategory(input.products, view.tag)
        const product = list.find(item => productLabel(item) === choice)
        if (product) {
          if (view.intent === 'order') {
            // Con fotos/video, o si no se puede pedir directo (agotado / sin
            // precio), se muestra el detalle para que el cliente vea qué va a
            // comprar; si no hay media, va directo a la cantidad (ruta rápida).
            if (productMediaList(product).length || product.stock === 'agotado' || priceCentsOf(product) === null) {
              return goTo(state, { kind: 'product', intent: view.intent, productId: product.id, tag: view.tag, page: view.page }, input)
            }
            // ⚠️ La ruta rápida también tiene que preguntar las opciones. Sin
            // esto, un producto sin fotos se pedía sin su sabor y el pedido
            // salía incompleto — o lo rechazaba la base si el grupo era
            // obligatorio.
            if (exigeLaApp(input, product.id)) {
              return {
                reply: 'Este producto tiene opciones que se eligen mejor en la app 📱\n'
                  + 'Escribe *MENÚ* y te paso el enlace.',
                options: [OPT_BACK, OPT_HOME],
              }
            }
            state.pendingOptions = []
            // Con contadores la cantidad se pregunta ANTES: es lo que permite
            // repartirla («3 con caldo de res, 1 con crema»).
            if (tieneContadores(input, product.id)) {
              return goTo(state, { kind: 'units', productId: product.id, tag: view.tag }, input)
            }
            if (gruposDelProducto(input, product.id).length) {
              return goTo(state, {
                kind: 'options', productId: product.id, tag: view.tag, groupIndex: 0,
              }, input)
            }
            return goTo(state, { kind: 'quantity', productId: product.id }, input)
          }
          return goTo(state, { kind: 'product', intent: view.intent, productId: product.id, tag: view.tag, page: view.page }, input)
        }
      }
      break
    }
    case 'product': {
      const product = input.products.find(item => item.id === view.productId)
      if (choice === OPT_MEDIA && product) {
        const media = productMediaList(product)
        // La lista visible elimina "Ver fotos y videos"; el estado debe guardar
        // lo mismo para que el próximo id numérico 1 sea "Pedirlo", no Media.
        const detail = goTo(state, { ...view, mediaShown: true }, input)
        return {
          reply: mediaCaption(String(product.name || 'este producto'), media),
          options: detail.options,
          media,
        }
      }
      if (choice === OPT_BACK) {
        return goTo(state, { kind: 'products', intent: view.intent, tag: view.tag, page: view.page }, input)
      }
      if (choice === OPT_ASK) {
        // ⚠️ Un producto con un grupo obligatorio que el chat no sabe
        // preguntar (casillas, contadores) no se deja pedir aquí: la base lo
        // rechazaría y el cliente se quedaría sin saber por qué.
        if (exigeLaApp(input, view.productId)) {
          return {
            reply: 'Este producto tiene opciones que se eligen mejor en la app 📱\n'
              + 'Escribe *MENÚ* y te paso el enlace.',
            options: [OPT_BACK, OPT_HOME],
          }
        }
        state.pendingOptions = []
        if (tieneContadores(input, view.productId)) {
          return goTo(state, { kind: 'units', productId: view.productId, tag: view.tag }, input)
        }
        return gruposDelProducto(input, view.productId).length
          ? goTo(state, { kind: 'options', productId: view.productId, tag: view.tag, groupIndex: 0 }, input)
          : goTo(state, { kind: 'quantity', productId: view.productId }, input)
      }
      break
    }
    case 'options': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo) return goTo(state, { kind: 'quantity', productId: view.productId }, input)
      if (choice === OPT_BACK && !grupo.required) {
        return goTo(state, {
          kind: 'product', intent: 'order', productId: view.productId,
          tag: view.tag, page: 0,
        }, input)
      }
      const elegida = opcionesDelGrupo(input, grupo.id)
        .find(opcion => String(opcion.name || '').trim() === choice)
      if (!elegida) break

      state.pendingOptions = [
        ...(state.pendingOptions || []),
        {
          optionId: elegida.id,
          groupName: String(grupo.name || '').trim(),
          name: String(elegida.name || '').trim(),
        },
      ]
      // Un grupo por mensaje: se pasa al siguiente, y al acabarlos, a la
      // cantidad. Preguntarlos todos de golpe no cabe en una lista.
      const siguiente = view.groupIndex + 1
      return siguiente < grupos.length
        ? goTo(state, { ...view, groupIndex: siguiente }, input)
        : goTo(state, { kind: 'quantity', productId: view.productId }, input)
    }
    case 'units': {
      if (choice === OPT_BACK) {
        return goTo(state, { kind: 'products', intent: 'order', tag: view.tag, page: 0 }, input)
      }
      // ⚠️ El CHOICE va primero, y aquí no es un detalle. La lista devuelve el
      // número de la fila, así que un "4" es la fila 4 —«4 o más»— y no la
      // cantidad 4. Leerlo al revés le daría 4 almuerzos a quien pidió pedir
      // más; y una vez pedido el número, hay que dejar de mirar la lista o el
      // «4» escrito vuelve a caer en «4 o más» y se pregunta en bucle.
      if (!view.asking && choice === OPT_MANY) {
        return goTo(state, { ...view, asking: true }, input)
      }
      const unidades = !view.asking && choice && /^\d$/.test(choice)
        ? Number(choice)
        : parseQuantity(input.message, 99)
      if (!unidades || unidades <= 0) break
      state.pendingUnits = unidades
      state.pendingOptions = []
      state.spread = undefined
      // Una sola unidad no tiene nada que repartir: es el flujo de siempre.
      if (unidades === 2) {
        return goTo(state, { kind: 'same', productId: view.productId, tag: view.tag }, input)
      }
      // Una sola unidad no tiene nada que repartir, pero recorre los mismos
      // grupos: `irAlGrupo` se encarga de saltar los que no preguntan nada.
      return irAlGrupo(state, input, { ...view, groupIndex: 0 })
    }
    case 'same': {
      if (choice === OPT_BACK) {
        return goTo(state, { kind: 'units', productId: view.productId, tag: view.tag }, input)
      }
      // «Iguales» configura una vez y multiplica: el reparto se salta entero
      // porque cada grupo recibe una sola opción con todas las porciones.
      if (choice === OPT_SAME || choice === OPT_DIFFERENT) {
        state.pendingOptions = []
        state.spread = undefined
        return irAlGrupo(state, input, { ...view, groupIndex: 0 })
      }
      break
    }
    case 'spread': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo) return goTo(state, { kind: 'main' }, input)
      const opciones = opcionesDelGrupo(input, grupo.id)
      const unidades = unidadesDe(state)

      if (choice === OPT_BACK && !grupo.required) {
        return goTo(state, { kind: 'units', productId: view.productId, tag: view.tag }, input)
      }

      // Grupo de una sola elección, o una sola unidad: se elige y ya.
      //
      // ⚠️ La cantidad se OMITE fuera de un contador, y no es cosmético:
      // `create_storefront_order` rechaza el pedido entero con «no se elige
      // por cantidad» si llega un número donde no toca.
      if (grupo.selection_type !== 'quantity' || unidades === 1) {
        const elegida = opciones.find(o => nombreDeOpcion(o) === choice)
        if (!elegida) break
        state.pendingOptions = [...(state.pendingOptions || []), {
          optionId: elegida.id,
          groupName: String(grupo.name || '').trim(),
          name: nombreDeOpcion(elegida),
          ...(grupo.selection_type === 'quantity' ? { quantity: 1 } : {}),
        }]
        return siguienteGrupo(state, input, view)
      }

      if (choice === OPT_MIX) {
        state.spread = {
          groupId: grupo.id, restante: unidades, optionIndex: 0, elegidas: [],
        }
        // Con pocas opciones se recorren una a una (y la última se calcula);
        // con muchas se pregunta cuál y cuántas, que evita preguntar por
        // platos que nadie quiere.
        return opciones.length <= RECORRIDO_MAX
          ? goTo(state, {
            kind: 'spread-count', productId: view.productId, tag: view.tag,
            groupIndex: view.groupIndex, optionId: opciones[0].id,
          }, input)
          : goTo(state, {
            kind: 'spread-pick', productId: view.productId, tag: view.tag,
            groupIndex: view.groupIndex,
          }, input)
      }

      // Un reparto entero de un solo toque («1 Caldo de res + 1 Crema»), que
      // es la pantalla que se ofrece cuando todas las combinaciones caben.
      const repartos = repartosPosibles(unidades, opciones, SPREAD_ROWS)
      const elegido = repartos?.find(r => (
        etiquetaDeReparto(r.cantidades, opciones, unidades)?.title === choice
      ))
      if (elegido) {
        state.pendingOptions = [
          ...(state.pendingOptions || []),
          ...elegido.cantidades
            .map((cuantas, i) => ({
              optionId: opciones[i].id,
              groupName: String(grupo.name || '').trim(),
              name: nombreDeOpcion(opciones[i]),
              quantity: cuantas,
            }))
            // Las de cantidad 0 no se guardan: el dueño vería «0× Ceviche».
            .filter(o => o.quantity > 0),
        ]
        return siguienteGrupo(state, input, view)
      }

      // «4 × Caldo de hueso de res»: todas iguales de un solo toque.
      const todas = opciones.find(o => `${unidades} × ${nombreDeOpcion(o)}` === choice)
      if (!todas) break
      state.pendingOptions = [...(state.pendingOptions || []), {
        optionId: todas.id,
        groupName: String(grupo.name || '').trim(),
        name: nombreDeOpcion(todas),
        quantity: unidades,
      }]
      return siguienteGrupo(state, input, view)
    }
    case 'spread-pick': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo || !state.spread) return goTo(state, { kind: 'main' }, input)
      const yaElegidas = new Set(state.spread.elegidas.map(o => o.optionId))
      const elegida = opcionesDelGrupo(input, grupo.id)
        .filter(o => !yaElegidas.has(o.id))
        .find(o => nombreDeOpcion(o) === choice)
      if (!elegida) break
      // ⚠️ Si solo queda UNA porción, elegir el plato ya dice la cantidad:
      // preguntar «¿cuántos?» para que la única respuesta posible sea 1 es un
      // mensaje pagado que no aporta nada.
      if (state.spread.restante === 1) {
        state.spread.elegidas.push({
          optionId: elegida.id,
          groupName: String(grupo.name || '').trim(),
          name: nombreDeOpcion(elegida),
          quantity: 1,
        })
        state.spread.restante = 0
        cerrarReparto(state)
        return siguienteGrupo(state, input, view)
      }
      return goTo(state, {
        kind: 'spread-count', productId: view.productId, tag: view.tag,
        groupIndex: view.groupIndex, optionId: elegida.id,
      }, input)
    }
    case 'spread-count': {
      const grupos = gruposDelProducto(input, view.productId)
      const grupo = grupos[view.groupIndex]
      if (!grupo || !state.spread) return goTo(state, { kind: 'main' }, input)
      const opciones = opcionesDelGrupo(input, grupo.id)
      const elegida = opciones.find(o => o.id === view.optionId)
      if (!elegida) break
      const cuantas = choice !== null && /^\d+$/.test(choice)
        ? Number(choice)
        : parseQuantity(input.message, state.spread.restante)
      if (cuantas === null || cuantas < 0 || cuantas > state.spread.restante) break

      state.spread.elegidas.push({
        optionId: elegida.id,
        groupName: String(grupo.name || '').trim(),
        name: nombreDeOpcion(elegida),
        quantity: cuantas,
      })
      state.spread.restante -= cuantas
      state.spread.optionIndex += 1

      const yaElegidas = new Set(state.spread.elegidas.map(o => o.optionId))
      const quedanOpciones = opciones.filter(o => !yaElegidas.has(o.id))

      // ── Las dos reglas que ahorran los mensajes ──────────────────────
      // 1. Si no queda nada por repartir, no se pregunta por el resto.
      // 2. Si solo queda UNA opción, se lleva todo lo que resta sin
      //    preguntarlo: la respuesta ya está determinada.
      if (state.spread.restante === 0) {
        cerrarReparto(state)
        return siguienteGrupo(state, input, view)
      }
      if (quedanOpciones.length === 1) {
        state.spread.elegidas.push({
          optionId: quedanOpciones[0].id,
          groupName: String(grupo.name || '').trim(),
          name: nombreDeOpcion(quedanOpciones[0]),
          quantity: state.spread.restante,
        })
        state.spread.restante = 0
        cerrarReparto(state)
        return siguienteGrupo(state, input, view)
      }
      // Quedan porciones y más de una opción: se sigue.
      return opciones.length <= RECORRIDO_MAX
        ? goTo(state, {
          kind: 'spread-count', productId: view.productId, tag: view.tag,
          groupIndex: view.groupIndex, optionId: quedanOpciones[0].id,
        }, input)
        : goTo(state, {
          kind: 'spread-pick', productId: view.productId, tag: view.tag,
          groupIndex: view.groupIndex,
        }, input)
    }
    case 'quantity': {
      // El número escrito manda: "4" es una cantidad, no la opción 4 de la lista
      const quantity = parseQuantity(input.message, 99)
      if (!quantity && choice === OPT_BACK) return goTo(state, { kind: 'main' }, input)
      if (!quantity && choice === OPT_OTHER) {
        return { reply: `Escríbeme la cantidad (solo el número) ✍️`, options: [OPT_BACK] }
      }
      if (quantity && quantity > 0) {
        // El sabor pendiente se pega a la línea, se limpia lo pendiente y se
        // nombra lo elegido. Vive en `agregarAlCarrito` porque el reparto
        // termina exactamente igual: dos sitios serían dos sitios donde
        // arreglar el mismo fallo.
        const añadido = agregarAlCarrito(state, input, view.productId, quantity)
        if (añadido) return añadido
      }
      break
    }
    case 'after-add': {
      if (choice === OPT_FINISH) {
        if (!state.cart.length) return goTo(state, { kind: 'main' }, input)
        return goTo(state, { kind: 'order-confirm' }, input)
      }
      if (choice === OPT_ADD) {
        // Con categorías, al submenú; sin ellas, directo a los productos.
        // Es el «➕ ¿Qué deseas agregar?» del diseño, y conserva el salto a
        // una categoría que antes colgaba suelto de esta misma pantalla.
        return goTo(state, categoriesOf(input.products).length
          ? { kind: 'categories', intent: 'order', page: 0 }
          : { kind: 'products', intent: 'order', tag: null, page: 0 }, input)
      }
      if (choice === OPT_REMOVE && state.cart.length) {
        return goTo(state, { kind: 'edit-cart' }, input)
      }
      if (choice) {
        const tag = normalizeText(choice)
        // Misma regla: si la categoría tiene sabores, se elige primero
        if (modifiersForTag(input, tag).length) {
          return goTo(state, { kind: 'modifier', tag, page: 0 }, input)
        }
        return goTo(state, { kind: 'products', intent: 'order', tag, page: 0 }, input)
      }
      break
    }
    case 'edit-cart': {
      if (choice === OPT_BACK) return goTo(state, { kind: 'after-add' }, input)
      const indice = state.cart.findIndex((item, i) => `${i + 1}. ${item.name}` === choice)
      if (indice < 0) break
      const [quitado] = state.cart.splice(indice, 1)
      // Con el carrito vacío no se enseña un carrito vacío: se vuelve al menú,
      // que es de donde se puede hacer algo.
      if (!state.cart.length) {
        const home = goTo(state, { kind: 'main' }, input)
        return { ...home, reply: `Quité *${quitado.name}* 🗑️\n${home.reply}` }
      }
      const resto = goTo(state, { kind: 'after-add' }, input)
      return { ...resto, reply: `Quité *${quitado.name}* 🗑️\n\n${resto.reply}` }
    }
    case 'order-confirm': {
      if (choice === OPT_ADD) {
        return goTo(state, categoriesOf(input.products).length
          ? { kind: 'categories', intent: 'order', page: 0 }
          : { kind: 'products', intent: 'order', tag: null, page: 0 }, input)
      }
      if (choice === OPT_CONFIRM) {
        const summaryView = renderView({ kind: 'order-confirm' }, state, input)
        const total = state.cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
        const action: FlowAction = {
          type: 'order',
          summary: summaryView.reply,
          totalCents: total,
          payload: state.cart.map(item => `${item.name} x${item.quantity}`).join('; '),
          // Cada línea con su sabor: el servidor calcula el precio por el
          // producto (tamaño) y pliega el sabor en el nombre visible.
          items: state.cart.map(item => ({
            name: item.name,
            qty: item.quantity,
            note: item.modifier || null,
            productId: item.productId,
            ...(item.options?.length ? { options: item.options } : {}),
          })),
        }
        state.cart = []
        const home = goTo(state, { kind: 'main' }, input)
        return {
          reply: `¡Pedido recibido! 🙌 Nuestro equipo te contactará para coordinar la entrega y el pago.\n${home.reply}`,
          options: home.options,
          action,
        }
      }
      if (choice === OPT_EMPTY) {
        state.cart = []
        return goTo(state, { kind: 'main' }, input)
      }
      break
    }
  }

  // Nada coincidió: fallo cerrado — se repite el menú actual, jamás se inventa
  return { reply: NOT_UNDERSTOOD, options: current.options }
}

/**
 * Igual que `advanceMenuFlow`, pero con el estado FUERA: lo carga y lo guarda
 * el llamador.
 *
 * Existe para el marketplace, donde la conversación vive en
 * `marketplace_conversations.flow_state` y tiene que sobrevivir a un
 * despliegue. El `Map` de arriba nació como «prototipo del simulador» y sigue
 * sirviendo al camino de siempre —un negocio con su propio número—, pero se
 * pierde en cada arranque y con dos instancias lleva dos cuentas del mismo
 * carrito.
 *
 * ⚠️ Presta el `Map` durante la llamada en vez de duplicar las ~230 líneas de
 * la máquina de estados. Es seguro porque `advanceMenuFlow` es **síncrona**:
 * sin un `await` en medio, Node no puede intercalar otra petición entre el
 * préstamo y la devolución, así que ninguna otra conversación llega a ver
 * este estado. Duplicar la máquina sería un segundo sitio donde arreglar cada
 * bug del menú.
 *
 * ⚠️ `updatedAt` se conserva tal cual, no se refresca: el TTL de 30 minutos
 * tiene que seguir venciendo una conversación abandonada igual que antes.
 */
const advanceMenuFlowConEstado = (
  input: MenuFlowInput,
  estadoPrevio: FlowState | null,
): { resultado: MenuFlowResult; estado: FlowState | null } => {
  const key = stateKey(input.business.id, input.contact)
  const prestado = flowStates.get(key)
  if (estadoPrevio) flowStates.set(key, estadoPrevio)
  else flowStates.delete(key)
  try {
    const resultado = advanceMenuFlow(input)
    const estado = flowStates.get(key)
    return { resultado, estado: estado ? { ...estado } : null }
  } finally {
    if (prestado) flowStates.set(key, prestado)
    else flowStates.delete(key)
  }
}

export type { FlowState }
export {
  advanceMenuFlow,
  advanceMenuFlowConEstado,
  optionTitle,
  resetMenuFlow,
}
