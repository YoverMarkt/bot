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

const pintar = (
  cuantos: number,
  puedePedir = true,
  pedido: { unidades: number; total: number } = { unidades: 0, total: 0 },
): string =>
  renderToStaticMarkup(
    <ProductSheet
      product={pizza}
      abierto
      onCerrar={() => {}}
      onAgregar={() => {}}
      onAgregarSuelto={() => {}}
      cantidadSuelta={() => cuantos}
      onCambiarSuelto={() => {}}
      unidadesEnPedido={pedido.unidades}
      totalDelPedido={pedido.total}
      puedePedir={puedePedir}
    />,
  )

/** Solo el pie: donde vive el precio del plato y lo que ya lleva el pedido. */
const pieDeLaFicha = (html: string): string =>
  html.slice(html.lastIndexOf('sticky bottom-0'))

describe('el adicional en la ficha de otro plato', () => {
  it('sin nada en el carrito enseña el «+»', () => {
    const bloque = bloqueDeAdicionales(pintar(0))
    expect(bloque).toContain('Pan de Ajo Cheese')
    expect(bloque).toContain('Agregar Pan de Ajo Cheese')
    expect(bloque).not.toContain('Quitar uno')
  })

  it('con dos en el carrito enseña el CONTADOR, no el «+»', () => {
    // El fallo que reportó el dueño: tocaba y la pantalla no acusaba el toque.
    const bloque = bloqueDeAdicionales(pintar(2))
    expect(bloque).toContain('Quitar uno')
    expect(bloque).not.toContain('Agregar Pan de Ajo Cheese')
    expect(bloque).toMatch(/>2</)
  })

  it('el contador deja QUITARLO sin abrir el carrito', () => {
    // Enterarse de más en el carrito y tener que volver es el viaje que esto
    // ahorra: el «−» tiene que estar vivo con uno solo en el carrito, y por eso
    // va con `minimo={0}`.
    const bloque = bloqueDeAdicionales(pintar(1))
    expect(bloque).toContain('Quitar uno')
    // ⚠️ `disabled=""` es el atributo; `disabled:opacity-30` es una clase de
    // Tailwind que llevan todos los botones. Buscar «disabled» a secas daba
    // por apagado un botón que estaba vivo.
    expect(bloque).not.toContain('disabled=""')
  })

  it('el precio del PLATO no cambia, y está bien que no cambie', () => {
    // El adicional es otro producto y va por su cuenta. Quien «arregle» esto
    // sumándolo al plato hará que el negocio cobre dos veces.
    expect(pintar(0)).toContain('$3.03')
    expect(pintar(3)).toContain('$3.03')
  })

  it('con la tienda cerrada el «+» va deshabilitado', () => {
    expect(bloqueDeAdicionales(pintar(0, false))).toContain('disabled=""')
    expect(bloqueDeAdicionales(pintar(0, true))).not.toContain('disabled=""')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE YA LLEVAS, VISIBLE MIENTRAS ELIGES
// ═══════════════════════════════════════════════════════════════════════════
//
// Con la ficha abierta, la barra «Ver pedido» queda debajo (`z-40`). El dueño
// metió $34.10 en acompañamientos y el pie seguía marcando $14.85 —el precio
// de la pizza—, así que la app parecía no estar sumando. Sumaba: no lo
// enseñaba.

describe('lo que ya lleva el pedido', () => {
  const CON_PEDIDO = { unidades: 14, total: 50.95 }

  it('el pie enseña las unidades y el total del pedido', () => {
    const pie = pieDeLaFicha(pintar(4, true, CON_PEDIDO))
    expect(pie).toContain('ya en tu pedido')
    expect(pie).toContain('14')
    expect(pie).toContain('$50.95')
  })

  it('con el carrito vacío no se enseña nada: no hay nada que contar', () => {
    expect(pieDeLaFicha(pintar(0))).not.toContain('ya en tu pedido')
  })

  it('el botón sigue cobrando SOLO este plato, no el carrito', () => {
    // El fallo que NO hay que «arreglar»: si el botón dijera $50.95, agregaría
    // una pizza cobrando el pedido entero.
    const pie = pieDeLaFicha(pintar(4, true, CON_PEDIDO))
    expect(pie).toContain('Agregar · $3.03')
    expect(pie).not.toContain('Agregar · $50.95')
  })

  it('los dos importes van etiquetados, para no leerse como un error', () => {
    // Dos cifras seguidas sin decir de qué es cada una parecen un fallo de la
    // app. Con pedido detrás, el del plato deja de llamarse «Precio actual».
    const conPedido = pieDeLaFicha(pintar(0, true, CON_PEDIDO))
    expect(conPedido).toContain('Este plato')
    expect(conPedido).not.toContain('Precio actual')
    // Sin nada detrás no hay con qué confundirlo.
    expect(pieDeLaFicha(pintar(0))).toContain('Precio actual')
  })

  it('no es un botón: tocarlo no puede tirar lo que estás armando', () => {
    const html = pintar(4, true, CON_PEDIDO)
    const inicio = html.indexOf('ya en tu pedido')
    const trozo = html.slice(Math.max(0, inicio - 400), inicio)
    expect(trozo).not.toContain('<button')
  })
})

describe('la fila del adicional no corta el nombre', () => {
  it('el nombre y el precio no compiten por el mismo ancho', () => {
    // Con nombre, precio y contador en fila, producción enseñaba «Pan de Ajo …»
    // y «Nachos Sup…». El precio pasó a ir DEBAJO del nombre.
    const bloque = bloqueDeAdicionales(pintar(4))
    const nombre = bloque.indexOf('Pan de Ajo Cheese')
    const precio = bloque.indexOf('$2.75')
    const control = bloque.indexOf('Quitar uno')
    expect(nombre).toBeLessThan(precio)
    expect(precio).toBeLessThan(control)
    // El precio vive DENTRO del bloque del nombre, no en una columna aparte.
    expect(bloque.slice(nombre, precio)).not.toContain('</span></span>')
  })
})
