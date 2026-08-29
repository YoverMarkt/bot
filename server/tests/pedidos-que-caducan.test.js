import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// ═══════════════════════════════════════════════════════════════════════════
// EL PEDIDO SIN PAGAR CADUCA SOLO (2026-08-28)
//
// 20 de las 40 cancelaciones de producción murieron en `esperando_pago`. Es la
// PRIMERA tarea de la plataforma que cambia el estado de un pedido sola, y eso
// estaba prohibido a propósito: cada aviso se paga y una tarea automática
// puede mandar cien de golpe. Estas pruebas vigilan los frenos que sustituyen
// a esa prohibición — si alguno cae, vuelve el escenario que se temía.
// ═══════════════════════════════════════════════════════════════════════════

const leer = (n) => readFileSync(fileURLToPath(new URL(`../${n}`, import.meta.url)), 'utf8')
const MIGRACION = leer('migration-2026-08-28-pedidos-que-caducan.sql')
const ESQUEMA = leer('schema.sql')

describe('los frenos de la expiración', () => {
  it('la función existe en la migración y en el consolidado', () => {
    for (const [donde, sql] of [['migración', MIGRACION], ['schema.sql', ESQUEMA]]) {
      expect(sql, donde).toMatch(/create or replace function public\.expire_unpaid_orders/)
      expect(sql, donde).toMatch(/payment_window_minutes/)
    }
  })

  // NUNCA `pago_en_revision`: ahí el cliente YA PAGÓ y espera a que el dueño
  // mire su comprobante. Expirarlo sería quedarse con su dinero.
  it('solo toca `esperando_pago`, jamás un pedido ya pagado', () => {
    const fn = MIGRACION.slice(MIGRACION.indexOf('function public.expire_unpaid_orders'))
    expect(fn).toMatch(/o\.status = 'esperando_pago'/)
    expect(fn, 'un pedido en revisión ya tiene el dinero puesto')
      .not.toMatch(/status\s*(=|in).*pago_en_revision/)
  })

  // Mandó su comprobante: eso ya no es un pedido sin pagar aunque el estado no
  // haya avanzado todavía.
  it('no expira a quien ya mandó comprobante', () => {
    expect(MIGRACION).toMatch(/o\.payment_proof_url is null/)
  })

  // ⚠️ EL FRENO CONTRA «CIEN AVISOS DE GOLPE», que es la razón por la que esta
  // tarea estuvo prohibida hasta hoy.
  it('tiene tope por tanda y NO se puede subir sin límite', () => {
    expect(MIGRACION).toMatch(/limit greatest\(1, least\(coalesce\(p_limite, 20\), 100\)\)/)
  })

  // La ventana superior: sin ella, el día que esto se encienda barrería todo
  // el histórico de una vez.
  it('no barre el histórico: ventana superior de 24 h', () => {
    expect(MIGRACION).toMatch(/o\.created_at > now\(\) - interval '24 hours'/)
  })

  it('el dueño puede apagarlo, y apagado no toca nada', () => {
    expect(MIGRACION).toMatch(/b\.payment_window_minutes > 0/)
    // El 0 es válido en el CHECK: es «no expirar nunca».
    expect(MIGRACION).toMatch(/payment_window_minutes = 0\s*\n\s*or \(payment_window_minutes >= 15/)
  })

  // El de mostrador lo teclea el dueño con la persona delante: no hay ningún
  // pago que esperar por WhatsApp.
  it('solo pedidos de la tienda', () => {
    expect(MIGRACION).toMatch(/coalesce\(o\.source, ''\) = 'storefront'/)
  })

  // Reutiliza la máquina de estados en vez de un `update` propio: así deja
  // rastro en `order_events` y reclama el aviso con el mismo mecanismo.
  it('pasa por set_order_status, no escribe el estado a mano', () => {
    const fn = MIGRACION.slice(MIGRACION.indexOf('function public.expire_unpaid_orders'))
    expect(fn).toMatch(/perform public\.set_order_status\([^)]*'expirado'\)/)
    expect(fn, 'un update a mano se saltaría order_events y el reclamo')
      .not.toMatch(/update public\.orders\s+set\s+status/)
  })

  // Un pedido que no se pueda expirar no puede tumbar la tanda entera.
  it('un fallo suelto no rompe el barrido', () => {
    expect(MIGRACION).toMatch(/exception when others then[\s\S]{0,200}null;/)
  })
})

describe('el aviso de expiración', () => {
  const notify = () => import('../dist/services/order-notify.js')

  it('`expirado` avisa al cliente', async () => {
    const { HITOS_QUE_SE_AVISAN, seAvisa } = await notify()
    expect(HITOS_QUE_SE_AVISAN).toContain('expirado')
    expect(seAvisa('expirado')).toBe(true)
  })

  // ⚠️ El gasto no se multiplica: un pedido expirado no recibe ninguno de los
  // otros hitos. Si esta lista crece, crece la factura de TODOS los negocios.
  it('la lista de hitos sigue siendo exactamente la pactada', async () => {
    const { HITOS_QUE_SE_AVISAN } = await notify()
    expect([...HITOS_QUE_SE_AVISAN].sort()).toEqual([
      'cancelado', 'completado', 'en_camino', 'expirado',
      'listo_para_retiro', 'preparacion', 'rechazado',
    ])
  })

  // El cliente no hizo nada malo: se le pasó el tiempo. Decirle «tu pedido fue
  // cancelado» a secas le deja pensando que el local le falló.
  it('el texto invita a volver a pedir, no le echa la culpa', async () => {
    const { textoDelAviso } = await notify()
    const texto = textoDelAviso(
      { name: 'Monster Pizza', phone: null },
      { order_number: 42, order_items: [], total: 10, currency: 'USD' },
      'expirado',
    )
    expect(texto).toBeTruthy()
    expect(texto).toMatch(/comprobante/i)
    expect(texto).toMatch(/volver a pedirlo|MENÚ/i)
    expect(texto, 'no puede sonar a reproche').not.toMatch(/no pagaste|incumpl/i)
  })
})

describe('el barrido', () => {
  // ⚠️ `createRequire` y no `import`: el servidor es CommonJS, y solo así se
  // espía el MISMO objeto que usa el código. Con el import de ESM se espía una
  // copia y el mock no llega — el barrido caía a su `catch` y devolvía 0.
  const cargar = () => {
    const req = createRequire(import.meta.url)
    return {
      mod: req('../dist/services/order-expiry.js'),
      db: req('../dist/db'),
      notice: req('../dist/services/order-status-notice.js'),
    }
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('avisa a cada cliente cuyo pedido expiró', async () => {
    const { mod, db, notice } = cargar()
    vi.spyOn(db, 'expireUnpaidOrders').mockResolvedValue([
      { order_id: 'ord-1', business_id: 'biz-1', order_number: 7 },
      { order_id: 'ord-2', business_id: 'biz-1', order_number: 8 },
    ])
    const aviso = vi.spyOn(notice, 'avisarAlCliente').mockResolvedValue(undefined)
    // La falta se anota antes de avisar, para que el mensaje pueda decir
    // cuántas van y si esta fue la última.
    const anotar = vi.spyOn(db, 'registerUnpaidExpiry')
      .mockResolvedValue({ strikes: 1, blocked: false, limit: 3 })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(mod.expireUnpaidOrders()).resolves.toBe(2)
    expect(aviso).toHaveBeenCalledTimes(2)
    expect(anotar).toHaveBeenCalledTimes(2)
    // El estado del aviso es `expirado`, no `cancelado`: son mensajes distintos.
    expect(aviso).toHaveBeenCalledWith('biz-1', 'ord-1', 'expirado', { strikes: 1, blocked: false, limit: 3 })
    expect(aviso).toHaveBeenCalledWith('biz-1', 'ord-2', 'expirado', { strikes: 1, blocked: false, limit: 3 })
  })

  // ⚠️ El registro de la falta NO puede impedir el aviso: el pedido ya caducó
  // y enterarse es lo que no puede faltar. `registerUnpaidExpiry` devuelve
  // ceros si algo va mal, y el aviso los lee como «nada que advertir».
  it('si no se puede anotar la falta, el cliente se entera igual', async () => {
    const { mod, db, notice } = cargar()
    vi.spyOn(db, 'expireUnpaidOrders').mockResolvedValue([
      { order_id: 'ord-1', business_id: 'biz-1', order_number: 7 },
    ])
    const aviso = vi.spyOn(notice, 'avisarAlCliente').mockResolvedValue(undefined)
    vi.spyOn(db, 'registerUnpaidExpiry').mockResolvedValue({ strikes: 0, blocked: false, limit: 3 })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(mod.expireUnpaidOrders()).resolves.toBe(1)
    expect(aviso).toHaveBeenCalledTimes(1)
  })

  it('sin nada que expirar no manda un solo mensaje', async () => {
    const { mod, db, notice } = cargar()
    vi.spyOn(db, 'expireUnpaidOrders').mockResolvedValue([])
    const aviso = vi.spyOn(notice, 'avisarAlCliente').mockResolvedValue(undefined)
    await expect(mod.expireUnpaidOrders()).resolves.toBe(0)
    expect(aviso).not.toHaveBeenCalled()
  })

  // ⚠️ El tope por tanda es el freno contra los cien avisos de golpe: si
  // alguien lo sube aquí, vuelve el escenario que la vieja prohibición temía.
  it('pide como mucho 20 por pasada', async () => {
    const { mod, db } = cargar()
    const barrido = vi.spyOn(db, 'expireUnpaidOrders').mockResolvedValue([])
    await mod.expireUnpaidOrders()
    expect(barrido).toHaveBeenCalledWith(20)
  })

  it('nunca lanza: corre en un setInterval', async () => {
    const { mod, db } = cargar()
    vi.spyOn(db, 'expireUnpaidOrders').mockRejectedValue(new Error('base caída'))
    await expect(mod.expireUnpaidOrders()).resolves.toBe(0)
  })

  // Un fallo enviando un aviso no puede dejar sin avisar a los demás… pero
  // tampoco puede tumbar el proceso.
  it('si un aviso revienta, el barrido no tumba el servidor', async () => {
    const { mod, db, notice } = cargar()
    vi.spyOn(db, 'expireUnpaidOrders').mockResolvedValue([
      { order_id: 'ord-1', business_id: 'biz-1', order_number: 7 },
    ])
    vi.spyOn(notice, 'avisarAlCliente').mockRejectedValue(new Error('canal caído'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(mod.expireUnpaidOrders()).resolves.toBe(0)
  })
})
