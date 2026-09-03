import { describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// MENÚ MATA EL ENLACE ANTERIOR
//
// El dueño lo probó (2026-09-03): escribió MENÚ, recibió las categorías… y el
// botón «Ver la carta» de unos mensajes más arriba SEGUÍA abriendo el local
// anterior. Sus palabras: «todo lo de la palabra menú hacia arriba debería
// morirse».
//
// Y no era estético: MENÚ suelta el candado de «un pedido a la vez», así que
// por ese enlace vivo se podía armar un pedido en un local mientras se
// navegaba otro — justo lo que el candado existe para impedir.
//
// ⚠️ CON UNA EXCEPCIÓN que marcó él mismo: quien debe un comprobante o lo
// tiene en revisión CONSERVA su enlace. Ahí la mini app es por donde manda su
// captura; revocárselo le deja un pedido pagado sin forma de rematarlo.
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIAS = [{ code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]

const armar = ({ estado = 'en_local', bloqueado = true } = {}) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: estado,
      selected_business_id: 'biz-1',
      shopping_locked: bloqueado,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 3,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
      storefront_enabled: true, takes_orders: true,
    }),
    getSchedulesFor: vi.fn().mockResolvedValue(new Map()),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    isPlatformBlocked: vi.fn().mockResolvedValue(false),
    isContactBlocked: vi.fn().mockResolvedValue(false),
    cancelUnpaidOrderOnPurpose: vi.fn().mockResolvedValue(1),
    revokeAllStorefrontSessions: vi.fn().mockResolvedValue(2),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      send: async (reply, options) => { enviados.push({ reply, options }) },
      issueLink: vi.fn(), tipoPideEnChat: vi.fn().mockResolvedValue(false),
      avanzarMenu: vi.fn(), crearPedido: vi.fn(), crearPedidoCompleto: vi.fn(),
    },
  }
}

const escribir = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593900000825', text: texto }, deps)
}

describe('MENÚ revoca el enlace anterior', () => {
  it('con un local elegido, mata los enlaces vivos', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    expect(m.database.revokeAllStorefrontSessions).toHaveBeenCalledWith('cli-1')
  })

  it('y también el botón «Empezar de nuevo», que entra por el otro camino', async () => {
    // ⚠️ Su texto normaliza a un COMANDO_MENU, así que llega por la rama de la
    // pregunta de reinicio. Conectar solo una dejaría la mitad sin revocar.
    const m = armar({ estado: 'en_local' })
    m.database.getConversation.mockResolvedValue({
      current_state: 'en_local', selected_business_id: 'biz-1', shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } }, version: 3,
    })
    await escribir(m.deps, '✅ Empezar de nuevo')
    expect(m.database.revokeAllStorefrontSessions).toHaveBeenCalledWith('cli-1')
  })

  // ⚠️ LA EXCEPCIÓN. Sin ella, quien ya transfirió se queda sin la pantalla
  // por donde manda su comprobante.
  it('NO lo revoca a quien debe un comprobante', async () => {
    const m = armar({ estado: 'esperando_comprobante' })
    await escribir(m.deps, 'menu')
    expect(m.database.revokeAllStorefrontSessions).not.toHaveBeenCalled()
  })

  it('ni a quien lo tiene en revisión', async () => {
    const m = armar({ estado: 'pago_en_revision' })
    await escribir(m.deps, 'menu')
    expect(m.database.revokeAllStorefrontSessions).not.toHaveBeenCalled()
  })

  // ─────────────────────────────────────────────────────────────────────
  // LO QUE MENÚ SEGUÍA HACIENDO, Y NO PUEDE DEJAR DE HACER
  //
  // La revocación se AÑADE a ese camino. Estas pruebas existen porque un
  // efecto que se pierde de paso no rompe nada visible: la lección del
  // 2026-08-03, cuando un atajo se llevó el marcar-como-leído sin que
  // ninguna prueba lo notara.
  // ─────────────────────────────────────────────────────────────────────
  it('sigue cancelando el pedido sin pagar', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    expect(m.database.cancelUnpaidOrderOnPurpose).toHaveBeenCalled()
  })

  it('sigue soltando el local y guardando la vista', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    const patch = m.database.advanceConversation.mock.calls.at(-1)?.[1]
    expect(patch.businessId ?? null).toBe(null)
    expect(patch.state).toBe('navegando')
  })

  it('sigue respondiendo con las categorías y la bienvenida de vuelta', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    const texto = m.enviados.map(e => e.reply).join('')
    expect(texto).toContain('vuelta')
    expect(m.enviados.flatMap(e => e.options)).toContain('🍕 Pizzerías')
  })

  // ⚠️ Falla en SILENCIO: es una limpieza, no una defensa. La defensa es el
  // 403 de `readStorefrontSession`.
  it('si la revocación revienta, MENÚ funciona igual', async () => {
    const m = armar({ estado: 'en_local' })
    m.database.revokeAllStorefrontSessions.mockRejectedValue(new Error('base caída'))
    await escribir(m.deps, 'menu')
    expect(m.enviados.flatMap(e => e.options)).toContain('🍕 Pizzerías')
  })
})
