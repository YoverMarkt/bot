import { describe, expect, it } from 'vitest'
import { agruparGrupos, moverEnSeccion } from '../src/features/catalog/agrupar-grupos'
import type { Category, OptionGroup, Product } from '../src/features/catalog/api'

// ═══════════════════════════════════════════════════════════════════════════
// EL PANEL DEJA DE ENSEÑAR CUATRO «SOPA» SEGUIDAS
// ═══════════════════════════════════════════════════════════════════════════
//
// Caso REAL, medido en producción el 2026-09-16. El dueño de La Abuelita:
// «en la mini app tengo 2 sopas y unos 5 segundos, pero en el panel tengo como
// 4 sopas, algunos grupos, no sé cómo se crean los segundos… ¿o soy yo el que
// no entiende?».
//
// No era él. Tenía DOCE grupos para seis productos, porque hay dos sistemas
// creando grupos en paralelo y nadie los presentó:
//   · la plantilla del alta los cuelga de la CATEGORÍA (Sopa, Segundo,
//     Guarnición, Bebida incluida en «Almuerzos»);
//   · «Armarlo por partes» los cuelga del PRODUCTO.
// Los de la plantilla se apagaron al armar el plato, pero no se borraron. Más
// dos grupos vacíos colgados de «Agua», de un toque en el producto equivocado.
//
// El panel los listaba en plano, así que cuatro tarjetas decían «Sopa».

const grupo = (p: Partial<OptionGroup> & { id: string; name: string }): OptionGroup => ({
  product_id: null, category_id: null, active: true,
  selection_type: 'single', required: true, min_selectable: 1, max_selectable: 1,
  pricing_strategy: 'included', free_selections: 0, is_meal_part: false,
  description: null, sort: 0, template_id: null, loose_price: null,
  ...p,
} as OptionGroup)

const PRODUCTOS = [
  { id: 'almuerzo', name: 'Almuerzo del día', category_id: 'cat-alm' },
  { id: 'solo-sopa', name: 'Solo sopa', category_id: 'cat-carta' },
  { id: 'solo-segundo', name: 'Solo segundo', category_id: 'cat-carta' },
  { id: 'agua', name: 'Agua', category_id: 'cat-beb' },
] as Pick<Product, 'id' | 'name' | 'category_id'>[]

const CATEGORIAS = [
  { id: 'cat-alm', name: 'Almuerzos' },
  { id: 'cat-carta', name: 'Platos a la carta' },
  { id: 'cat-beb', name: 'Bebidas' },
] as Pick<Category, 'id' | 'name'>[]

/** Los doce grupos tal como estaban en producción. */
const LOS_DOCE = [
  grupo({ id: 'g-sopa-alm', name: 'Sopa', product_id: 'almuerzo' }),
  grupo({ id: 'g-seg-alm', name: 'Segundo', product_id: 'almuerzo' }),
  grupo({ id: 'g-beb-alm', name: 'Bebida', product_id: 'almuerzo' }),
  grupo({ id: 'g-sopa-sola', name: 'Sopa', product_id: 'solo-sopa' }),
  grupo({ id: 'g-seg-solo', name: 'Segundo', product_id: 'solo-segundo' }),
  // Restos apagados de la plantilla del alta, con sus opciones dentro.
  grupo({ id: 'g-t-sopa', name: 'Sopa', category_id: 'cat-alm', active: false }),
  grupo({ id: 'g-t-seg', name: 'Segundo', category_id: 'cat-alm', active: false }),
  grupo({ id: 'g-t-guar', name: 'Guarnición', category_id: 'cat-alm', active: false }),
  grupo({ id: 'g-t-beb', name: 'Bebida incluida', category_id: 'cat-alm', active: false }),
  grupo({ id: 'g-t-acom', name: 'Acompañante', category_id: 'cat-carta', active: false }),
  // Fantasmas: activos, pero sin una sola opción dentro.
  grupo({ id: 'g-agua-sopa', name: 'Sopa', product_id: 'agua' }),
  grupo({ id: 'g-agua-seg', name: 'Segundo', product_id: 'agua' }),
]

const OPCIONES: Record<string, number> = {
  'g-sopa-alm': 2, 'g-seg-alm': 6, 'g-beb-alm': 4,
  'g-sopa-sola': 2, 'g-seg-solo': 6,
  'g-t-sopa': 3, 'g-t-seg': 4, 'g-t-guar': 5, 'g-t-beb': 4, 'g-t-acom': 5,
  'g-agua-sopa': 0, 'g-agua-seg': 0,
  // Los de los dos casos sueltos de más abajo: con opciones dentro, para que
  // lo que se prueba ahí sea el ENCABEZADO y no el filtro de vacíos.
  'g-c': 5, 'g-h': 2,
}
const cuantas = (id: string) => OPCIONES[id] ?? 0

const repartir = (lista = LOS_DOCE) =>
  agruparGrupos(lista, cuantas, PRODUCTOS, CATEGORIAS)

describe('el lío real de La Abuelita', () => {
  it('separa lo que el cliente ve de lo que no', () => {
    const { secciones, ocultos } = repartir()
    const visibles = secciones.flatMap(s => s.grupos)

    // Cinco llegaban a la app; siete no. Ese era el desajuste entero.
    expect(visibles).toHaveLength(5)
    expect(ocultos).toHaveLength(7)
  })

  it('un grupo vacío cuenta como oculto aunque esté ACTIVO', () => {
    // ⚠️ La tienda filtra los grupos sin opciones, así que un grupo obligatorio
    // y vacío no bloquea el producto: no existe para el cliente. Contarlo como
    // vivo repetiría la mentira que esto viene a arreglar.
    const { ocultos } = repartir()
    const ids = ocultos.map(g => g.id)
    expect(ids).toContain('g-agua-sopa')
    expect(ids).toContain('g-agua-seg')
  })

  it('ya no hay cuatro «Sopa» seguidas: cada una vive bajo su producto', () => {
    const { secciones } = repartir()
    const sopas = secciones.filter(s => s.grupos.some(g => g.name === 'Sopa'))

    // Siguen siendo dos grupos llamados «Sopa», pero en secciones distintas y
    // con el nombre de su producto encima. Nadie tiene que deducir cuál es cuál.
    expect(sopas.map(s => s.titulo).sort()).toEqual(['Almuerzo del día', 'Solo sopa'])
  })

  it('el producto dice lo que su cliente va a elegir, en orden', () => {
    // La línea que faltaba: el orden de los grupos YA decidía los pasos de la
    // ficha, pero en ningún sitio del panel se leía como pasos.
    const { secciones } = repartir()
    const almuerzo = secciones.find(s => s.titulo === 'Almuerzo del día')
    expect(almuerzo?.pie).toBe('tu cliente elige: 1 Sopa · 2 Segundo · 3 Bebida')
  })

  it('un grupo de categoría dice a cuántos productos afecta', () => {
    // Responde de una vez «¿esto a quién le toca?», que es la pregunta que hace
    // que nadie se atreva a tocar los grupos heredados.
    const { secciones } = repartir([
      grupo({ id: 'g-c', name: 'Acompañante', category_id: 'cat-carta' }),
    ])
    expect(secciones[0]?.esCategoria).toBe(true)
    expect(secciones[0]?.pie).toBe('lo heredan 2 productos')
  })

  it('un grupo huérfano se ve y se dice, en vez de desaparecer', () => {
    const { secciones } = repartir([grupo({ id: 'g-h', name: 'Suelto' })])
    expect(secciones[0]?.titulo).toBe('Sin asignar')
    expect(secciones[0]?.pie).toContain('no cuelga')
  })
})

describe('ordenar dentro de un producto', () => {
  // El servidor recibe SIEMPRE la lista entera. Agrupar en pantalla no puede
  // cambiar eso, ni mover de paso los grupos de otro producto.
  const global = [
    grupo({ id: 'a', name: 'Sopa', product_id: 'almuerzo' }),
    grupo({ id: 'otro', name: 'Sabor', product_id: 'pizza' }),
    grupo({ id: 'b', name: 'Segundo', product_id: 'almuerzo' }),
    grupo({ id: 'c', name: 'Bebida', product_id: 'almuerzo' }),
  ]
  const hermanos = [global[0]!, global[2]!, global[3]!]

  it('subir un grupo intercambia su sitio global con el de su hermano', () => {
    // «Segundo» sube sobre «Sopa»: se intercambian las posiciones 0 y 2. El
    // grupo de la pizza, en medio, NO se mueve.
    expect(moverEnSeccion(global, hermanos, 1, -1)).toEqual(['b', 'otro', 'a', 'c'])
  })

  it('bajar hace lo simétrico', () => {
    expect(moverEnSeccion(global, hermanos, 1, 1)).toEqual(['a', 'otro', 'c', 'b'])
  })

  it('en los bordes devuelve el orden tal cual, sin gastar una petición', () => {
    const igual = ['a', 'otro', 'b', 'c']
    expect(moverEnSeccion(global, hermanos, 0, -1)).toEqual(igual)
    expect(moverEnSeccion(global, hermanos, 2, 1)).toEqual(igual)
  })
})
