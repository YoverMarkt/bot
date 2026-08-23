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
  // ⚠️ El tipo tiene que CUADRAR con el nombre desde el 2026-08-23: es lo
  // que decide si se pide en el chat o por enlace. Antes decía 'pizzería'
  // en un local de almuerzos, y no pasaba nada porque el tipo no se miraba.
  type: 'almuerzos', prep_min: 25,
}

const armar = ({ enChat = true, estadoMenu = null } = {}) => {
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
    getProducts: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Almuerzo completo', price: 3.5, active: true },
    ]),
    getMenuModifiers: vi.fn().mockResolvedValue([]),
    getLastOrderForContact: vi.fn().mockResolvedValue(null),
    getPolicies: vi.fn().mockResolvedValue({ welcome_message: null }),
    createCustomerAddress: vi.fn().mockResolvedValue({ id: 'dir-1' }),
    getStorefrontPaymentMethods: vi.fn().mockResolvedValue([
      { code: 'transferencia', label: 'Transferencia bancaria', help_text: null, is_prepaid: true, requires_proof: true },
      { code: 'efectivo', label: 'Efectivo (contra entrega)', help_text: 'Paga al recibir.', is_prepaid: false, requires_proof: false },
    ]),
    getBusinessBankAccount: vi.fn().mockResolvedValue({
      bank_name: 'Banco Pichincha',
      account_type: 'corriente',
      account_number: '2203344556',
      holder_name: 'Almuerzos Doña María',
      instructions: null,
    }),
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
      tipoPideEnChat: vi.fn().mockResolvedValue(enChat),
      avanzarMenu,
        crearPedido: vi.fn().mockResolvedValue(true),
      crearPedidoCompleto: vi.fn().mockResolvedValue({ orderNumber: 10581, total: 11 }),
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

// ═══════════════════════════════════════════════════════════════════════════
// CÓMO SE PIDE LO DECIDE EL TIPO, NO CUÁNTOS PRODUCTOS HAY
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ ESTE BLOQUE DECÍA LO CONTRARIO HASTA EL 2026-08-23, y lo corrigió el
// dueño mirando su teléfono:
//
//   «una pizzería puede tener 10 productos pero al momento de elegir tiene
//    muchas opciones, así como una heladería puede tener 10 helados pero
//    muchos sabores: eso son mini app. Pero un restaurante que ofrece
//    almuerzos solo, queda pedir por WhatsApp.»
//
// Se contaban PRODUCTOS (la «regla de los 20»). Con ese criterio Monster
// Pizza —17 productos— caía en el chat, y pedir una pizza por lista de
// WhatsApp es tamaño, masa, borde y dos sabores.
//
// ⚠️ El criterio correcto YA EXISTÍA —`PEDIDO_SIMPLE`, con estos mismos
// ejemplos— pero vivía solo en el panel del admin y la regla de los 20 lo
// sobrescribía. Ahora vive en `marketplace_category_types.pide_en_chat`.
describe('el TIPO de local decide cómo se pide', () => {
  it('un tipo de pedido simple se atiende en el CHAT, sin enlace', async () => {
    const ctx = armar({ enChat: true })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)

    expect(ctx.avanzarMenu).toHaveBeenCalled()
    expect(ctx.deps.issueLink).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).reply).not.toContain('http')
  })

  it('un tipo con mucho que elegir recibe el ENLACE', async () => {
    const ctx = armar({ enChat: false })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)

    expect(ctx.deps.issueLink).toHaveBeenCalled()
    expect(ctx.avanzarMenu).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).reply).toContain('https://umbani.app/t/donia-maria?k=abc')
  })

  it('se pregunta por el TIPO del local, no por su catálogo', async () => {
    // Lo que se mide es cuánto hay que ELEGIR, y eso no se deduce contando.
    const ctx = armar({ enChat: true })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)
    expect(ctx.deps.tipoPideEnChat).toHaveBeenCalledWith('almuerzos')
  })

  it('si la consulta falla se manda el ENLACE: es el lado que siempre funciona', async () => {
    // La tienda atiende cualquier catálogo y cualquier cantidad de opciones;
    // un menú de chat mal elegido deja al cliente recorriendo listas.
    const ctx = armar({ enChat: true })
    ctx.deps.tipoPideEnChat.mockRejectedValue(new Error('base caída'))
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)
    expect(ctx.deps.issueLink).toHaveBeenCalled()
    expect(ctx.avanzarMenu).not.toHaveBeenCalled()
  })
})

describe('el carrito sobrevive a un despliegue', () => {
  it('el estado del menú se GUARDA en la conversación, no en memoria', async () => {
    // ⚠️ `bot-menu-flow` guarda su estado en un `Map` que se pierde en cada
    // arranque y que con dos instancias lleva dos cuentas del mismo carrito.
    // En el marketplace vive en `marketplace_conversations.flow_state`.
    const ctx = armar({ enChat: true })
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
    const ctx = armar({ enChat: true, estadoMenu: carrito })
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

describe('el checkout dentro del chat', () => {
  const conCarritoConfirmado = ctx => {
    ctx.avanzarMenu.mockReturnValue({
      resultado: {
        reply: 'Resumen…',
        options: [],
        action: {
          type: 'order',
          summary: '2 × Almuerzo completo',
          totalCents: 700,
          payload: '##PEDIDO:Almuerzo completo x 2##',
          items: [{ name: 'Almuerzo completo', qty: 2, note: 'Jugo de maracuyá' }],
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

  const enEstado = (ctx, current_state, checkout) => {
    ctx.database.getConversation.mockResolvedValue({
      current_state,
      selected_business_id: 'biz-1',
      shopping_locked: false,
      flow_state: { checkout },
      version: 6,
    })
  }

  const CARRITO = { items: [{ name: 'Almuerzo completo', qty: 2 }] }

  it('confirmar el carrito NO crea el pedido: primero pide la ubicación', async () => {
    // ⚠️ Crear el pedido aquí dejaría uno sin dirección ni forma de cobro en
    // el panel del dueño cada vez que alguien abandone a media conversación.
    const ctx = armar({ enChat: true })
    conCarritoConfirmado(ctx)
    await handle({ from: '593990978367', text: '✅ Confirmar pedido' }, ctx.deps)

    expect(ctx.deps.crearPedidoCompleto).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).reply).toMatch(/ubicación/i)
    expect(ctx.guardados.at(-1).state).toBe('esperando_ubicacion')
    // El carrito espera guardado, no en memoria.
    expect(ctx.guardados.at(-1).flowState.checkout.items).toHaveLength(1)
  })

  it('la ubicación compartida se guarda con sus coordenadas', async () => {
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_ubicacion', CARRITO)
    await handle({
      from: '593990978367',
      text: '[ubicación]',
      location: { latitude: -3.2581, longitude: -79.9554 },
    }, ctx.deps)

    expect(ctx.database.createCustomerAddress).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: -3.2581, longitude: -79.9554 }),
    )
    // Y se pasa a pedir el método de pago, con los del LOCAL.
    expect(ctx.enviados.at(-1).options).toEqual([
      'Transferencia bancaria', 'Efectivo (contra entrega)',
    ])
  })

  it('quien no comparte ubicación puede escribir su dirección', async () => {
    // El navegador de WhatsApp no siempre deja compartir el punto azul, y sin
    // esta salida el cliente se quedaría sin poder pedir.
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_ubicacion', CARRITO)
    await handle({
      from: '593990978367',
      text: 'Av. Quito y 10 de Agosto, casa blanca de dos pisos',
    }, ctx.deps)

    expect(ctx.database.createCustomerAddress).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: null, longitude: null }),
    )
  })

  it('una dirección demasiado corta se vuelve a pedir', async () => {
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_ubicacion', CARRITO)
    await handle({ from: '593990978367', text: 'aquí' }, ctx.deps)

    expect(ctx.database.createCustomerAddress).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).reply).toMatch(/no entendí/i)
  })

  it('elegir transferencia crea el pedido y da los datos bancarios', async () => {
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_metodo_pago', { ...CARRITO, addressId: 'dir-1' })
    await handle({ from: '593990978367', text: 'Transferencia bancaria' }, ctx.deps)

    expect(ctx.deps.crearPedidoCompleto).toHaveBeenCalledWith(
      expect.objectContaining({ addressId: 'dir-1', paymentMethod: 'transferencia' }),
    )
    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).toContain('Banco Pichincha')
    expect(ultimo.reply).toContain('2203344556')
    // ⚠️ El importe sale del pedido YA creado, no de una suma hecha en el
    // chat: es la cifra exacta que el cliente va a transferir.
    expect(ultimo.reply).toContain('$11.00')
    expect(ultimo.reply).toContain('#10581')
    expect(ultimo.reply).toMatch(/comprobante/i)
  })

  it('elegir efectivo NO pide comprobante ni datos bancarios', async () => {
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_metodo_pago', { ...CARRITO, addressId: 'dir-1' })
    await handle({ from: '593990978367', text: 'Efectivo (contra entrega)' }, ctx.deps)

    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).not.toContain('Banco')
    expect(ultimo.reply).toMatch(/preparación/i)
    expect(ctx.database.getBusinessBankAccount).not.toHaveBeenCalled()
  })

  it('el cliente puede elegir el método por su NÚMERO de lista', async () => {
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_metodo_pago', { ...CARRITO, addressId: 'dir-1' })
    await handle({ from: '593990978367', text: '2' }, ctx.deps)
    expect(ctx.deps.crearPedidoCompleto).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: 'efectivo' }),
    )
  })

  it('un método que no existe se vuelve a preguntar', async () => {
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_metodo_pago', { ...CARRITO, addressId: 'dir-1' })
    await handle({ from: '593990978367', text: 'con tarjeta' }, ctx.deps)

    expect(ctx.deps.crearPedidoCompleto).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).options).toHaveLength(2)
  })

  it('creado el pedido, la conversación suelta el carrito y el local', async () => {
    // Si no lo soltara, el siguiente mensaje del cliente seguiría creyéndose
    // parte de un pedido que ya se cerró.
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_metodo_pago', { ...CARRITO, addressId: 'dir-1' })
    await handle({ from: '593990978367', text: 'Efectivo (contra entrega)' }, ctx.deps)

    const ultimo = ctx.guardados.at(-1)
    expect(ultimo.clearFlow).toBe(true)
    expect(ultimo.clearBusiness).toBe(true)
  })

  it('si el pedido NO se pudo crear, se dice y no se invita a reenviar', async () => {
    const ctx = armar({ enChat: true })
    ctx.deps.crearPedidoCompleto.mockResolvedValue(null)
    enEstado(ctx, 'esperando_metodo_pago', { ...CARRITO, addressId: 'dir-1' })
    await handle({ from: '593990978367', text: 'Efectivo (contra entrega)' }, ctx.deps)

    expect(ctx.enviados.at(-1).reply).toMatch(/no lo envíes otra vez/i)
  })

  it('un local sin métodos de pago lo dice, con salida', async () => {
    const ctx = armar({ enChat: true })
    ctx.database.getStorefrontPaymentMethods.mockResolvedValue([])
    enEstado(ctx, 'esperando_ubicacion', CARRITO)
    await handle({
      from: '593990978367', text: '[ubicación]',
      location: { latitude: -3.2581, longitude: -79.9554 },
    }, ctx.deps)

    expect(ctx.enviados.at(-1).reply).toMatch(/MENÚ/)
    expect(ctx.enviados.at(-1).options).toEqual([])
  })

  it('si se pierde el carrito a media conversación, se reinicia con aviso', async () => {
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_metodo_pago', undefined)
    await handle({ from: '593990978367', text: 'Efectivo (contra entrega)' }, ctx.deps)

    expect(ctx.deps.crearPedidoCompleto).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).reply).toMatch(/MENÚ/)
  })

  it('MENÚ sigue funcionando en pleno checkout', async () => {
    // Es la única salida del cliente y no puede depender de dónde esté.
    const ctx = armar({ enChat: true })
    enEstado(ctx, 'esperando_metodo_pago', { ...CARRITO, addressId: 'dir-1' })
    await handle({ from: '593990978367', text: 'menú' }, ctx.deps)

    expect(ctx.deps.crearPedidoCompleto).not.toHaveBeenCalled()
    expect(ctx.enviados.at(-1).options).toEqual(['🍕 Pizzerías'])
  })
})

describe('lo que no cambia', () => {
  it('MENÚ sigue funcionando en medio de un pedido por chat', async () => {
    // Es la única salida del cliente y no puede depender de dónde esté.
    const ctx = armar({ enChat: true })
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
    const ctx = armar({ enChat: true })
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

// ═══════════════════════════════════════════════════════════════════════════
// UN PEDIDO A LA VEZ — que el bloqueo se ACTIVE
//
// ⚠️ Hasta el 2026-08-22 `shopping_locked` existía en la base, el texto que
// lo explica estaba escrito y probado… y NADIE lo ponía en `true`. El cliente
// que estaba comprando en un local podía cambiarse a otro en silencio, y se
// quedaba con la mini app del primero abierta y un carrito que ya no llevaba
// a ninguna parte.
// ═══════════════════════════════════════════════════════════════════════════
describe('el bloqueo se activa de verdad', () => {
  const hastaElLocal = async (ctx) => {
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    await handle({ from: '593990978367', text: 'Pizzerías' }, ctx.deps)
  }

  it('elegir local con MINI APP bloquea: ya tiene su tienda abierta', async () => {
    const ctx = armar({ productos: 50 })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)

    const conLocal = ctx.guardados.find(p => p.businessId === 'biz-1')
    expect(conLocal.shoppingLocked).toBe(true)
  })

  it('y elegir local que pide por CHAT también', async () => {
    const ctx = armar({ enChat: true })
    await hastaElLocal(ctx)
    await handle({ from: '593990978367', text: 'Almuerzos Doña María' }, ctx.deps)

    const conLocal = ctx.guardados.find(p => p.businessId === 'biz-1')
    expect(conLocal.shoppingLocked).toBe(true)
  })

  it('con el bloqueo puesto, pedir otra cosa NO cambia de local', async () => {
    const ctx = armar({ enChat: false })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'en_local',
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: null,
      version: 3,
    })
    await handle({ from: '593990978367', text: 'ahora quiero pizza' }, ctx.deps)

    const ultimo = ctx.enviados.at(-1)
    // Se le dice DÓNDE lo tiene y CÓMO salir, en el mismo mensaje.
    //
    // ⚠️ CAMBIADO EL 2026-08-23, misma intención: antes el texto mandaba
    // «escribe *MENÚ*», y escribir MENÚ llevaba a una pregunta que MENÚ no
    // podía responder — el cliente se quedaba en bucle. Ahora la salida son
    // las dos opciones, que sí resuelven.
    expect(ultimo.reply).toContain('Almuerzos Doña María')
    expect(ultimo.options).toHaveLength(2)
    expect(ultimo.options.join(' ')).toMatch(/Empezar de nuevo/)
    // Y no se le cambia el local por debajo.
    expect(ctx.guardados.some(p => p.businessId && p.businessId !== 'biz-1')).toBe(false)
  })

  it('crear el pedido SUELTA el bloqueo', async () => {
    // Si no lo soltara, el cliente no podría volver a pedir nunca sin
    // escribir MENÚ.
    const ctx = armar({ enChat: true })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'esperando_metodo_pago',
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: { checkout: { items: [{ name: 'Almuerzo completo', qty: 1 }], addressId: 'dir-1' } },
      version: 7,
    })
    await handle({ from: '593990978367', text: 'Efectivo (contra entrega)' }, ctx.deps)

    const ultimo = ctx.guardados.at(-1)
    expect(ultimo.shoppingLocked).toBe(false)
    expect(ultimo.clearBusiness).toBe(true)
  })
})
