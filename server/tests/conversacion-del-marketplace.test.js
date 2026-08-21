import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const cliente = require('../dist/db/client')

// ═══════════════════════════════════════════════════════════════════════════
// LA CONVERSACIÓN DEL MARKETPLACE
//
// Con un solo número, el teléfono ya no dice de qué negocio es un mensaje: lo
// dice esta conversación. Lo que se prueba aquí es lo que se rompe en silencio:
//
//   · que el ámbito de búsqueda se DERIVE y no se guarde —dos campos podrían
//     contradecirse y habría que decidir cuál miente—;
//   · que el bloqueo optimista no se pise cuando llegan dos mensajes a la vez;
//   · y que la tabla siga siendo la única sin `business_id` A PROPÓSITO, con
//     su blindaje intacto. Eso último lo comprueba de verdad
//     `tests/sql/verificar-aislamiento.sql` contra PostgreSQL; aquí se vigila
//     que el texto del esquema no pierda el blindaje sin que nadie se entere.
// ═══════════════════════════════════════════════════════════════════════════

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const leer = nombre => readFileSync(`${serverDir}/${nombre}`, 'utf8')
const MIGRACION = leer('migration-2026-08-20-conversacion-del-marketplace.sql')
const SCHEMA = leer('schema.sql')
const AISLAMIENTO = leer('tests/sql/verificar-aislamiento.sql')
const sinComentarios = sql => sql.replace(/--[^\n]*/g, '')

afterEach(() => { vi.restoreAllMocks() })

describe('el ámbito de búsqueda se deriva, no se guarda', () => {
  it('sin local elegido busca en todo el marketplace', () => {
    expect(db.searchScopeFor({ selected_business_id: null })).toBe('global')
    expect(db.searchScopeFor(null)).toBe('global')
  })

  it('con local elegido busca solo dentro de ese local', () => {
    // «También quiero Coca Cola» no puede traer la Coca Cola de otro negocio.
    expect(db.searchScopeFor({ selected_business_id: 'biz-1' })).toBe('current_business')
  })
})

describe('avanzar la conversación', () => {
  it('manda el cambio y la versión esperada en una sola llamada', async () => {
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({
      data: { conflicto: false, version: 4 }, error: null,
    })

    await db.advanceConversation('cust-1', {
      state: 'en_negocio', businessId: 'biz-1', shoppingLocked: true,
    }, 3)

    expect(rpc).toHaveBeenCalledWith('advance_marketplace_conversation', {
      p_customer_id: 'cust-1',
      p_expected_version: 3,
      p_state: 'en_negocio',
      p_business_id: 'biz-1',
      p_clear_business: false,
      p_shopping_locked: true,
      p_flow_state: null,
      p_clear_flow: false,
    })
  })

  it('lo que no se nombra no se toca', async () => {
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({
      data: { conflicto: false }, error: null,
    })

    await db.advanceConversation('cust-1')

    const [, argumentos] = rpc.mock.calls[0]
    // Sin versión esperada = primer mensaje: no hay nada que pueda pisarse.
    expect(argumentos.p_expected_version).toBeNull()
    for (const campo of ['p_state', 'p_business_id', 'p_shopping_locked', 'p_flow_state']) {
      expect(argumentos[campo], campo).toBeNull()
    }
    expect(argumentos.p_clear_business).toBe(false)
    expect(argumentos.p_clear_flow).toBe(false)
  })

  it('soltar el local es explícito: un nulo significaría «no lo toques»', async () => {
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({
      data: { conflicto: false }, error: null,
    })
    await db.advanceConversation('cust-1', { clearBusiness: true })
    expect(rpc.mock.calls[0][1].p_clear_business).toBe(true)
  })

  it('devuelve el conflicto tal cual para que el llamador reintente', async () => {
    vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: { conflicto: true }, error: null })
    expect(await db.advanceConversation('cust-1', { state: 'inicio' }, 2))
      .toEqual({ conflicto: true })
  })

  it('un fallo de la base sube, no se traga', async () => {
    vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: null, error: { message: 'sin conexión' } })
    await expect(db.advanceConversation('cust-1')).rejects.toThrow('sin conexión')
  })
})

describe('la tabla es la única sin business_id, y está blindada', () => {
  it('no lleva business_id, y lleva su justificación escrita', () => {
    const tabla = MIGRACION.slice(
      MIGRACION.indexOf('create table if not exists public.marketplace_conversations'),
      MIGRACION.indexOf('create unique index'),
    )
    expect(sinComentarios(tabla)).not.toMatch(/\bbusiness_id\b/)
    // `selected_business_id` es otra cosa: dónde está AHORA, y es anulable.
    expect(tabla).toContain('selected_business_id')
    expect(tabla).toContain('on delete set null')
  })

  it('mantiene el blindaje más estricto del proyecto, en los dos archivos', () => {
    for (const [nombre, sql] of [['migración', MIGRACION], ['schema.sql', SCHEMA]]) {
      expect(sql, nombre).toMatch(
        /alter table public\.marketplace_conversations enable row level security/,
      )
      // ⚠️ `service_role` salta la RLS, así que sin quitarle el acceso a mano
      // la RLS no le aplicaría.
      expect(sql, nombre).toMatch(
        /revoke all on table public\.marketplace_conversations\s+from public, anon, authenticated, service_role/,
      )
    }
  })

  it('el verificador de aislamiento la vigila de verdad', () => {
    // Sin esto el blindaje se podría perder en un refactor y nadie lo vería.
    expect(AISLAMIENTO).toContain('marketplace_conversations')
    expect(AISLAMIENTO).toMatch(/has_table_privilege\([\s\S]{0,80}marketplace_conversations/)
    expect(AISLAMIENTO).toContain('FUGA GRAVE')
  })

  it('un cliente no puede quedarse bloqueado en ningún negocio', () => {
    // Estar «comprando» sin local no significa nada, y dejaría al cliente sin
    // poder empezar otro pedido. Se prohíbe en la base.
    expect(MIGRACION).toContain('marketplace_conversations_bloqueo_check')
    expect(MIGRACION).toMatch(
      /shopping_locked = false or selected_business_id is not null/,
    )
  })

  it('borrar un negocio reinicia la conversación en vez de romperla', () => {
    // `on delete set null` dejaría el estado imposible y haría fallar el
    // borrado. El disparador reinicia antes, que es lo que de verdad se quiere.
    expect(MIGRACION).toContain('businesses_reset_marketplace_conversations')
    expect(MIGRACION).toMatch(/before delete on public\.businesses/)
    const cuerpo = MIGRACION.slice(
      MIGRACION.indexOf('marketplace_conversations_reset_on_business_delete'),
    )
    expect(cuerpo).toMatch(/shopping_locked\s*=\s*false/)
    expect(cuerpo).toMatch(/current_state\s*=\s*'inicio'/)
  })

  it('no recrea ninguna función del dinero ni toca conversation_sessions', () => {
    const ejecutable = sinComentarios(MIGRACION)
    expect(ejecutable).not.toMatch(/create_storefront_order|set_order_status/)
    expect(ejecutable).not.toMatch(/alter table[^\n;]*conversation_sessions/)
  })

  it('no abre su propia transacción: la pone el ejecutor', () => {
    expect(sinComentarios(MIGRACION)).not.toMatch(/^\s*(begin|commit)\s*;/im)
  })
})
