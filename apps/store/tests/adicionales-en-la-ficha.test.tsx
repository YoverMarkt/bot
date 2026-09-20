import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ProductSheet from '../src/components/ProductSheet'
import type { Product } from '../src/lib/types'

// ═══════════════════════════════════════════════════════════════════════════
// EL `+` DE LOS ADICIONALES, PINTADO DE VERDAD
// ═══════════════════════════════════════════════════════════════════════════
//
// `cart.test.ts` comprueba las cuentas; esto comprueba que la PANTALLA las
// enseña, que es justo donde estaba el fallo: el pan de ajo entraba al carrito
// con su precio correcto y el botón seguía siendo un `+` mudo.
//
// ⚠️ Se renderiza el componente REAL con `react-dom/server`. Sin esto la
// prueba diría que la lógica funciona —y funcionaba— sobre una pantalla a la
// que el cliente le tocaba cuatro veces creyendo que no respondía. Es la
// lección de `camino-real`: verde sobre código al que nadie llega.

/** La Pizza de Monster Pizza, tal como la sirve producción. */
const pizza: Product = {
  id: 'pizza',
  name: 'Pizza',
  description: null,
  imageUrl: null,
  videoUrl: null,
  categoryId: 'c1',
  tags: [],
  available: true,
  productType: 'simple',
  priceFrom: 3.03,
  hasVariants: false,
  variants: [],
  extras: [],
  // La Pizza real se ARMA (masa, borde, sabor…), y eso importa aquí: «Precio
  // actual» solo se pinta en productos con grupos. Va uno opcional, para que
  // el pie sea el de producción sin dejar el botón bloqueado.
  optionGroups: [{
    id: 'g-borde',
    name: 'Borde',
    description: null,
    selectionType: 'single',
    pricingStrategy: 'sum',
    freeSelections: 0,
    required: false,
    minSelectable: 0,
    maxSelectable: 1,
    options: [
      { id: 'o-sin', name: 'Sin borde', description: null, imageUrl: null, price: 0, referencesProductId: null, defaultSelected: false },
      { id: 'o-queso', name: 'Borde de queso', description: null, imageUrl: null, price: 2.75, referencesProductId: null, defaultSelected: false },
    ],
  }],
  recommendations: [
    {
      section: 'Para acompañar',
      productId: 'pan',
      name: 'Pan de Ajo Cheese',
      description: '8 rebanadas de full sabor',
      imageUrl: null,
      price: 2.75,
    },
  ],
}

/**
 * Solo el bloque «Para acompañar».
 *
 * ⚠️ Hace falta acotar: la ficha tiene OTRO contador abajo —el de cuántas
 * pizzas— y buscar «Quitar uno» en la página entera lo encontraba siempre,
 * con lo que la prueba pasaba sin comprobar nada.
 */
const bloqueDeAdicionales = (html: string): string => {
  const desde = html.indexOf('Para acompañar')
  const hasta = html.indexOf('</section>', desde)
  expect(desde).toBeGreaterThan(-1)
  return html.slice(desde, hasta)
}

const pintar = (puedePedir = true, seArma = false): string =>
  renderToStaticMarkup(
    <ProductSheet
      product={pizza}
      abierto
      onCerrar={() => {}}
      onAgregar={() => {}}
      onAgregarSuelto={() => {}}
      onAgregarAdicionales={() => {}}
      seArmaElAdicional={() => seArma}
      puedePedir={puedePedir}
    />,
  )

/** Solo el pie: donde vive el total de lo que se va a agregar. */
const pieDeLaFicha = (html: string): string =>
  html.slice(html.lastIndexOf('sticky bottom-0'))

describe('el adicional en la ficha de otro plato', () => {
  it('se enseña con su nombre, su descripción y su precio', () => {
    const bloque = bloqueDeAdicionales(pintar())
    expect(bloque).toContain('Pan de Ajo Cheese')
    expect(bloque).toContain('8 rebanadas de full sabor')
    expect(bloque).toContain('$2.75')
  })

  it('sin marcar nada, el control es un «+»', () => {
    const bloque = bloqueDeAdicionales(pintar())
    expect(bloque).toContain('Agregar Pan de Ajo Cheese')
    expect(bloque).not.toContain('Quitar uno')
  })

  it('el nombre y el precio no compiten por el mismo ancho', () => {
    // Con nombre, precio y contador en fila, producción enseñaba «Pan de Ajo …»
    // y «Nachos Sup…». El precio pasó a ir DEBAJO del nombre.
    const bloque = bloqueDeAdicionales(pintar())
    const nombre = bloque.indexOf('Pan de Ajo Cheese')
    const precio = bloque.indexOf('$2.75')
    const control = bloque.indexOf('Agregar Pan de Ajo Cheese')
    expect(nombre).toBeLessThan(precio)
    expect(precio).toBeLessThan(control)
  })

  it('con la tienda cerrada el «+» va deshabilitado', () => {
    expect(bloqueDeAdicionales(pintar(false))).toContain('disabled=""')
    expect(bloqueDeAdicionales(pintar(true))).not.toContain('disabled=""')
  })

  it('el pie enseña UN solo importe: el de lo que se va a agregar', () => {
    // ⚠️ La cicatriz: aquí hubo dos cuentas a la vez —«ya en tu pedido $16.85»
    // y «este plato $14.85»— porque los acompañamientos entraban al carrito
    // por su cuenta. «Ver dos cuentas es raro», y ninguna era la que ibas a
    // pagar. Una ficha, una cuenta.
    const pie = pieDeLaFicha(pintar())
    expect(pie).toContain('Precio actual')
    expect(pie).toContain('Agregar · $3.03')
    expect(pie).not.toContain('ya en tu pedido')
    expect(pie).not.toContain('Este plato')
  })
})
