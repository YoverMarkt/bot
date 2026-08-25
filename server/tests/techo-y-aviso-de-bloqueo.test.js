import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// PEDIR SUELTA EL TECHO · AL BLOQUEADO SE LE EXPLICA UNA VEZ
//
// Las dos decisiones del 2026-08-25, leídas del SQL. Se comprueban aquí porque
// son afirmaciones sobre la BASE —cuándo dispara, qué toca y qué no—, y un
// cambio de una palabra en la migración las invierte sin que nada más avise.
// ═══════════════════════════════════════════════════════════════════════════

const leer = (nombre) => readFileSync(
  fileURLToPath(new URL(`../${nombre}`, import.meta.url)), 'utf8',
)

const MIGRACION = leer('migration-2026-08-27-techo-y-aviso-de-bloqueo.sql')
const ESQUEMA = leer('schema.sql')

describe('pedir suelta el techo', () => {
  // Armar un pedido dentro del chat son 15-25 mensajes: quien pedía dos veces
  // en la misma hora se comía el techo de 25 y quedaba mudo 12 h.
  it('el disparador existe en la migración y en el consolidado', () => {
    for (const [donde, sql] of [['migración', MIGRACION], ['schema.sql', ESQUEMA]]) {
      expect(sql, donde).toMatch(/create trigger orders_reset_marketplace_reply/)
      expect(sql, donde).toMatch(/create or replace function public\.orders_reset_marketplace_reply/)
    }
  })

  // AFTER y no BEFORE: el pedido ya está en la cocina, y no puede caerse
  // porque no se pudiera soltar un contador. Es el fallo del 2026-08-02 al
  // revés, y por eso se comprueba.
  it('dispara DESPUÉS de insertar, nunca antes', () => {
    expect(MIGRACION).toMatch(
      /create trigger orders_reset_marketplace_reply\s+after insert on public\.orders/,
    )
    expect(MIGRACION).not.toMatch(
      /create trigger orders_reset_marketplace_reply\s+before/,
    )
  })

  // Si bastara con pedir para recuperar la voz, el silenciado haría un pedido
  // falso y volvería a empezar. Solo se evita ACUMULAR mientras se compra.
  it('NO levanta un silencio ya activo', () => {
    const cuerpo = MIGRACION.slice(
      MIGRACION.indexOf('function public.orders_reset_marketplace_reply'),
      MIGRACION.indexOf('create trigger orders_reset_marketplace_reply'),
    )
    expect(cuerpo).toMatch(/reply_count = 0/)
    expect(cuerpo).toMatch(/reply_window_start = null/)
    expect(cuerpo, 'pedir no puede levantar el silencio').not.toMatch(/muted_until\s*=/)
  })

  // El de MOSTRADOR lo teclea el dueño con la persona delante: no puede ser
  // una vía para soltarle el contador a nadie. Mismo criterio que los frenos.
  it('solo cuenta para los pedidos de la tienda', () => {
    expect(MIGRACION).toMatch(/coalesce\(new\.source, ''\) <> 'storefront'/)
  })

  it('falla ABIERTO: nunca tumba el pedido', () => {
    const cuerpo = MIGRACION.slice(
      MIGRACION.indexOf('function public.orders_reset_marketplace_reply'),
      MIGRACION.indexOf('create trigger orders_reset_marketplace_reply'),
    )
    expect(cuerpo).toMatch(/exception when others then[\s\S]*return new;/)
  })

  // La función del dinero no se recrea por un añadido: misma regla que
  // `orders_reject_blocked`, `orders_stamp_pricing` y los frenos del #269/#270.
  it('no recrea create_storefront_order', () => {
    expect(MIGRACION).not.toMatch(/create or replace function public\.create_storefront_order/)
  })
})

describe('el aviso al bloqueado', () => {
  it('la columna y la función están en los dos sitios', () => {
    for (const [donde, sql] of [['migración', MIGRACION], ['schema.sql', ESQUEMA]]) {
      expect(sql, donde).toMatch(/blocked_notified_at/)
      expect(sql, donde).toMatch(/function public\.claim_blocked_notice/)
    }
  })

  // Entre un `select` previo y la escritura caben dos mensajes del mismo
  // cliente, y el aviso saldría —y se pagaría— dos veces. Mismo patrón que
  // `customer_notified_status`.
  it('reclama DENTRO del update, no consulta antes', () => {
    const fn = MIGRACION.slice(MIGRACION.indexOf('function public.claim_blocked_notice'))
    expect(fn).toMatch(/update public\.business_customers[\s\S]*blocked_notified_at is null[\s\S]*returning true/)
    expect(fn, 'no puede mirar antes de escribir').not.toMatch(/select[\s\S]{0,120}from public\.business_customers/)
  })

  // Solo se explica a quien está bloqueado DE VERDAD: sin esta condición, la
  // primera visita de cualquier cliente gastaría el reclamo.
  it('solo reclama si hay bloqueo', () => {
    const fn = MIGRACION.slice(MIGRACION.indexOf('function public.claim_blocked_notice'))
    expect(fn).toMatch(/blocked_at is not null/)
  })

  // Si el dueño lo vuelve a bloquear, es una decisión NUEVA y merece su propia
  // explicación. Sin esto, el segundo bloqueo sería mudo para siempre.
  it('desbloquear limpia la marca', () => {
    const repo = leer('src/db/repositories/storefront.ts')
    const fn = repo.slice(repo.indexOf('const setContactBlocked'))
    expect(fn.slice(0, 900)).toMatch(/blocked_notified_at: null/)
  })
})
