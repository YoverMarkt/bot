import { describe, expect, it } from 'vitest'
import { foto } from '../src/lib/imagen'

// Todo el cuidado que se pone en que la app quepa en 82 kB se pierde en la
// primera foto que suba un dueño desde su teléfono: 3 MB por producto, y una
// carta de diecisiete son decenas de megas para cada cliente.

const CLOUDINARY = 'https://res.cloudinary.com/botpanel/image/upload/v1786177842/botpanel/abc/foto.jpg'

describe('foto', () => {
  it('pide formato, calidad y ancho a Cloudinary', () => {
    expect(foto(CLOUDINARY, 'tarjeta')).toBe(
      'https://res.cloudinary.com/botpanel/image/upload/f_auto,q_auto,c_limit,w_400/v1786177842/botpanel/abc/foto.jpg',
    )
  })

  // ⚠️ Sin `c_limit`, `w_1200` AMPLÍA una imagen más pequeña y solo añade
  // peso. Medido contra la portada real: 43 kB de original pasaban a 61.
  it('nunca amplía: c_limit va siempre con el ancho', () => {
    expect(foto(CLOUDINARY, 'portada')).toContain('c_limit,w_1200')
  })

  it('cada sitio pide su ancho: servir 1200 px para pintar 160 es el peor gasto', () => {
    const anchos = (['miniatura', 'tarjeta', 'ficha', 'portada'] as const)
      .map(uso => Number(/w_(\d+)/.exec(foto(CLOUDINARY, uso) || '')?.[1]))
    expect(anchos).toEqual([160, 400, 800, 1200])
  })

  // Meterle parámetros de Cloudinary a un dominio ajeno rompe la imagen, y el
  // negocio puede pegar la suya de donde quiera.
  it('una URL que no es de Cloudinary se devuelve intacta', () => {
    const ajena = 'https://mi-sitio.com/fotos/pizza.jpg'
    expect(foto(ajena, 'tarjeta')).toBe(ajena)
  })

  // Encadenar dos tramos daría un resultado que nadie escribió.
  it('si ya trae transformaciones no se le añaden más', () => {
    const yaTransformada = 'https://res.cloudinary.com/botpanel/image/upload/w_100/v1/a/b.jpg'
    expect(foto(yaTransformada, 'portada')).toBe(yaTransformada)
  })

  it('sin foto devuelve nulo, que es lo que el marcador espera', () => {
    for (const vacio of [null, undefined, '', '   ']) {
      expect(foto(vacio, 'tarjeta')).toBeNull()
    }
  })
})
