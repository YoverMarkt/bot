import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  checkQuotedPrices,
  extractQuotedAmounts,
  priceGuardMode,
} = require('../dist/services/price-guard')

// Catálogo de referencia: una cabaña a 95 y un producto a 10.50.
const CATALOGO = [95, 10.5]

const revisar = text => checkQuotedPrices({ text, allowedAmounts: CATALOGO })

describe('vigilante de precios de la IA', () => {
  describe('qué cuenta como precio', () => {
    it('detecta montos con símbolo de moneda', () => {
      expect(extractQuotedAmounts('La habitación cuesta $95 por noche')).toEqual([95])
      expect(extractQuotedAmounts('Son $10.50 en total')).toEqual([10.5])
      expect(extractQuotedAmounts('Cuesta 95 dólares')).toEqual([95])
      expect(extractQuotedAmounts('USD 95 la noche')).toEqual([95])
    })

    it('entiende los separadores de miles en ambos formatos', () => {
      expect(extractQuotedAmounts('$1.234,50')).toEqual([1234.5])
      expect(extractQuotedAmounts('$1,234.50')).toEqual([1234.5])
    })

    // Sin este filtro el vigilante sería tan ruidoso que habría que apagarlo.
    it('IGNORA números que no son precios', () => {
      expect(extractQuotedAmounts('Son 3 noches para 2 personas')).toEqual([])
      expect(extractQuotedAmounts('Abrimos a las 10:00 hasta las 18:00')).toEqual([])
      expect(extractQuotedAmounts('Entrada el 20 de agosto, salida el 22')).toEqual([])
      expect(extractQuotedAmounts('Llámanos al 0991716574')).toEqual([])
      expect(extractQuotedAmounts('La habitación 305 está libre')).toEqual([])
    })
  })

  describe('lo que la IA SÍ puede decir', () => {
    it('acepta un precio que está en el catálogo', () => {
      expect(revisar('La cabaña cuesta $95 la noche').ok).toBe(true)
    })

    it('acepta un múltiplo: 2 noches × $95 = $190', () => {
      const resultado = revisar('Por 2 noches serían $190')
      expect(resultado.ok).toBe(true)
      expect(resultado.invented).toEqual([])
    })

    it('acepta un total que el servidor ya calculó en este turno', () => {
      const resultado = checkQuotedPrices({
        text: 'El total de tu pedido es $47.30',
        allowedAmounts: [...CATALOGO, 47.3],
      })
      expect(resultado.ok).toBe(true)
    })

    it('tolera diferencias de redondeo de un céntimo', () => {
      expect(checkQuotedPrices({
        text: 'Serían $31.50',
        allowedAmounts: [10.5],
      }).ok).toBe(true)
    })

    it('no acusa a nadie si el negocio no tiene precios cargados', () => {
      const resultado = checkQuotedPrices({
        text: 'Cuesta $999',
        allowedAmounts: [],
      })
      expect(resultado.ok).toBe(true)
      expect(resultado.invented).toEqual([])
    })
  })

  describe('lo que NO puede decir', () => {
    it('caza un precio que no existe en ninguna parte', () => {
      const resultado = revisar('Te lo dejo en $40, oferta especial')
      expect(resultado.ok).toBe(false)
      expect(resultado.invented).toEqual([40])
    })

    it('caza un descuento inventado sobre un precio real', () => {
      const resultado = revisar('Normalmente son $95 pero te lo dejo en $70')
      expect(resultado.ok).toBe(false)
      expect(resultado.invented).toEqual([70])
    })

    it('caza varios montos inventados a la vez', () => {
      const resultado = revisar('Tenemos opciones de $33 y $44')
      expect(resultado.ok).toBe(false)
      expect(resultado.invented).toEqual([33, 44])
    })

    it('informa también de los montos que sí eran válidos', () => {
      const resultado = revisar('La cabaña son $95 y el extra $7')
      expect(resultado.quoted).toEqual([95, 7])
      expect(resultado.invented).toEqual([7])
    })
  })

  // Empezar bloqueando sin datos reales cortaría conversaciones legítimas.
  describe('modo de operación', () => {
    it('observa por defecto, sin tocar la conversación', () => {
      expect(priceGuardMode({})).toBe('observar')
      expect(priceGuardMode({ PRICE_GUARD_MODE: '' })).toBe('observar')
      expect(priceGuardMode({ PRICE_GUARD_MODE: 'cualquier-cosa' })).toBe('observar')
    })

    it('solo bloquea cuando se pide explícitamente', () => {
      expect(priceGuardMode({ PRICE_GUARD_MODE: 'bloquear' })).toBe('bloquear')
      expect(priceGuardMode({ PRICE_GUARD_MODE: 'BLOQUEAR' })).toBe('bloquear')
    })
  })
})
