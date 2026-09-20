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
  optionGroups: [],
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

const pintar = (cuantos: number, puedePedir = true): string =>
  renderToStaticMarkup(
    <ProductSheet
      product={pizza}
      abierto
      onCerrar={() => {}}
      onAgregar={() => {}}
      onAgregarSuelto={() => {}}
      cantidadSuelta={() => cuantos}
      onCambiarSuelto={() => {}}
      puedePedir={puedePedir}
    />,
  )

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
