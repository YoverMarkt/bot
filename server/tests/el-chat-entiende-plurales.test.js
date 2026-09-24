import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { formasDeLaPalabra } = require('../dist/db/repositories/marketplace-catalog')

// ═══════════════════════════════════════════════════════════════════════════
// ESCRIBIR EN PLURAL YA NO ES «NO TE ENTENDÍ»
// ═══════════════════════════════════════════════════════════════════════════
//
// EL CASO REAL que lo destapó (2026-09-23): el dueño probando su propia app
// escribió **«Parrilladas»** y recibió «🙏 Eso no lo pude entender» — aunque
// `parrillada → asados` SÍ está en el diccionario desde agosto.
//
// La consulta exigía la palabra EXACTA (`.in('term', palabras)`), así que el
// plural no casaba. Y no era un caso raro: en el diccionario hay `pizza` pero
// no `pizzas`, `almuerzo` pero no `almuerzos`, `asado` pero no `asados`.
// **Escribir en plural fallaba siempre**, que es justo como habla la gente.
//
// ⚠️ Lo peor no era no encontrar el local: era el MENSAJE. Hay un camino
// entero construido para decir «te entendí, pero todavía no tenemos eso» —y
// para apuntarlo como DEMANDA— al que nunca se llegaba por una «s».

/** Los términos REALES del diccionario de producción, para no inventarse casos. */
const DICCIONARIO = [
  'almuerzo', 'menu del dia', 'seco', 'asado', 'carne', 'parrillada', 'pollo',
  'bolon', 'cafe', 'desayuno', 'farmacia', 'medicina', 'burger', 'hamburguesa',
  'papas', 'chifa', 'sushi', 'tacos', 'batido', 'jugo', 'camaron', 'cebiche',
  'ceviche', 'corviche', 'encebollado', 'marisco', 'pescado', 'sebiche',
  'abarrotes', 'supermercado', 'vivares', 'pan', 'perfume', 'pizza', 'helado',
  'postre', 'torta', 'cena', 'cenar', 'criolla', 'merienda', 'restaurante',
  'restaurantes', 'tipica',
]

/** ¿Alguna forma de lo que escribió el cliente está en el diccionario? */
const casa = (escrito) => formasDeLaPalabra(escrito).some(f => DICCIONARIO.includes(f))

describe('el caso que lo destapó', () => {
  it('«parrilladas» encuentra «parrillada»', () => {
    expect(casa('parrilladas')).toBe(true)
  })
})

describe('los plurales que antes fallaban todos', () => {
  it.each([
    ['pizzas', 'pizza'],
    ['almuerzos', 'almuerzo'],
    ['asados', 'asado'],
    ['carnes', 'carne'],
    ['jugos', 'jugo'],
    ['postres', 'postre'],
    ['mariscos', 'marisco'],
    ['hamburguesas', 'hamburguesa'],
    ['desayunos', 'desayuno'],
    ['farmacias', 'farmacia'],
    ['cebiches', 'cebiche'],
  ])('«%s» encuentra «%s»', (escrito) => {
    expect(casa(escrito)).toBe(true)
  })
})

describe('y al revés: el diccionario a veces guarda el plural', () => {
  it('«taco» encuentra «tacos»', () => {
    // En el diccionario está `tacos`, no `taco`. Sin generar el plural, quien
    // escribe en singular se queda fuera.
    expect(casa('taco')).toBe(true)
  })

  it('«papa» encuentra «papas»', () => {
    expect(casa('papa')).toBe(true)
  })
})

describe('lo que YA funcionaba sigue funcionando', () => {
  it.each(['pizza', 'almuerzo', 'pollo', 'ceviche', 'sushi', 'pan'])(
    '«%s» sigue casando', (palabra) => {
      expect(casa(palabra)).toBe(true)
    },
  )
})

describe('y lo que de verdad no se entiende, sigue sin entenderse', () => {
  it.each(['asdfghjkl', 'lasana', 'qwerty', 'zzzzz'])(
    '«%s» no casa con nada', (basura) => {
      expect(casa(basura)).toBe(false)
    },
  )
})

describe('las formas se generan quitando y añadiendo, nunca inventando', () => {
  it('de un plural en -es salen las dos raíces', () => {
    const formas = formasDeLaPalabra('panes')
    expect(formas).toContain('panes')
    expect(formas).toContain('pane')
    expect(formas).toContain('pan')
  })

  it('de un singular salen sus plurales', () => {
    const formas = formasDeLaPalabra('pan')
    expect(formas).toContain('pans')
    expect(formas).toContain('panes')
  })

  it('no se recorta una palabra corta hasta dejarla en nada', () => {
    // «sal» no puede convertirse en «sa»: dos letras casarían con cualquier cosa.
    expect(formasDeLaPalabra('sal')).not.toContain('sa')
    expect(formasDeLaPalabra('es')).not.toContain('')
  })

  it('no hay duplicados, que serían viajes de más a la base', () => {
    const formas = formasDeLaPalabra('tacos')
    expect(formas.length).toBe(new Set(formas).size)
  })

  it('una palabra que ya acaba en s no gana un plural inventado', () => {
    expect(formasDeLaPalabra('papas')).not.toContain('papass')
  })
})
