import type { CartaPropuesta, CartaRevisada } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// LA CARTA EN REVISIÓN
// ═══════════════════════════════════════════════════════════════════════════
//
// La IA propone y el superadmin corrige antes de crear el local. Aquí vive el
// borrador que se edita en pantalla y las dos conversiones: de la propuesta al
// borrador, y del borrador a lo que viaja con el alta.
//
// ⚠️ Los precios se editan como TEXTO y se convierten al enviar: un campo
// numérico no deja escribir «3,50», que es como se escribe aquí. Un precio que
// no se entiende viaja en `null` y el servidor lo devuelve para corregirlo —
// nunca se manda un cero que parecería un producto gratis.

export type VarianteEnRevision = { id: string; nombre: string; precio: string }
export type ListaEnRevision = { id: string; titulo: string; opciones: string; obligatoria: boolean }
export type ProductoEnRevision = {
  id: string
  nombre: string
  precio: string
  descripcion: string
  variantes: VarianteEnRevision[]
  listas: ListaEnRevision[]
}
export type CategoriaEnRevision = { id: string; nombre: string; productos: ProductoEnRevision[] }
export type CartaEnRevision = {
  categorias: CategoriaEnRevision[]
  otrosPrecios: CartaPropuesta['otrosPrecios']
}

let siguiente = 0
/** Clave estable para React: los nombres se editan y se pueden repetir. */
export const nuevaClave = () => `c${++siguiente}`

const precioComoTexto = (precio: number | null) => (precio === null ? '' : precio.toFixed(2))

export function desdePropuesta(propuesta: CartaPropuesta): CartaEnRevision {
  return {
    otrosPrecios: propuesta.otrosPrecios,
    categorias: propuesta.categorias.map(categoria => ({
      id: nuevaClave(),
      nombre: categoria.nombre,
      productos: categoria.productos.map(producto => ({
        id: nuevaClave(),
        nombre: producto.nombre,
        precio: precioComoTexto(producto.precio),
        descripcion: producto.descripcion || '',
        variantes: producto.variantes.map(variante => ({
          id: nuevaClave(),
          nombre: variante.nombre,
          precio: precioComoTexto(variante.precio),
        })),
        listas: producto.listas.map(lista => ({
          id: nuevaClave(),
          titulo: lista.titulo,
          // Una por línea: es como se ven impresas y como se corrigen rápido.
          opciones: lista.opciones.join('\n'),
          obligatoria: true,
        })),
      })),
    })),
  }
}

/** «3,50», «$3.50» o «3» → 3.5. Lo que no es un precio positivo → null. */
export function leerPrecio(texto: string): number | null {
  const limpio = texto.replace(/[$\s]/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null
  const precio = Number(limpio)
  return precio > 0 ? precio : null
}

export function paraEnviar(carta: CartaEnRevision): CartaRevisada {
  return {
    categorias: carta.categorias.map(categoria => ({
      nombre: categoria.nombre.trim(),
      productos: categoria.productos.map(producto => ({
        nombre: producto.nombre.trim(),
        precio: leerPrecio(producto.precio),
        descripcion: producto.descripcion.trim() || null,
        variantes: producto.variantes.map(variante => ({
          nombre: variante.nombre.trim(),
          precio: leerPrecio(variante.precio),
        })),
        listas: producto.listas.map(lista => ({
          titulo: lista.titulo.trim(),
          opciones: lista.opciones.split('\n').map(o => o.trim()).filter(Boolean),
          obligatoria: lista.obligatoria,
        })),
      })),
    })),
  }
}

/** Cuántos productos lleva la carta: es lo que se confirma al crear. */
export const contarProductos = (carta: CartaEnRevision) =>
  carta.categorias.reduce((total, categoria) => total + categoria.productos.length, 0)

/**
 * Los precios que faltan, dichos donde están. El servidor valida todo de
 * nuevo; esto solo evita un viaje para enterarse de lo que ya se ve aquí.
 */
export function preciosQueFaltan(carta: CartaEnRevision): string[] {
  return carta.categorias.flatMap(categoria => categoria.productos.flatMap((producto) => {
    const donde = `${categoria.nombre || 'Sin categoría'} › ${producto.nombre || 'sin nombre'}`
    if (producto.variantes.length) {
      return producto.variantes
        .filter(variante => leerPrecio(variante.precio) === null)
        .map(variante => `${donde} › ${variante.nombre || 'tamaño'}`)
    }
    return leerPrecio(producto.precio) === null ? [donde] : []
  }))
}
