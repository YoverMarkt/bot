import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { esSoloUnSaludo } = require('../dist/services/saludo')

// Esta función decide cuándo el modo mini app manda el enlace de la tienda, y
// por eso es dinero por los dos lados: si dice que sí de más, cada mensaje
// suelto gasta un WhatsApp que se paga; si dice que no de más, quien llega
// diciendo «hola» se queda sin la única forma de pedir que tiene ese negocio.
//
// Vivía en `bot-menu.ts` y se quedó al retirar el modo menú (2026-08-16), que
// es justo cuando conviene tener escrito lo que hace.
describe('¿el mensaje es solo un saludo?', () => {
  it('reconoce los saludos como llegan de verdad', () => {
    for (const texto of [
      'hola',
      'Hola',
      'HOLA',
      'Holaaa!!',
      'buenas',
      'buenas tardes',
      'buenos días',
      'Buenas noches',
      'qué tal',
      'como estas',
      'hey',
      'saludos',
    ]) {
      expect(esSoloUnSaludo(texto), texto).toBe(true)
    }
  })

  it('trata el pedido de menú como un saludo: tampoco dice nada concreto', () => {
    for (const texto of ['menu', 'menú', 'info', 'información', 'opciones', 'ayuda', 'empezar']) {
      expect(esSoloUnSaludo(texto), texto).toBe(true)
    }
  })

  it('un mensaje de puros emojis cuenta como saludo', () => {
    // No le aporta nada a nadie, así que el enlace es justo lo que necesita.
    for (const texto of ['👋', '🙌🙌', '😀 👋']) {
      expect(esSoloUnSaludo(texto), texto).toBe(true)
    }
  })

  it('NO manda enlace a quien ya vino a decir algo concreto', () => {
    for (const texto of [
      'hola quiero una pizza familiar de pepperoni',
      '¿tienen hawaiana?',
      'cuánto cuesta el combo',
      'mi pedido no llegó',
      'quiero cancelar',
      'hola buenas tardes disculpe una consulta sobre mi pedido de ayer',
    ]) {
      expect(esSoloUnSaludo(texto), texto).toBe(false)
    }
  })

  it('un saludo largo deja de serlo: cinco palabras es el tope', () => {
    expect(esSoloUnSaludo('hola buenas tardes que tal')).toBe(true)
    expect(esSoloUnSaludo('hola buenas tardes que tal como')).toBe(false)
  })

  it('un mensaje vacío no es un saludo', () => {
    // Sin esto, un mensaje en blanco dispararía un enlace que nadie pidió.
    for (const texto of ['', '   ', '\n']) {
      expect(esSoloUnSaludo(texto), JSON.stringify(texto)).toBe(false)
    }
  })
})
