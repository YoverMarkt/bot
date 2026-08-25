import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crearWorkerDeAvisos } from '../dist/services/outbox-worker.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO QUE FALLA SE REINTENTA
//
// Hoy el aviso se RECLAMA antes de enviarse. El reclamo es atómico y existe
// para que dos toques no manden —ni cobren— dos mensajes. La consecuencia que
// no se veía: si el envío falla, el reclamo ya se consumió y ese aviso no sale
// nunca más.
//
// Cada mensaje cuesta dinero desde el 1 de octubre, así que lo que más se
// vigila aquí es lo contrario del reintento: que NUNCA se mande dos veces.
// ═══════════════════════════════════════════════════════════════════════════

const SQL = readFileSync(
  fileURLToPath(new URL('../migration-2026-08-21-outbox-de-avisos.sql', import.meta.url)),
  'utf8',
)
// ⚠️ El aviso vivía dentro de `routes/orders.routes.ts` y se movió a su
// propio servicio el 2026-08-28, sin tocar su cuerpo: ahora también lo usa el
// barrido que expira los pedidos sin pagar, y duplicarlo daría dos sitios
// donde arreglar cada fallo de lo que se paga. Estas comprobaciones siguen
// vigilando exactamente lo mismo, solo que en su archivo nuevo.
const RUTA = readFileSync(
  fileURLToPath(new URL('../src/services/order-status-notice.ts', import.meta.url)),
  'utf8',
)

const evento = (extra = {}) => ({
  id: 'ev-1', business_id: 'biz-1', aggregate_id: 'ord-1',
  payload: { status: 'preparacion' }, lease_token: 'tok-1', ...extra,
})

const deps = (over = {}) => ({
  lease: vi.fn().mockResolvedValue([evento()]),
  complete: vi.fn().mockResolvedValue(true),
  fail: vi.fn().mockResolvedValue('reintentar'),
  pedido: vi.fn().mockResolvedValue({ id: 'ord-1', contact_phone: '+593999000001' }),
  negocio: vi.fn().mockResolvedValue({ id: 'biz-1', name: 'Local' }),
  enviar: vi.fn().mockResolvedValue(true),
  registrar: vi.fn(),
  ...over,
})

describe('el worker de avisos', () => {
  it('envía lo que quedó pendiente y lo cierra', async () => {
    const d = deps()
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 1, fallidos: 0, muertos: 0 })
    expect(d.enviar).toHaveBeenCalledOnce()
    expect(d.complete).toHaveBeenCalledWith('ev-1', 'tok-1')
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('si vuelve a fallar, lo devuelve a la cola en vez de perderlo', async () => {
    const d = deps({ enviar: vi.fn().mockResolvedValue(false) })
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 0, fallidos: 1, muertos: 0 })
    expect(d.complete).not.toHaveBeenCalled()
    expect(d.fail).toHaveBeenCalledOnce()
  })

  it('cuenta como muerto lo que ya no puede salir, sin gastar seis intentos', async () => {
    // Un pedido borrado no va a reaparecer: reintentarlo solo retrasa el resto
    // de la cola.
    const d = deps({ pedido: vi.fn().mockResolvedValue(null) })
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 0, fallidos: 0, muertos: 1 })
    expect(d.enviar).not.toHaveBeenCalled()
    expect(d.fail).toHaveBeenCalledOnce()
  })

  it('NO reclama nada: el reclamo se gastó cuando cambió el estado', async () => {
    // Volver a reclamar impediría el reintento, que es justo para lo que este
    // worker existe.
    const d = deps()
    await crearWorkerDeAvisos(d)()
    expect(d.pedido).toHaveBeenCalledWith('biz-1', 'ord-1')
    const fuente = readFileSync(
      fileURLToPath(new URL('../src/services/outbox-worker.ts', import.meta.url)), 'utf8',
    )
    expect(fuente).not.toMatch(/claimOrderNotification/)
  })

  it('un evento sin lease se salta: sin token no se puede cerrar ni fallar', async () => {
    const d = deps({ lease: vi.fn().mockResolvedValue([evento({ lease_token: null })]) })
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 0, fallidos: 0, muertos: 0 })
    expect(d.enviar).not.toHaveBeenCalled()
  })

  it('un fallo al enviar no tumba el resto de la tanda', async () => {
    const d = deps({
      lease: vi.fn().mockResolvedValue([evento(), evento({ id: 'ev-2', lease_token: 'tok-2' })]),
      enviar: vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(true),
    })
    const r = await crearWorkerDeAvisos(d)()
    expect(r.enviados).toBe(1)
    expect(r.fallidos).toBe(1)
    expect(d.registrar).toHaveBeenCalledOnce()
  })
})

describe('nunca se manda el mismo aviso dos veces', () => {
  it('el mismo hito solo se encola una vez, y lo impide la BASE', () => {
    expect(SQL).toContain('uq_outbox_hito')
    expect(SQL).toMatch(/aggregate_id, event_type, \(payload ->> 'status'\)/)
    expect(SQL).toContain('on conflict do nothing')
  })

  it('el evento nace con ventana de gracia', () => {
    // ⚠️ Sin ella el worker podría tomarlo mientras el envío inmediato está en
    // vuelo, y el cliente recibiría —y el negocio pagaría— dos mensajes.
    expect(SQL).toMatch(/p_espera_s\s+integer default 60/)
    expect(SQL).toMatch(/available_at.*make_interval/s)
  })

  it('la ruta encola ANTES de enviar y solo cierra si salió', () => {
    const cuerpo = RUTA.slice(RUTA.indexOf('const avisarAlCliente'))
    const encolar = cuerpo.indexOf('enqueueOutboxEvent')
    const enviar = cuerpo.indexOf('notificarCambioDePedido(negocio')
    const cerrar = cuerpo.indexOf('completeOutboxEvent')
    expect(encolar).toBeGreaterThan(0)
    expect(enviar, 'encolar va antes de enviar').toBeGreaterThan(encolar)
    expect(cerrar, 'cerrar va después de enviar').toBeGreaterThan(enviar)
    expect(cuerpo).toMatch(/if \(enviado && evento\)/)
  })

  it('encolar no puede impedir el aviso', () => {
    // Si la cola falla, el mensaje sale igual: el pedido ya está en la cocina.
    expect(RUTA).toMatch(/enqueueOutboxEvent\([\s\S]{0,260}?\}\)\.catch\(\(\) => null\)/)
  })
})

describe('la cola no se atasca sola', () => {
  it('dos workers no se pelean por el mismo evento', () => {
    expect(SQL).toContain('for update skip locked')
  })

  it('recupera lo que dejó tomado un worker que murió', () => {
    expect(SQL).toMatch(/status = 'processing' and e\.leased_until < now\(\)/)
  })

  it('la espera entre intentos crece, y tiene techo', () => {
    // Reintentar cada segundo contra un canal caído no lo arregla y sí gasta.
    expect(SQL).toMatch(/least\(3600, 60 \* power\(2/)
  })

  it('lo que no sale en varios intentos muere en vez de girar para siempre', () => {
    expect(SQL).toContain("status = 'dead'")
    expect(SQL).toMatch(/attempts >= v_fila\.max_attempts/)
  })

  it('la tabla lleva business_id y RLS, como toda tabla de negocio', () => {
    expect(SQL).toMatch(/business_id\s+uuid not null references public\.businesses\(id\) on delete cascade/)
    expect(SQL).toContain('alter table public.outbox_events enable row level security')
    expect(SQL).toMatch(/revoke all on table public\.outbox_events\s+from public, anon, authenticated, service_role/)
  })
})
