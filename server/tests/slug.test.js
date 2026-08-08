import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { slugify, slugLibre } = require('../dist/lib/slug')

// La dirección de la tienda viaja en un WhatsApp y la lee una persona.
// `monster-pizza` dice de quién es; `monster-pizza-1785656324571` parece un
// identificador de sistema y ocupa el doble.

describe('la dirección de la tienda', () => {
  it('convierte el nombre en algo legible', () => {
    expect(slugify('Monster Pizza')).toBe('monster-pizza')
    expect(slugify('Pizzería Don Pepe')).toBe('pizzeria-don-pepe')
  })

  // ⚠️ El fallo de la versión anterior: hacía `replace(/[^a-z0-9-]/g, '')`
  // sobre el nombre en crudo, así que la letra con tilde desaparecía ENTERA.
  it('las tildes se convierten, no se borran', () => {
    expect(slugify('Heladería')).toBe('heladeria')
    expect(slugify('Heladería')).not.toBe('heladera')
    expect(slugify('Cafetería Ñandú')).toBe('cafeteria-nandu')
    expect(slugify('Piña Colada')).toBe('pina-colada')
  })

  it('no deja guiones sueltos ni repetidos', () => {
    expect(slugify('  Pizza   —   Don Pepe  ')).toBe('pizza-don-pepe')
    expect(slugify('¡¡¡Pizza!!!')).toBe('pizza')
    expect(slugify('--Pizza--')).toBe('pizza')
  })

  it('acorta los nombres largos sin dejar el guion colgando', () => {
    const largo = slugify('A'.repeat(40) + ' ' + 'B'.repeat(40))
    expect(largo.length).toBeLessThanOrEqual(60)
    expect(largo.endsWith('-')).toBe(false)
  })

  it('un nombre del que no queda nada no inventa una dirección', () => {
    expect(slugify('日本語')).toBe('')
    expect(slugify('   ')).toBe('')
  })

  describe('elegir el primero libre', () => {
    it('sin choque, no lleva número', async () => {
      expect(await slugLibre('Monster Pizza', async () => false)).toBe('monster-pizza')
    })

    // El sufijo solo aparece cuando de verdad hay dos negocios que se llaman
    // igual. El `Date.now()` anterior lo ponía SIEMPRE, por si acaso.
    it('con choque, prueba el siguiente número', async () => {
      const ocupados = new Set(['monster-pizza'])
      expect(await slugLibre('Monster Pizza', async s => ocupados.has(s)))
        .toBe('monster-pizza-2')

      ocupados.add('monster-pizza-2')
      expect(await slugLibre('Monster Pizza', async s => ocupados.has(s)))
        .toBe('monster-pizza-3')
    })

    it('un nombre vacío cae en algo utilizable', async () => {
      expect(await slugLibre('日本語', async () => false)).toBe('negocio')
    })

    // Cincuenta iguales no va a pasar, pero rendirse en silencio daría un slug
    // repetido y el alta fallaría con un error de restricción que no explica
    // nada. El reloj garantiza que salga uno único.
    it('si todo está ocupado, cae al reloj en vez de repetir', async () => {
      const slug = await slugLibre('Monster Pizza', async () => true, 3)
      expect(slug).toMatch(/^monster-pizza-\d{10,}$/)
    })
  })
})
