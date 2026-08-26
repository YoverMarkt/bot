import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { calculatePlatformMarkup } = require('../dist/services/platform-pricing.js')
const { precioDeVitrina, reglaDeMargen, quoteCart, publicBusiness } = require('../dist/services/storefront.js')

// ═══════════════════════════════════════════════════════════════════════════
// EL MARGEN SE SUMA AL PRECIO, NO SE LE QUITA AL DUEÑO (2026-08-25)
//
// Hasta hoy, sobre un pedido de $8: el cliente pagaba $8, el comercio recibía
// $7,20 y la plataforma $0,80. Los datos de producción lo confirmaban — en 5
// pedidos los clientes pagaron $64,95 y el comercio recibió $47,25.
//
// El dueño de un local pone el precio al que QUIERE VENDER. Quitarle una parte
// lo convierte en un descuento forzoso que nunca pactó.
// ═══════════════════════════════════════════════════════════════════════════

const REGLA = (pct, extra = {}) => ({
  strategy: 'percentage', percentage: pct, markupMode: 'on_top', ...extra,
})

describe('los casos del modelo económico', () => {
  // Los cinco casos mínimos que el dueño exigió por escrito.
  it('caso 1 — $5 al 10%: el comercio cobra $5 y el cliente $5,50', () => {
    const r = calculatePlatformMarkup(5, REGLA(10))
    expect(r.merchantSubtotal).toBe(5)
    expect(r.markup).toBe(0.5)
    expect(r.customerSubtotal).toBe(5.5)
  })

  it('caso 2 — $8 al 10%: el comercio cobra $8, la plataforma $0,80', () => {
    const r = calculatePlatformMarkup(8, REGLA(10))
    expect(r.merchantSubtotal).toBe(8)
    expect(r.markup).toBe(0.8)
    expect(r.customerSubtotal).toBe(8.8)
  })

  it('caso 3 — $10 al 5%', () => {
    const r = calculatePlatformMarkup(10, REGLA(5))
    expect(r.merchantSubtotal).toBe(10)
    expect(r.markup).toBe(0.5)
  })

  it('caso 4 — 0%: la plataforma no cobra nada y el comercio cobra todo', () => {
    const r = calculatePlatformMarkup(10, REGLA(0))
    expect(r.merchantSubtotal).toBe(10)
    expect(r.markup).toBe(0)
    expect(r.customerSubtotal).toBe(10)
  })

  // ⚠️ El caso que el dueño nombró por su nombre: $4,99 al 10% son $0,499.
  // Tiene que existir UNA regla y la misma en todo el sistema.
  it('$4,99 al 10% redondea a $0,50, y el cliente paga $5,49', () => {
    const r = calculatePlatformMarkup(4.99, REGLA(10))
    expect(r.markup).toBe(0.5)
    expect(r.merchantSubtotal).toBe(4.99)
    expect(r.customerSubtotal).toBe(5.49)
  })

  // El comercio NUNCA puede acabar debiendo dinero por haber vendido.
  it('un piso mayor que el pedido no deja al comercio en negativo', () => {
    const r = calculatePlatformMarkup(2, REGLA(10, { minAmount: 5 }))
    expect(r.markup).toBeLessThanOrEqual(2)
    expect(r.merchantSubtotal).toBeGreaterThanOrEqual(0)
  })

  // `absorbed` sigue existiendo: los pedidos viejos se liquidan como se cobraron.
  it('`absorbed` se conserva y sigue descontando, para los pedidos ya sellados', () => {
    const r = calculatePlatformMarkup(8, { ...REGLA(10), markupMode: 'absorbed' })
    expect(r.merchantSubtotal).toBe(7.2)
    expect(r.customerSubtotal).toBe(8)
  })
})

describe('el precio que ve el cliente en la vitrina', () => {
  it('con on_top al 10%, $5,00 se pinta $5,50', () => {
    expect(precioDeVitrina(5, REGLA(10))).toBe(5.5)
  })

  // Con `absorbed` el margen ya sale del precio del comercio: el cliente ya
  // está viendo lo que paga, y sumarle nada sería cobrarle dos veces.
  it('con absorbed NO se toca el precio', () => {
    expect(precioDeVitrina(5, { ...REGLA(10), markupMode: 'absorbed' })).toBe(5)
  })

  it('sin regla, el cliente ve el precio del comercio', () => {
    expect(precioDeVitrina(5, null)).toBe(5)
  })

  // ⚠️ `fixed` y `tiered` son cantidades del PEDIDO ENTERO. Repartirlas por
  // producto daría un precio unitario que no existe, y al sumar el carrito no
  // cuadraría con el cobro.
  it('las estrategias por pedido NO se reparten por producto', () => {
    expect(precioDeVitrina(5, { strategy: 'fixed', fixedAmount: 1, markupMode: 'on_top' })).toBe(5)
    expect(precioDeVitrina(5, { strategy: 'tiered', tiers: [{ amount: 1 }], markupMode: 'on_top' })).toBe(5)
  })

  // Un tope del pedido tampoco puede prorratearse: dos productos con techo de
  // $1 no llevan $1 cada uno.
  it('con topes de pedido tampoco se pinta', () => {
    expect(precioDeVitrina(5, REGLA(10, { maxAmount: 1 }))).toBe(5)
    expect(precioDeVitrina(5, REGLA(10, { minAmount: 1 }))).toBe(5)
  })

  it('un precio ausente sigue ausente', () => {
    expect(precioDeVitrina(null, REGLA(10))).toBeNull()
  })
})

describe('la regla que llega de la base', () => {
  it('se normaliza a lo que espera el motor', () => {
    const r = reglaDeMargen({
      rule_id: 'abc', version: 3, mode: 'on_top', strategy: 'percentage',
      percentage: '10.0000', min_amount: null, max_amount: null,
    })
    expect(r).toMatchObject({ strategy: 'percentage', percentage: 10, markupMode: 'on_top', version: 3 })
  })

  // Falla hacia `absorbed`, que es no cobrarle de más a nadie.
  it('un modo desconocido no se convierte en on_top', () => {
    expect(reglaDeMargen({ strategy: 'percentage', mode: 'inventado' }).markupMode).toBe('absorbed')
  })

  it('sin regla devuelve null', () => {
    expect(reglaDeMargen(null)).toBeNull()
    expect(reglaDeMargen({})).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA COTIZACIÓN: el número que se enseña antes de pagar
// ═══════════════════════════════════════════════════════════════════════════
describe('el desglose del carrito', () => {
  const PRODUCTO = (id, price) => ({
    id, name: `P${id}`, price, price_sale: null, stock: 'disponible',
    active: true, category_id: null,
  })
  const cotizar = (items, pricing, deliveryFee = 0, fulfillment = 'pickup') => quoteCart({
    items, products: [PRODUCTO('a', 5), PRODUCTO('b', 2), PRODUCTO('c', 1)],
    variants: [], optionGroups: [], options: [], deliveryFee, fulfillment, pricing,
  })

  it('varios productos: el comercio cobra $8 y el cliente $8,80', () => {
    const q = cotizar([
      { productId: 'a', quantity: 1 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 1 },
    ], REGLA(10))
    expect(q.error).toBeFalsy()
    expect(q.subtotal).toBe(8)
    expect(q.merchantSubtotal).toBe(8)
    expect(q.platformMarkup).toBe(0.8)
    expect(q.customerSubtotal).toBe(8.8)
    expect(q.total).toBe(8.8)
  })

  it('cantidades mayores que 1: 2×$5 + 1×$2 + 2×$1 = $14', () => {
    const q = cotizar([
      { productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 2 },
    ], REGLA(10))
    expect(q.merchantSubtotal).toBe(14)
    expect(q.platformMarkup).toBe(1.4)
    expect(q.customerSubtotal).toBe(15.4)
  })

  // ⚠️ EL MARGEN NO SE COBRA SOBRE EL ENVÍO. $8 + 10% + $1,50 = $10,30, nunca
  // el 10% de $9,50.
  it('caso 5 — el envío queda FUERA del margen', () => {
    const q = cotizar([
      { productId: 'a', quantity: 1 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 1 },
    ], REGLA(10), 1.5, 'delivery')
    expect(q.merchantSubtotal).toBe(8)
    expect(q.platformMarkup).toBe(0.8)
    expect(q.shipping).toBe(1.5)
    expect(q.total).toBe(10.3)
  })

  it('sin regla, el cliente paga el precio del comercio', () => {
    const q = cotizar([{ productId: 'a', quantity: 1 }], null)
    expect(q.merchantSubtotal).toBe(5)
    expect(q.platformMarkup).toBe(0)
    expect(q.total).toBe(5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE LA BASE GARANTIZA
// ═══════════════════════════════════════════════════════════════════════════
describe('el sellado del pedido', () => {
  const MIGRACION = readFileSync(
    fileURLToPath(new URL('../migration-2026-08-29-margen-sobre-el-precio.sql', import.meta.url)), 'utf8')
  const ESQUEMA = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8')

  it('on_top deja de estar prohibido, en la migración y en el consolidado', () => {
    for (const [donde, sql] of [['migración', MIGRACION], ['schema.sql', ESQUEMA]]) {
      expect(sql, donde).toMatch(/check \(markup_mode in \('absorbed', 'on_top'\)\)/)
      expect(sql, donde).not.toMatch(/check \(markup_mode = 'absorbed'\)/)
    }
  })

  // ⚠️ Con on_top el comercio cobra su precio ENTERO: sin esta línea volvería
  // el descuento forzoso que el dueño pidió quitar.
  it('con on_top el comercio cobra el subtotal entero', () => {
    expect(MIGRACION).toMatch(/new\.merchant_subtotal := round\(new\.subtotal, 2\)/)
    expect(MIGRACION).toMatch(/new\.total := round\(new\.subtotal \+ v_markup \+ coalesce\(new\.shipping, 0\), 2\)/)
  })

  it('con absorbed se conserva el descuento, para los pedidos ya sellados', () => {
    expect(MIGRACION).toMatch(/new\.merchant_subtotal := round\(new\.subtotal - v_markup, 2\)/)
  })

  // ⚠️ El pedido se recalcula con la regla SELLADA, no con la vigente hoy: un
  // pedido de agosto no puede empezar a cobrar el porcentaje de septiembre
  // porque alguien le cambió el estado.
  it('un pedido viejo se recalcula con SU regla', () => {
    expect(MIGRACION).toMatch(/calculate_platform_markup\([\s\S]{0,120}new\.pricing_rule_id/)
  })

  // El mostrador lo teclea el dueño con la persona delante, cobrando el precio
  // que él dice. Subirle el total le haría cobrar de más a un cliente que vino
  // solo, sin que la plataforma lo trajera.
  it('el mostrador no lleva margen sumado', () => {
    expect(MIGRACION).toMatch(/v_modo = 'on_top' and coalesce\(new\.source, ''\) <> 'storefront'/)
  })

  it('la función del dinero NO se recrea', () => {
    expect(MIGRACION).not.toMatch(/create or replace function public\.create_storefront_order/)
  })

  // El catálogo necesita el porcentaje ANTES de que exista un pedido, y tiene
  // que salir de la MISMA jerarquía que cobra: negocio → tipo → global.
  it('la vista del catálogo respeta la jerarquía del cobro', () => {
    const fn = MIGRACION.slice(MIGRACION.indexOf('function public.business_pricing_view'))
    expect(fn).toMatch(/when 'business'\s+then 1/)
    expect(fn).toMatch(/when 'business_type' then 2/)
    expect(fn).toMatch(/when 'global'\s+then 3/)
    expect(fn).toMatch(/pr\.status = 'active'/)
    expect(fn).toMatch(/effective_until is null or pr\.effective_until > now\(\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL MÍNIMO DE COMPRA VIAJA EN LA MONEDA DEL CLIENTE
//
// El dueño fija su mínimo sobre SU precio, y la base lo exige así
// (`orders_enforce_min_amount` mira `orders.subtotal`). Pero la app compara
// contra un carrito ya con margen: si el mínimo no se inflara igual, un
// carrito de $4,80 del comercio —$5,28 para el cliente— parecería llegar a un
// mínimo de $5 y la base lo rechazaría justo al confirmar.
// ═══════════════════════════════════════════════════════════════════════════
describe('el mínimo de compra con margen', () => {
  const NEGOCIO = {
    id: 'b1', name: 'Local', slug: 'local', type: 'pizzería',
    delivery_fee: 2, prep_time_minutes: 25, delivery_extra_minutes: 10,
    min_order_amount: 5, payment_methods: null,
  }

  it('se infla igual que los precios, para que la comparación siga siendo la misma', () => {
    const conRegla = publicBusiness(NEGOCIO, REGLA(10))
    expect(conRegla.minOrderAmount).toBe(5.5)

    // Equivalencia: un carrito justo en el mínimo del comercio lo sigue estando
    // en la moneda del cliente, y uno por debajo sigue por debajo.
    const enElMinimo = calculatePlatformMarkup(5, REGLA(10)).customerSubtotal
    const porDebajo = calculatePlatformMarkup(4.8, REGLA(10)).customerSubtotal
    expect(enElMinimo).toBeGreaterThanOrEqual(conRegla.minOrderAmount)
    expect(porDebajo).toBeLessThan(conRegla.minOrderAmount)
  })

  it('sin regla, el mínimo es el que puso el dueño', () => {
    expect(publicBusiness(NEGOCIO, null).minOrderAmount).toBe(5)
  })

  // ⚠️ El envío NO lleva margen: se cobra aparte y el margen sale solo de los
  // productos.
  it('el envío no se infla', () => {
    expect(publicBusiness(NEGOCIO, REGLA(10)).deliveryFee).toBe(2)
  })
})
