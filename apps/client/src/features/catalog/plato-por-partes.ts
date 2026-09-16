import type {
  OptionGroup, OptionGroupPayload, ProductOption, ProductOptionPayload,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════
// EL PLATO POR PARTES, del lado del dueño
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que el dueño de una almuercería necesita para vender su almuerzo como lo
// piensa: «un almuerzo vale 3 dólares; que al pedirlo me salga qué sopa quiero
// y qué segundo». Aquí vive la lógica pura del editor —qué grupos son del plato,
// qué se manda a la API, cómo se lee un precio escrito a mano— para que se pueda
// probar sin montar la pantalla.
//
// ⚠️ No inventa un modelo nuevo: son grupos y opciones de siempre, con
// `is_meal_part` y `loose_price`. La base los cobra (`lineas_del_plato_por_partes`)
// y la mini app los pinta como la mesa de la familia.

export interface ParteDelPlato {
  grupo: OptionGroup
  opciones: ProductOption[]
}

export interface PlatoDelProducto {
  /** Las partes que forman el plato completo, en el orden del dueño. */
  partes: ParteDelPlato[]
  /** Lo que acompaña: gratis o con su precio. Nulo si todavía no hay. */
  acompanantes: ParteDelPlato | null
}

const enOrden = (a: { sort: number; name: string }, b: { sort: number; name: string }) =>
  a.sort - b.sort || a.name.localeCompare(b.name, 'es')

/**
 * El plato de UN producto, sacado de todos los grupos del negocio.
 *
 * Solo mira los grupos colgados de ESE producto: una parte no puede colgar de
 * una categoría (lo impide la base), y un grupo de categoría es otra cosa.
 */
export function platoDelProducto(
  grupos: OptionGroup[],
  opciones: ProductOption[],
  productId: string,
): PlatoDelProducto {
  const deEsteProducto = grupos.filter(grupo => grupo.product_id === productId)
  const opcionesDe = (groupId: string) => opciones
    .filter(opcion => opcion.option_group_id === groupId)
    .sort(enOrden)

  const partes = deEsteProducto
    .filter(grupo => grupo.is_meal_part)
    .sort(enOrden)
    .map(grupo => ({ grupo, opciones: opcionesDe(grupo.id) }))

  const acompanante = deEsteProducto
    .filter(grupo => !grupo.is_meal_part && grupo.selection_type === 'quantity')
    .sort(enOrden)[0]

  return {
    partes,
    acompanantes: acompanante ? { grupo: acompanante, opciones: opcionesDe(acompanante.id) } : null,
  }
}

/** Lo común a una parte y a lo que acompaña: un contador sin tope colgado del producto. */
const contadorDelProducto = (productId: string, nombre: string, sort: number) => ({
  product_id: productId,
  category_id: null,
  name: nombre.trim(),
  description: null,
  selection_type: 'quantity' as const,
  required: false,
  min_selectable: 0,
  // En una mesa no hay tope que contar: una familia de diez pide diez sopas.
  max_selectable: 100,
  max_total_quantity: null,
  pricing_strategy: 'sum' as const,
  free_selections: 0,
  option_template_id: null,
  sort,
  active: true,
})

/** Una parte nueva. Nace sin precio por separado: solo forma platos hasta que el dueño diga. */
export const grupoDeParte = (productId: string, nombre: string, sort: number): OptionGroupPayload => ({
  ...contadorDelProducto(productId, nombre, sort),
  is_meal_part: true,
  loose_price: null,
})

/** El grupo de lo que acompaña: el jugo gratis, la porción de carne con su precio. */
export const grupoDeAcompanantes = (productId: string, sort: number): OptionGroupPayload => ({
  ...contadorDelProducto(productId, 'Para acompañar', sort),
  is_meal_part: false,
  loose_price: null,
})

/** Un plato dentro de una parte, o algo que acompaña. */
export const opcionDelPlato = (
  groupId: string,
  nombre: string,
  precio: number,
  sort: number,
): ProductOptionPayload => ({
  option_group_id: groupId,
  name: nombre.trim(),
  description: null,
  image_url: null,
  image_public_id: null,
  price_adjustment: precio,
  references_product_id: null,
  default_selected: false,
  stock: 'disponible',
  sort,
  active: true,
})

/** Detrás de lo que ya hay: el orden del dueño decide cómo se lee la mesa. */
export const siguienteOrden = (items: { sort: number }[]): number =>
  items.length ? Math.min(999, Math.max(...items.map(item => item.sort)) + 1) : 0

/**
 * Un precio escrito a mano.
 *
 * ⚠️ «1,50» y «1.50» son lo mismo: en Ecuador y Colombia se escribe con coma, y
 * rechazarlo haría que el dueño creyera que el campo no funciona.
 *
 * Devuelve `null` si está vacío y `undefined` si no es un precio.
 */
export function leerPrecio(texto: string): number | null | undefined {
  const limpio = texto.trim().replace(/^\$\s*/, '').replace(',', '.')
  if (!limpio) return null
  const numero = Number(limpio)
  if (!Number.isFinite(numero) || numero < 0) return undefined
  return Math.round(numero * 100) / 100
}

/** Lo que acompaña sin precio dice «Gratis», igual que lo va a leer el cliente. */
export const etiquetaDePrecio = (valor: string | number | null): string => {
  const numero = Number(valor) || 0
  return numero > 0 ? `$${numero.toFixed(2)}` : 'Gratis'
}

/** La regla tal y como la lee el cliente arriba de la mesa. */
export function reglaDelPlato(plato: PlatoDelProducto, precio: number): string {
  if (!plato.partes.length) return ''
  const nombres = plato.partes.map(parte => parte.grupo.name).join(' + ')
  return `${nombres} = un plato completo a $${precio.toFixed(2)}`
}
