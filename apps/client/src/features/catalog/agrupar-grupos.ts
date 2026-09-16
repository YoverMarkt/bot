import type { Category, OptionGroup, Product } from './api'

/**
 * Reparte los grupos de opciones por lo que el cliente VE, y lo que no.
 *
 * ⚠️ Existe por un lío real de La Abuelita (2026-09-16). El panel listaba los
 * grupos en plano, y un almuercero con el plato armado por partes acababa con
 * DOCE grupos: cuatro llamados «Sopa» y cuatro «Segundo», distinguidos solo por
 * una línea pequeña diciendo de dónde colgaba cada uno. Cinco eran restos
 * apagados de la plantilla del alta, dos estaban vacíos, y solo cinco llegaban
 * a la app. El dueño no tenía forma de saber cuál era cuál.
 *
 * ⚠️ VISIBLE = activo Y con opciones dentro. Lo segundo no es un detalle: la
 * tienda descarta los grupos vacíos (`storefront.ts` filtra por
 * `options.length > 0`), así que un grupo obligatorio sin nada dentro no
 * bloquea el producto — simplemente no existe para el cliente. Contarlo como
 * vivo sería repetir la mentira que esto viene a arreglar.
 */
export interface SeccionDeGrupos {
  clave: string
  titulo: string
  /** Lo que se lee bajo el título: qué elegirá el cliente, o a quién afecta. */
  pie: string
  esCategoria: boolean
  grupos: OptionGroup[]
}

export interface RepartoDeGrupos {
  secciones: SeccionDeGrupos[]
  /** Apagados o sin opciones: existen, pero el cliente no los ve. */
  ocultos: OptionGroup[]
}

export function agruparGrupos(
  lista: OptionGroup[],
  cuantasOpciones: (grupoId: string) => number,
  productos: Pick<Product, 'id' | 'name' | 'category_id'>[],
  categorias: Pick<Category, 'id' | 'name'>[],
): RepartoDeGrupos {
  const visibles: OptionGroup[] = []
  const ocultos: OptionGroup[] = []
  for (const grupo of lista) {
    const vivo = grupo.active && cuantasOpciones(grupo.id) > 0
    ;(vivo ? visibles : ocultos).push(grupo)
  }

  const mapa = new Map<string, SeccionDeGrupos>()
  for (const grupo of visibles) {
    const clave = grupo.product_id
      || (grupo.category_id ? `cat:${grupo.category_id}` : 'sin-asignar')
    if (!mapa.has(clave)) {
      const producto = grupo.product_id
        ? productos.find(p => p.id === grupo.product_id)
        : undefined
      const categoria = grupo.category_id
        ? categorias.find(c => c.id === grupo.category_id)
        : undefined
      // Un grupo colgado de una categoría lo heredan TODOS sus productos.
      // Decirlo con un número responde de una vez «¿esto a quién afecta?», que
      // es la pregunta que hace que nadie se atreva a tocar esos grupos.
      const alcance = categoria
        ? productos.filter(p => p.category_id === categoria.id).length
        : 0
      mapa.set(clave, {
        clave,
        titulo: producto?.name || categoria?.name || 'Sin asignar',
        esCategoria: !!categoria,
        pie: categoria
          ? `lo heredan ${alcance} producto${alcance === 1 ? '' : 's'}`
          : producto
            ? ''
            : 'no cuelga de ningún producto ni categoría',
        grupos: [],
      })
    }
    mapa.get(clave)!.grupos.push(grupo)
  }

  // El pie de un producto es lo que su cliente va a elegir, EN ORDEN. Es la
  // línea que conecta lo que el dueño configura con lo que acaba viendo, y la
  // que faltaba: el orden de los grupos ya decidía los pasos de la ficha, pero
  // en ningún sitio se leía como pasos.
  for (const seccion of mapa.values()) {
    if (seccion.esCategoria || seccion.pie) continue
    seccion.pie = `tu cliente elige: ${seccion.grupos
      .map((grupo, i) => `${i + 1} ${grupo.name}`)
      .join(' · ')}`
  }

  return { secciones: [...mapa.values()], ocultos }
}

/**
 * Mueve un grupo dentro de su sección y devuelve el orden GLOBAL.
 *
 * ⚠️ La pantalla agrupa por producto, pero el servidor sigue recibiendo la
 * lista entera: `reorderOptionGroups` ordena todos los grupos del negocio. Así
 * que subir «Bebida» dentro de «Almuerzo del día» se traduce a intercambiar su
 * posición GLOBAL con la del hermano que tiene encima. Los demás no se mueven,
 * y el orden que cambia es exactamente el que el dueño estaba mirando.
 */
export function moverEnSeccion(
  global: OptionGroup[],
  hermanos: OptionGroup[],
  indice: number,
  direccion: -1 | 1,
): string[] {
  const actual = hermanos[indice]
  const vecino = hermanos[indice + direccion]
  // En los bordes no se mueve nada: se devuelve el orden tal cual para que
  // quien llama compare y se ahorre la petición.
  if (!actual || !vecino) return global.map(g => g.id)
  const ids = global.map(g => g.id)
  const a = ids.indexOf(actual.id)
  const b = ids.indexOf(vecino.id)
  if (a < 0 || b < 0) return ids
  ids[a] = vecino.id
  ids[b] = actual.id
  return ids
}
