import { describe, expect, it } from 'vitest'
import {
  contarProductos, desdePropuesta, leerPrecio, paraEnviar, preciosQueFaltan,
} from '../src/features/clients/carta'

// ═══════════════════════════════════════════════════════════════════════════
// LA CARTA EN REVISIÓN
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Es texto de DINERO: lo que aquí se escribe es el precio que pagará el
// cliente. Un «3,50» mal leído, o un precio vacío que viajara como cero, se
// vende mal sin que nadie lo note.

// Lo que la IA propuso con la carta real de La Abuelita (2026-09-24).
const propuesta = {
  categorias: [{
    nombre: 'Menú del Día',
    productos: [{
      nombre: 'Almuerzos', precio: 3, descripcion: null, variantes: [],
      listas: [
        { titulo: 'Sopas', opciones: ['Caldo de hueso de res', 'Crema de zapallo'] },
        { titulo: 'Bebida', opciones: ['Mora', 'Naranjilla'] },
      ],
    }],
  }],
  otrosPrecios: [{ producto: 'Almuerzos', texto: 'Para llevar: $3,50' }],
}

describe('leerPrecio', () => {
  it('entiende el precio como se escribe aquí', () => {
    expect(leerPrecio('3,50')).toBe(3.5)
    expect(leerPrecio('$3.50')).toBe(3.5)
    expect(leerPrecio(' 3 ')).toBe(3)
  })

  it('lo que no es un precio positivo queda VACÍO, nunca en cero', () => {
    for (const texto of ['', 'consultar', '0', '-2', '3.505', '1.234,50']) {
      expect(leerPrecio(texto)).toBeNull()
    }
  })
})

describe('de la propuesta a lo que se envía', () => {
  it('la carta de La Abuelita llega entera y con el precio que decide el dueño', () => {
    const borrador = desdePropuesta(propuesta)
    expect(borrador.categorias[0].productos[0].precio).toBe('3.00')
    expect(borrador.otrosPrecios).toEqual(propuesta.otrosPrecios)

    // El dueño la cambia a $3.50, que es SU precio, y marca la bebida opcional.
    borrador.categorias[0].productos[0].precio = '3,50'
    borrador.categorias[0].productos[0].listas[1].obligatoria = false

    expect(paraEnviar(borrador)).toEqual({
      categorias: [{
        nombre: 'Menú del Día',
        productos: [{
          nombre: 'Almuerzos', precio: 3.5, descripcion: null, variantes: [],
          listas: [
            { titulo: 'Sopas', opciones: ['Caldo de hueso de res', 'Crema de zapallo'], obligatoria: true },
            { titulo: 'Bebida', opciones: ['Mora', 'Naranjilla'], obligatoria: false },
          ],
        }],
      }],
    })
  })

  it('las opciones se corrigen una por línea, sin líneas vacías', () => {
    const borrador = desdePropuesta(propuesta)
    borrador.categorias[0].productos[0].listas[0].opciones = 'Caldo de hueso de res\n\n  Crema de zapallo  \nSopa de quinua'
    expect(paraEnviar(borrador).categorias[0].productos[0].listas[0].opciones)
      .toEqual(['Caldo de hueso de res', 'Crema de zapallo', 'Sopa de quinua'])
  })
})

describe('lo que falta, dicho donde está', () => {
  it('señala el precio que falta del producto, o el del tamaño si los tiene', () => {
    const borrador = desdePropuesta({
      categorias: [{
        nombre: 'Pizzas',
        productos: [
          { nombre: 'Hawaiana', precio: null, descripcion: null, listas: [],
            variantes: [{ nombre: 'Personal', precio: 5.99 }, { nombre: 'Mediana', precio: null }] },
          { nombre: 'Calzone', precio: null, descripcion: null, variantes: [], listas: [] },
          { nombre: 'Pepperoni', precio: 6.5, descripcion: null, variantes: [], listas: [] },
        ],
      }],
      otrosPrecios: [],
    })
    expect(preciosQueFaltan(borrador)).toEqual(['Pizzas › Hawaiana › Mediana', 'Pizzas › Calzone'])
    expect(contarProductos(borrador)).toBe(3)
  })
})
