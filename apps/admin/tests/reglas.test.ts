import { describe, expect, it } from 'vitest'
import { comoCobra, dinero, ETIQUETA_AMBITO, ETIQUETA_ESTRATEGIA } from '../src/features/pricing/reglas'

// ═══════════════════════════════════════════════════════════════════════════
// CÓMO SE LEE UNA REGLA DE MARGEN
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Es texto de DINERO: el superadmin lee esta línea para decidir cuánto cobra
// la plataforma. Una etiqueta equivocada le hace tomar una decisión sobre una
// cifra que no es la real.
//
// Primeras pruebas del panel del superadmin, que tampoco tenía ninguna.

const regla = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', scope: 'global', strategy: 'percentage', percentage: 10,
  fixed_amount: null, tiers: null, min_amount: null, max_amount: null,
  markup_mode: 'on_top', status: 'active', version: 1,
  ...extra,
}) as never

describe('comoCobra', () => {
  it('un porcentaje se lee como porcentaje', () => {
    expect(comoCobra(regla({ strategy: 'percentage', percentage: 10 }))).toBe('10%')
  })

  it('un monto fijo se lee en dinero', () => {
    expect(comoCobra(regla({ strategy: 'fixed', fixed_amount: 1.5 }))).toBe('$1.50')
  })

  it('los tramos dicen cuántos son', () => {
    expect(comoCobra(regla({ strategy: 'tiered', tiers: [{}, {}, {}] }))).toBe('3 tramos')
  })

  it('⚠️ los frenos se ven, porque cambian lo que se cobra', () => {
    // El piso nos protege a NOSOTROS (cada pedido cuesta mensajes y IA) y el
    // techo al comercio de volumen. No verlos es leer media regla.
    expect(comoCobra(regla({ min_amount: 0.5 }))).toBe('10% — mínimo $0.50')
    expect(comoCobra(regla({ max_amount: 3 }))).toBe('10% — máximo $3.00')
    expect(comoCobra(regla({ min_amount: 0.5, max_amount: 3 })))
      .toBe('10% — mínimo $0.50 · máximo $3.00')
  })

  it('un cero NO es «sin freno», y se distingue', () => {
    // `0` es un piso real; `null` es que no hay. Confundirlos cambia el cobro.
    expect(comoCobra(regla({ min_amount: 0 }))).toContain('mínimo $0.00')
    expect(comoCobra(regla({ min_amount: null }))).toBe('10%')
  })
})

describe('dinero', () => {
  it('siempre con dos decimales', () => {
    expect(dinero(1)).toBe('$1.00')
    expect(dinero('2.5')).toBe('$2.50')
    expect(dinero(0)).toBe('$0.00')
  })

  it('un valor ausente no pinta NaN delante del superadmin', () => {
    expect(dinero(null as never)).toBe('$0.00')
    expect(dinero(undefined as never)).toBe('$0.00')
  })
})

describe('las etiquetas cubren todos los ámbitos y estrategias', () => {
  it('ninguna queda sin nombre', () => {
    // ⚠️ `family` sigue aquí aunque ya no se pueda crear: la lista tiene que
    // saber pintar una regla antigua de ese ámbito.
    for (const scope of ['family', 'business', 'business_type', 'global'] as const) {
      expect(ETIQUETA_AMBITO[scope], scope).toBeTruthy()
    }
    for (const s of ['percentage', 'fixed', 'tiered'] as const) {
      expect(ETIQUETA_ESTRATEGIA[s], s).toBeTruthy()
    }
  })
})
