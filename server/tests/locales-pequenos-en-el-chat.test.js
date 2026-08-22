import { describe, expect, it, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// LA REGLA DE LOS 20
//
// Local pequeño → se pide DENTRO del chat, eligiendo de una lista.
// Local grande  → se manda el enlace de su tienda.
//
// ⚠️ Lo decide el CATÁLOGO REAL, contado al elegir el local. No el tipo de
// negocio ni una estimación del alta: al crear un local tiene CERO productos
// (`apply_business_template` siembra categorías y grupos, no productos), así
// que en el alta no hay nada que contar.
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIAS = [
  { code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
]
const LOCAL = {
  id: 'biz-1', slug: 'donia-maria', name: 'Almuerzos Doña María',
  type: 'pizzería', prep_min: 25,
}

const armar = ({ productos = 5, maximo = 20, estadoMenu = null } = {}) => {
  const conversacion = { valor: null }
  const guardados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: null }),
    getConversation: vi.fn(async () => conversacion.valor),
    advanceConversation: vi.fn(async (_id, patch) => {
      guardados.push(patch)
      conversacion.valor = {
        current_state: patch.state || 'navegando',
        selected_business_id: patch.clearBusiness
          ? null
          : (patch.businessId ?? conversacion.valor?.selected_business_id ?? null),
        shopping_locked: false,
        flow_state: patch.flowState ?? conversacion.valor?.flow_state ?? null,
        version: (conversacion.valor?.version || 0) + 1,
      }
      return { conflicto: false }
    }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([LOCAL]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Almuerzos Doña María', slug: 'donia-maria',
      storefront_enabled: true, takes_orders: true,
    }),
    countProducts: vi.fn().mockResolvedValue(productos),
    getProducts: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Almuerzo completo', price: 3.5, active: true },
    ]),
    getMenuModifiers: vi.fn().mockResolvedValue([]),
    getLastOrderForContact: vi.fn().mockResolvedValue(null),
    getPolicies: vi.fn().mockResolvedValue({ welcome_message: null }),
  }
  const enviados = []
  const avanzarMenu = vi.fn(() => ({
    resultado: { reply: '¿Qué deseas?', options: ['🛒 Hacer un pedido'] },
    estado: estadoMenu ?? { view: { kind: 'main' }, cart: [], updatedAt: 1 },
  }))
  return {
    conversacion, database, enviados, guardados, avanzarMenu,
    deps: {
      database,
      issueLink: vi.fn().mockResolvedValue('https://umbani.app/t/donia-maria?k=abc'),
      send: async (reply, options) => { enviados.push({ reply, options }) },
      maxProductosEnChat: async () => maximo,
      avanzarMenu,
      crearPedido: vi.fn().mockResolvedValue(true),
      logger: { log: () => {} },
    },
  }
}

let handle
beforeEach(async () => {
  ({ handleMarketplaceMessage: handle } = await import('../dist/services/marketplace-entry.js'))
})

/** Lleva la conversación hasta justo antes de elegir el local. */
const hastaElLocal = async (ctx) => {
  await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
  await handle({ from: '593990978367', text: 'Pizzerías' }, ctx.deps)
}

describe('el umbral decide cómo se pide', () => {
  it('con 5 productos se pide en el CHAT, sin mandar enlace', async () => {
    const ctx = armar({ productos: 5 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)

    expect(ctx.avanzarMenu).toHaveBeenCalled()
    expect(ctx.deps.issueLink).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).reply).not.toContain('http')
  })

  it('con 50 productos se manda el ENLACE', async () => {
    const ctx = armar({ productos: 50 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)

    expect(ctx.deps.issueLink).toHaveBeenCalled()
    expect(ctx.avanzarMenu).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).reply).toContain('https://umbani.app/t/donia-maria?k=abc')
  })

  it('justo EN el umbral se pide en el chat', async () => {
    const ctx = armar({ productos: 20, maximo: 20 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)
    expect(ctx.avanzarMenu).toHaveBeenCalled()
  })

  it('uno por encima ya manda el enlace', async () => {
    const ctx = armar({ productos: 21, maximo: 20 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)
    expect(ctx.deps.issueLink).toHaveBeenCalled()
  })

  it('un local SIN productos manda el enlace, no un menú vacío', async () => {
    // Un catálogo vacío en el chat sería una lista sin opciones: el cliente
    // se queda mirando un menú que no ofrece nada.
    const ctx = armar({ productos: 0 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)
    expect(ctx.deps.issueLink).toHaveBeenCalled()
    expect(ctx.avanzarMenu).not.toHaveBeenCalled()
  })

  it('si CONTAR falla se manda el enlace: la tienda atiende cualquier catálogo', async () => {
    // Se falla hacia lo que siempre funciona. Un menú de chat con cientos de
    // productos sería inusable; la mini app no.
    const ctx = armar({ productos: 5 })
    ctx.database.countProducts.mockRejectedValue(new Error('base caída'))
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)
    expect(ctx.deps.issueLink).toHaveBeenCalled()
  })

  it('el umbral sale de la configuración, no está fijo en el código', async () => {
    // Con el umbral en 3, un local de 5 productos ya va al enlace.
    const ctx = armar({ productos: 5, maximo: 3 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)
    expect(ctx.deps.issueLink).toHaveBeenCalled()
  })
})

describe('el carrito sobrevive a un despliegue', () => {
  it('el estado del menú se GUARDA en la conversación, no en memoria', async () => {
    // ⚠️ `bot-menu-flow` guarda su estado en un `Map` que se pierde en cada
    // arranque y que con dos instancias lleva dos cuentas del mismo carrito.
    // En el marketplace vive en `marketplace_conversations.flow_state`.
    const ctx = armar({ productos: 5 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)

    const conMenu = ctx.guardados.filter(p => p.flowState?.menu)
    expect(conMenu.length).toBeGreaterThan(0)
    expect(conMenu.at(-1).flowState.menu).toMatchObject({ view: { kind: 'main' } })
  })

  it('y se vuelve a CARGAR en el mensaje siguiente', async () => {
    const carrito = {
      view: { kind: 'products' },
      cart: [{ name: 'Almuerzo completo', qty: 2 }],
      updatedAt: 1,
    }
    const ctx = armar({ productos: 5, estadoMenu: carrito })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'pidiendo',
      selected_business_id: 'biz-1',
      shopping_locked: false,
      flow_state: { menu: carrito },
      version: 4,
    })

    await handle({ from: '593990978367', text: '2' }, ctx.deps)

    // El segundo argumento de `avanzarMenu` es el estado previo: si llegara
    // nulo, el cliente perdería su carrito en cada mensaje.
    expect(ctx.avanzarMenu).toHaveBeenCalledWith(
      expect.objectContaining({ message: '2' }),
      carrito,
    )
  })
})

describe('el pedido dentro del chat', () => {
  const conPedidoConfirmado = ctx => {
    ctx.avanzarMenu.mockReturnValue({
      resultado: {
        reply: 'Resumen…',
        options: [],
        action: {
          type: 'order',
          summary: '2 × Almuerzo completo',
          totalCents: 700,
          payload: '##PEDIDO:Almuerzo completo x 2##',
          items: [{ name: 'Almuerzo completo', qty: 2 }],
        },
      },
      estado: { view: { kind: 'main' }, cart: [], updatedAt: 1 },
    })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'pidiendo',
      selected_business_id: 'biz-1',
      shopping_locked: false,
      flow_state: { menu: { view: { kind: 'cart' }, cart: [], updatedAt: 1 } },
      version: 5,
    })
  }

  it('se crea por el MISMO camino del dinero que el canal propio', async () => {
    const ctx = armar({ productos: 5 })
    conPedidoConfirmado(ctx)
    await handle({ from: '593990978367', text: '✅ Confirmar pedido' }, ctx.deps)

    // El total oficial lo calcula `money.ts` con las RPC atómicas. El menú
    // solo aporta QUÉ pidió, nunca un monto (regla #8).
    expect(ctx.deps.crearPedido).toHaveBeenCalledWith(expect.objectContaining({
      phone: '593990978367',
      items: [{ name: 'Almuerzo completo', qty: 2 }],
    }))
  })

  it('si el pedido no se pudo confirmar, se dice y NO se invita a reenviar', async () => {
    const ctx = armar({ productos: 5 })
    conPedidoConfirmado(ctx)
    ctx.deps.crearPedido.mockResolvedValue(false)
    await handle({ from: '593990978367', text: '✅ Confirmar pedido' }, ctx.deps)

    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).toMatch(/no.*duplicarlo|no lo envíes otra vez/i)
  })
})

describe('lo que no cambia', () => {
  it('MENÚ sigue funcionando en medio de un pedido por chat', async () => {
    // Es la única salida del cliente y no puede depender de dónde esté.
    const ctx = armar({ productos: 5 })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'pidiendo',
      selected_business_id: 'biz-1',
      shopping_locked: false,
      flow_state: { menu: { view: { kind: 'cart' }, cart: [], updatedAt: 1 } },
      version: 6,
    })
    await handle({ from: '593990978367', text: 'menú' }, ctx.deps)
    expect(ctx.avanzarMenu).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).options).toEqual(['🍕 Pizzerías'])
  })

  it('si el local desaparece a media compra se dice, con salida', async () => {
    const ctx = armar({ productos: 5 })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'pidiendo',
      selected_business_id: 'biz-1',
      shopping_locked: false,
      flow_state: { menu: null },
      version: 7,
    })
    ctx.database.getBusinessById.mockResolvedValue(null)
    await handle({ from: '593990978367', text: '1' }, ctx.deps)
    expect(ctx.enviados.at(-1).reply).toMatch(/MENÚ/)
  })
})
