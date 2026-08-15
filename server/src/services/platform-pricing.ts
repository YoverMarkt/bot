// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE MARGEN DE LA PLATAFORMA
// ═══════════════════════════════════════════════════════════════════════════
//
// Cuánto gana la plataforma con un pedido. Hasta ahora la única fuente de
// ingreso era la cuota mensual (`businesses.monthly_rate`) y un pedido no
// dejaba nada.
//
// ⚠️ ESTE ARCHIVO NO ES LA AUTORIDAD. El margen que se cobra lo calcula
// PostgreSQL en `calculate_platform_markup`, y lo sella un disparador sobre
// `orders` (regla inviolable #8). Aquí vive la misma lógica en TypeScript para
// que el panel del superadmin pueda SIMULAR una regla antes de activarla —«si
// pongo 5 % con techo de $3, ¿cuánto me deja una canasta de $80?»— sin crear
// un pedido de mentira para averiguarlo.
//
// Es el mismo reparto de papeles que ya tienen `pricing.ts` y
// `create_storefront_order`, y por el mismo motivo: si solo lo supiera la
// base, el dueño del SaaS activaría porcentajes a ciegas. Por eso hay una
// prueba que contrasta los dos motores con los mismos casos
// (`tests/motor-de-margen.test.js` y `tests/sql/verificar-esquema.sql`).
//
// ⚠️ Está en la lista `ignore` de knip, y conviene saber por qué: hoy lo
// consume SOLO su prueba, que es un `.js` y lo carga desde `dist/`, un camino
// que knip no puede seguir. No es código muerto —tiene 23 casos encima— pero
// tampoco lo importa todavía ningún módulo del servidor: su consumidor natural
// es el simulador del panel del superadmin. Cuando ese exista, esta línea
// sobra y hay que quitarla de `knip.json`.
//
// ── POR QUÉ TRES FRENOS Y NO UN PORCENTAJE ────────────────────────────────
//
// Un restaurante trabaja con márgenes amplios; un supermercado, al 2–5 %.
// Cobrarle a un supermercado el 8 % de una canasta de $80 son $6.40 — más de
// lo que él gana con esa venta.
//
//   · `maxAmount` (TECHO) protege al comercio de volumen.
//   · `minAmount` (PISO) nos protege a NOSOTROS: cada pedido cuesta mensajes
//     de WhatsApp —Meta los cobra desde el 1 de octubre de 2026— y llamadas de
//     IA. Un pedido de $2 al 8 % deja $0.16 y puede costar más que eso en
//     mensajes: sin piso, los pedidos pequeños se atienden a pérdida.
//   · `tiered` cubre lo que no alcanzan los otros dos.

/** Cómo cobra una regla. Espejo de `pricing_rules.strategy`. */
export type MarkupStrategy = 'percentage' | 'fixed' | 'tiered'

/**
 * De dónde sale el margen.
 *
 * · `absorbed` → el cliente paga $10, el comercio recibe $9, la plataforma $1.
 * · `on_top`   → el cliente paga $11, el comercio recibe $10, la plataforma $1.
 *
 * ⚠️ **`on_top` no se puede guardar todavía**: el CHECK de `pricing_rules` solo
 * admite `absorbed`, porque aplicarlo de verdad exige que el catálogo, el
 * carrito y el resumen pinten el precio con margen — si no, el cliente
 * descubriría el precio real al confirmar. Aquí está implementado y probado a
 * propósito: el día que esas tres pantallas estén listas, se abre el CHECK y
 * no hay que escribir este cálculo con prisa.
 *
 * Mismo cálculo, mismo asiento y misma deuda: lo único que cambia es si el
 * margen se suma al precio del cliente o se absorbe del precio del comercio.
 */
export type MarkupMode = 'absorbed' | 'on_top'

/** Un tramo de `tiered`. Sin `upTo` es el tramo final, sin techo. */
export interface MarkupTier {
  upTo?: number | null
  amount: number
}

/** Una regla de margen, tal como la guarda `pricing_rules`. */
export interface MarkupRule {
  id?: string
  strategy: MarkupStrategy
  percentage?: number | null
  fixedAmount?: number | null
  tiers?: MarkupTier[] | null
  minAmount?: number | null
  maxAmount?: number | null
  markupMode?: MarkupMode
  version?: number
}

export interface MarkupResult {
  /** Lo que gana la plataforma. */
  markup: number
  /** Lo que le queda al comercio. */
  merchantSubtotal: number
  /** Lo que paga el cliente por los productos: con `on_top` incluye el margen. */
  customerSubtotal: number
  ruleId: string | null
  ruleVersion: number | null
  markupMode: MarkupMode
}

/** Redondeo a centavos, igual que `round(x, 2)` en PostgreSQL. */
const aCentavos = (valor: number): number =>
  Math.round((valor + Number.EPSILON) * 100) / 100

/** Lo que se devuelve cuando no hay nada que cobrar. */
const sinMargen = (base: number): MarkupResult => ({
  markup: 0,
  merchantSubtotal: aCentavos(Math.max(base, 0)),
  customerSubtotal: aCentavos(Math.max(base, 0)),
  ruleId: null,
  ruleVersion: null,
  markupMode: 'absorbed',
})

/**
 * El tramo que corresponde a un importe.
 *
 * Se ordena por `upTo` y NO por el orden del array: un array mal ordenado en
 * el panel cobraría el tramo equivocado sin avisar. El tramo sin `upTo` va al
 * final, que es lo que significa «de ahí en adelante».
 */
const tramoPara = (tiers: MarkupTier[], base: number): number => {
  const ordenados = [...tiers].sort(
    (a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity),
  )
  for (const tramo of ordenados) {
    if (tramo.upTo === null || tramo.upTo === undefined || base <= tramo.upTo) {
      return Number(tramo.amount) || 0
    }
  }
  return 0
}

/**
 * Cuánto gana la plataforma con un subtotal dado.
 *
 * `rule` nulo devuelve margen 0 —el mismo FALLO ABIERTO que la función de
 * PostgreSQL—: un problema de configuración de precios no puede dejar a una
 * pizzería sin poder vender. Equivocarse por defecto cuesta una comisión;
 * equivocarse al revés cuesta el servicio entero de ese día.
 */
export const calculatePlatformMarkup = (
  subtotal: number,
  rule: MarkupRule | null | undefined,
): MarkupResult => {
  const base = aCentavos(Number(subtotal) || 0)

  // Un subtotal negativo (una devolución mal registrada) produciría un margen
  // negativo que luego habría que perseguir en el ledger.
  if (base <= 0) return sinMargen(base)
  if (!rule) return sinMargen(base)

  let markup = 0

  if (rule.strategy === 'percentage') {
    markup = (base * (Number(rule.percentage) || 0)) / 100
  } else if (rule.strategy === 'fixed') {
    markup = Number(rule.fixedAmount) || 0
  } else if (rule.strategy === 'tiered') {
    markup = tramoPara(rule.tiers ?? [], base)
  }

  // El piso ANTES que el techo: con «mínimo $0.50, máximo $0.30» mal
  // configurados manda el techo, que es el que protege al comercio.
  if (rule.minAmount !== null && rule.minAmount !== undefined) {
    markup = Math.max(markup, rule.minAmount)
  }
  if (rule.maxAmount !== null && rule.maxAmount !== undefined) {
    markup = Math.min(markup, rule.maxAmount)
  }

  // Dos raíles que no dependen de la configuración. Un piso de $5 sobre un
  // pedido de $2 no puede dejar al comercio debiendo dinero por haber vendido.
  markup = aCentavos(Math.min(Math.max(markup, 0), base))

  const modo: MarkupMode = rule.markupMode ?? 'absorbed'

  return {
    markup,
    // Con `absorbed` el margen sale del precio del comercio; con `on_top` se
    // le suma al cliente y el comercio conserva su precio entero.
    merchantSubtotal: aCentavos(modo === 'on_top' ? base : base - markup),
    customerSubtotal: aCentavos(modo === 'on_top' ? base + markup : base),
    ruleId: rule.id ?? null,
    ruleVersion: rule.version ?? null,
    markupMode: modo,
  }
}

/**
 * La regla que gana entre las candidatas.
 *
 * Prioridad: negocio → tipo de negocio → global. Espejo del `order by` de
 * `calculate_platform_markup`, para que el simulador del panel no proponga una
 * regla distinta de la que va a cobrar la base.
 */
export const resolveMarkupRule = <T extends { scope: string }>(
  candidatas: readonly T[],
): T | null => {
  const peso: Record<string, number> = { business: 1, business_type: 2, global: 3 }
  const ordenadas = [...candidatas]
    .filter(r => peso[r.scope] !== undefined)
    .sort((a, b) => peso[a.scope] - peso[b.scope])
  return ordenadas[0] ?? null
}
