import { describe, expect, it } from 'vitest'
import { looksLikeMobile, type DeviceSignals } from '../src/lib/device'

// La tienda solo se abre desde el móvil, y esta función decide quién entra.
//
// Los dos errores NO cuestan lo mismo: dejar pasar un PC solo permite curiosear
// algo que de todas formas no tiene secretos; bloquear un teléfono de verdad
// pierde una venta y el cliente ni se entera de por qué. Por eso los casos de
// abajo cubren teléfonos raros con más insistencia que computadoras.

const señales = (extra: Partial<DeviceSignals> = {}): DeviceSignals => ({
  userAgent: '',
  maxTouchPoints: 0,
  coarsePointer: false,
  ...extra,
})

const MOVILES = {
  'iPhone con Safari':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Android con Chrome':
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  'el navegador dentro de WhatsApp (Android)':
    'Mozilla/5.0 (Linux; Android 11; RMX3231 Build/RKQ1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 Mobile Safari/537.36',
  'Android viejo y barato':
    'Mozilla/5.0 (Linux; U; Android 8.1.0; es-ec; TECNO KC2 Build/O11019) AppleWebKit/537.36 Mobile Safari/537.36',
  'iPad declarándose como tal':
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
}

const ESCRITORIO = {
  'Windows con Chrome':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mac con Safari':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Linux con Firefox':
    'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
}

describe('desde qué dispositivo se abre la tienda', () => {
  describe('entran los teléfonos', () => {
    for (const [nombre, userAgent] of Object.entries(MOVILES)) {
      it(nombre, () => {
        expect(looksLikeMobile(señales({
          userAgent, maxTouchPoints: 5, coarsePointer: true,
        }))).toBe(true)
      })
    }

    // El caso que rompe la detección ingenua: iPadOS pide las webs "de
    // escritorio" por defecto y se hace pasar por un Mac. Solo lo delata la
    // pantalla táctil.
    it('un iPad en modo escritorio, que dice ser un Mac', () => {
      expect(looksLikeMobile(señales({
        userAgent: ESCRITORIO['Mac con Safari'],
        maxTouchPoints: 5,
        coarsePointer: true,
      }))).toBe(true)
    })
  })

  describe('se quedan fuera las computadoras', () => {
    for (const [nombre, userAgent] of Object.entries(ESCRITORIO)) {
      it(nombre, () => {
        expect(looksLikeMobile(señales({ userAgent }))).toBe(false)
      })
    }

    // Un portátil táctil reconoce dedos, pero su puntero principal sigue siendo
    // el ratón. Es un PC y debe tratarse como tal.
    it('un portátil Windows con pantalla táctil', () => {
      expect(looksLikeMobile(señales({
        userAgent: ESCRITORIO['Windows con Chrome'],
        maxTouchPoints: 10,
        coarsePointer: false,
      }))).toBe(false)
    })
  })

  describe('ante la duda, dejar pasar', () => {
    // Perder una venta en silencio es peor que dejar mirar a un curioso.
    it('sin identificador pero con pantalla táctil, entra', () => {
      expect(looksLikeMobile(señales({ maxTouchPoints: 5, coarsePointer: true }))).toBe(true)
    })

    it('el identificador manda aunque no haya señales de pantalla', () => {
      expect(looksLikeMobile(señales({ userAgent: MOVILES['iPhone con Safari'] }))).toBe(true)
    })

    // Sin ninguna señal a favor no hay motivo para creer que es un teléfono.
    it('sin ninguna señal, se trata como computadora', () => {
      expect(looksLikeMobile(señales())).toBe(false)
    })
  })
})
