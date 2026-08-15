import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  calculatePlatformMarkup,
  resolveMarkupRule,
} = require('../dist/services/platform-pricing')

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE MARGEN DE LA PLATAFORMA
// ═══════════════════════════════════════════════════════════════════════════
//
// Los MISMOS casos que ejercita `verificar-esquema.sql` contra PostgreSQL, a
// propósito: el panel simula con este motor y la base cobra con el suyo, así
// que si divergen el dueño del SaaS activa un porcentaje creyendo que le deja
// una cosa y le deja otra.
//
// El caso que justifica todo el módulo es supermercado contra restaurante: el
// mismo porcentaje que es razonable en uno es más de lo que el otro gana.

const RESTAURANTE = { strategy: 'percentage', percentage: 10 }
const SUPERMERCADO = { strategy: 'percentage', percentage: 4, maxAmount: 3 }

describe('motor de margen', () => {
  describe('falla abierto', () => {
    // Un problema de configuración de precios no puede dejar a una pizzería
    // sin poder vender. Equivocarse por defecto cuesta una comisión;
    // equivocarse al revés cuesta el servicio entero de ese día.
    it('sin regla no cobra nada y el comercio se queda con todo', () => {
      const r = calculatePlatformMarkup(50, null)
      expect(r.markup).toBe(0)
      expect(r.merchantSubtotal).toBe(50)
      expect(r.ruleId).toBeNull()
    })

    it('un subtotal en cero no genera margen', () => {
      expect(calculatePlatformMarkup(0, RESTAURANTE).markup).toBe(0)
    })

    // Una devolución mal registrada produciría un margen negativo que luego
    // habría que perseguir en el ledger.
    it('un subtotal negativo no genera margen negativo', () => {
      expect(calculatePlatformMarkup(-10, RESTAURANTE).markup).toBe(0)
    })
  })

  describe('restaurante: porcentaje simple', () => {
    it('cobra el 10 % de $15.00', () => {
      expect(calculatePlatformMarkup(15, RESTAURANTE).markup).toBe(1.5)
    })

    it('redondea a centavos como lo hace PostgreSQL', () => {
      expect(calculatePlatformMarkup(12.99, RESTAURANTE).markup).toBe(1.3)
    })

    it('lo que queda para el comercio es el resto exacto', () => {
      const r = calculatePlatformMarkup(15, RESTAURANTE)
      expect(r.merchantSubtotal).toBe(13.5)
      expect(r.markup + r.merchantSubtotal).toBe(15)
    })
  })

  describe('supermercado: el techo protege al comercio de volumen', () => {
    // Un supermercado trabaja al 2–5 %. Sin techo, el 4 % de una canasta de
    // $150 son $6 y le comería su propio margen.
    it('por debajo del techo cobra el porcentaje', () => {
      expect(calculatePlatformMarkup(20, SUPERMERCADO).markup).toBe(0.8)
    })

    it('una canasta de $150 paga $3, no $6', () => {
      expect(calculatePlatformMarkup(150, SUPERMERCADO).markup).toBe(3)
    })
  })

  describe('el piso nos protege a nosotros', () => {
    // Cada pedido cuesta mensajes de WhatsApp y llamadas de IA. Un pedido de
    // $2 al 4 % deja $0.08: sin piso se atiende a pérdida.
    const CON_PISO = { strategy: 'percentage', percentage: 4, minAmount: 0.5 }

    it('sube un pedido pequeño hasta el mínimo', () => {
      expect(calculatePlatformMarkup(2, CON_PISO).markup).toBe(0.5)
    })

    it('no toca los pedidos que ya superan el mínimo', () => {
      expect(calculatePlatformMarkup(40, CON_PISO).markup).toBe(1.6)
    })
  })

  describe('raíles que no dependen de la configuración', () => {
    // Un piso de $5 sobre un pedido de $2 no puede dejar al comercio
    // debiendo dinero por haber vendido.
    it('el margen nunca supera el subtotal', () => {
      const r = calculatePlatformMarkup(2, { strategy: 'fixed', fixedAmount: 5 })
      expect(r.markup).toBe(2)
      expect(r.merchantSubtotal).toBe(0)
    })

    it('el margen nunca es negativo', () => {
      const r = calculatePlatformMarkup(10, { strategy: 'fixed', fixedAmount: -5 })
      expect(r.markup).toBe(0)
    })
  })

  describe('tramos', () => {
    // Se ordenan por `upTo` y no por el orden del array: un array mal ordenado
    // en el panel cobraría el tramo equivocado sin avisar.
    const TRAMOS = {
      strategy: 'tiered',
      tiers: [{ upTo: 30, amount: 1.5 }, { amount: 3 }, { upTo: 10, amount: 0.5 }],
    }

    it('elige el primer tramo que alcanza al importe', () => {
      expect(calculatePlatformMarkup(8, TRAMOS).markup).toBe(0.5)
      expect(calculatePlatformMarkup(25, TRAMOS).markup).toBe(1.5)
    })

    it('el tramo sin techo cubre lo que quede por encima', () => {
      expect(calculatePlatformMarkup(500, TRAMOS).markup).toBe(3)
    })

    it('el borde exacto cae en el tramo de abajo', () => {
      expect(calculatePlatformMarkup(10, TRAMOS).markup).toBe(0.5)
    })
  })

  describe('de dónde sale el margen', () => {
    // Mismo cálculo y misma deuda: lo único que cambia es si el margen se
    // suma al precio del cliente o se absorbe del precio del comercio.
    it('absorbed: el cliente paga igual y el comercio recibe menos', () => {
      const r = calculatePlatformMarkup(10, { ...RESTAURANTE, markupMode: 'absorbed' })
      expect(r.customerSubtotal).toBe(10)
      expect(r.merchantSubtotal).toBe(9)
      expect(r.markup).toBe(1)
    })

    it('on_top: el comercio conserva su precio y el cliente paga más', () => {
      const r = calculatePlatformMarkup(10, { ...RESTAURANTE, markupMode: 'on_top' })
      expect(r.customerSubtotal).toBe(11)
      expect(r.merchantSubtotal).toBe(10)
      expect(r.markup).toBe(1)
    })

    it('sin especificar modo, absorbe: no cambia el precio del cliente', () => {
      expect(calculatePlatformMarkup(10, RESTAURANTE).customerSubtotal).toBe(10)
    })

    // El invariante del núcleo financiero: lo que paga el cliente se reparte
    // entero, sin que aparezca ni desaparezca dinero.
    it('en los dos modos el reparto suma lo que paga el cliente', () => {
      for (const markupMode of ['absorbed', 'on_top']) {
        const r = calculatePlatformMarkup(37.45, { ...RESTAURANTE, markupMode })
        expect(r.merchantSubtotal + r.markup).toBeCloseTo(r.customerSubtotal, 2)
      }
    })
  })

  describe('prioridad de reglas', () => {
    // Espejo del `order by` de la función de PostgreSQL: si el panel propone
    // una regla distinta de la que va a cobrar la base, el dueño del SaaS
    // activa un porcentaje creyendo que aplica y aplica otro.
    it('la del negocio gana a la del tipo y a la global', () => {
      const elegida = resolveMarkupRule([
        { scope: 'global' }, { scope: 'business' }, { scope: 'business_type' },
      ])
      expect(elegida.scope).toBe('business')
    })

    it('sin regla de negocio manda la del tipo', () => {
      expect(resolveMarkupRule([{ scope: 'global' }, { scope: 'business_type' }]).scope)
        .toBe('business_type')
    })

    it('sin candidatas no elige ninguna', () => {
      expect(resolveMarkupRule([])).toBeNull()
    })

    // 'category' y 'product' existen en el diseño pero el motor todavía no
    // los resuelve. Que se cuelen aquí daría una simulación que la base no
    // honraría.
    it('ignora los ámbitos que el motor todavía no resuelve', () => {
      expect(resolveMarkupRule([{ scope: 'category' }, { scope: 'product' }])).toBeNull()
    })
  })
})
