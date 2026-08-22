import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// EL CANAL DE LA PLATAFORMA
//
// Un solo número para todo el marketplace. Lo que se fija aquí es lo que hace
// que un mensaje SIN local llegue, se ordene y se conteste — y que al abrir
// ese camino no se haya debilitado el que ya existía.
// ═══════════════════════════════════════════════════════════════════════════

const leer = ruta => readFileSync(
  fileURLToPath(new URL(ruta, import.meta.url)),
  'utf8',
)

describe('reconocer el número de la plataforma', () => {
  it('el mismo número casa con y sin el «+»', async () => {
    const { esNumeroDePlataforma } = await import('../dist/services/platform-channel.js')
    const direccion = identifier => ([{
      provider: 'ycloud', identifierType: 'phone', identifier,
    }])

    // El mismo teléfono llega como `+593…` desde un proveedor y como `593…`
    // desde otro. Comparar en crudo daría «no» a dos escrituras del mismo
    // número, y el mensaje se descartaría en silencio.
    expect(esNumeroDePlataforma(direccion('+593990978367'), '593990978367')).toBe(true)
    expect(esNumeroDePlataforma(direccion('593990978367'), '593990978367')).toBe(true)
    expect(esNumeroDePlataforma(direccion('+593 99 097 8367'), '593990978367')).toBe(true)
    expect(esNumeroDePlataforma(direccion('593990978368'), '593990978367')).toBe(false)
  })

  it('un account_id de Meta nunca se confunde con un número', async () => {
    const { esNumeroDePlataforma } = await import('../dist/services/platform-channel.js')
    // Comparar un identificador de cuenta con un teléfono daría siempre falso,
    // pero por accidente. Se excluye explícitamente.
    expect(esNumeroDePlataforma([{
      provider: 'meta', identifierType: 'account_id', identifier: '593990978367',
    }], '593990978367')).toBe(false)
  })
})

describe('el payload durable sin local', () => {
  const base = {
    version: 1,
    provider: 'ycloud',
    from: '593990978367',
    inboundId: 'wamid.abc',
    channelAddress: {
      provider: 'ycloud', identifierType: 'phone', identifier: '593911111111',
    },
    content: { kind: 'text', text: 'hola' },
  }

  it('acepta que no haya negocio: el cliente aún no eligió local', async () => {
    const { parseInboundWebhookPayload } = await import('../dist/services/inbound-webhook.js')
    expect(parseInboundWebhookPayload({ ...base, businessId: null }).businessId).toBe(null)
    // Ausente y nulo son lo mismo: un payload viejo no llevaba el campo.
    expect(parseInboundWebhookPayload({ ...base }).businessId).toBe(null)
  })

  it('pero un negocio ILEGIBLE sigue siendo un error', async () => {
    const { parseInboundWebhookPayload } = await import('../dist/services/inbound-webhook.js')
    // ⚠️ Esto es lo que separa «mensaje de marketplace» de «payload corrupto».
    // Tratarlos igual escondería el corrupto detrás del camino nuevo.
    for (const roto of ['', '   ', 'x'.repeat(200), 42]) {
      expect(() => parseInboundWebhookPayload({ ...base, businessId: roto }))
        .toThrow(/Contexto durable/)
    }
  })

  it('la clave de conversación dice «plataforma», no «null»', async () => {
    const { inboundConversationKey } = await import('../dist/services/inbound-webhook.js')
    const clave = inboundConversationKey({ ...base, businessId: null })
    expect(clave).toBe('ycloud:plataforma:593990978367')
    // Un `null` interpolado ahí parece un dato que se perdió al leer un log.
    expect(clave).not.toContain('null')
  })
})

describe('la migración no revierte lo que ya existía', () => {
  const sql = leer('../migration-2026-08-21-canal-de-plataforma.sql')

  it('conserva el agrupado de textos rápidos', () => {
    // ⚠️ El riesgo real: `enqueue_webhook_event` creció con el debounce
    // durable (migration-agrupado-webhooks.sql). Recrearla desde la versión
    // vieja de migration-inbox-webhooks.sql lo habría borrado en silencio, y
    // cada palabra suelta del cliente pasaría a ser una respuesta pagada.
    expect(sql).toContain('v_quiet_until')
    expect(sql).toContain("interval '3 seconds'")
    expect(sql).toContain('_inboxBatch')
    expect(sql).toMatch(/boundary/)
  })

  it('conserva los lotes del lease', () => {
    expect(sql).toMatch(/v_batch_ids|v_combined_text/)
  })

  it('compara los negocios con «is not distinct from», nunca con «=»', () => {
    // En SQL `null = null` es NULL, no cierto. Con `=`, el FIFO por
    // conversación desaparecía para los mensajes sin local y dos mensajes
    // seguidos del mismo cliente se contestaban al revés.
    //
    // Se mira solo el CÓDIGO: los comentarios de la migración citan el `=`
    // viejo para explicar de qué fallo viene, y eso no es una comparación.
    const codigo = sql.split('\n')
      .filter(linea => !linea.trimStart().startsWith('--'))
      .join('\n')
    expect(codigo).not.toMatch(/business_id\s*=\s*/)
    expect(codigo).toContain('is not distinct from')
  })

  it('el advisory lock no se calcula sobre NULL', () => {
    // `null || ':'` es NULL: sin el coalesce, el lock que serializa los
    // enqueue del mismo stream se pediría sobre nada.
    expect(sql).toContain("coalesce(p_business_id::text, 'plataforma')")
  })

  it('deduplica los mensajes sin local con índices parciales', () => {
    // Los únicos que empiezan por business_id no deduplican con NULL, así que
    // sin estos el mismo mensaje reentregado se contestaría dos veces.
    expect(sql).toContain('uq_webhook_events_plataforma_hash')
    expect(sql).toContain('uq_webhook_inbox_plataforma_stream')
    expect(sql).toMatch(/where business_id is null/)
  })

  it('no toca las funciones del dinero ni el reclamo por negocio', () => {
    expect(sql).not.toContain('create_storefront_order')
    expect(sql).not.toContain('set_order_status')
    // `claim_webhook_event` sigue exigiendo negocio: solo lo usan los canales
    // con número propio, donde el negocio siempre existe.
    expect(sql).not.toContain('claim_webhook_event')
  })
})

describe('el menú del marketplace, de punta a punta', () => {
  const CATEGORIAS = [
    { code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
    { code: 'almuerzos', label: 'Almuerzos', emoji: '🍽️', locales: 2 },
  ]
  const MONSTER = {
    id: 'biz-1', slug: 'monster-pizza', name: 'Monster Pizza',
    type: 'pizzería', prep_min: 25,
  }

  const armar = (overrides = {}) => {
    const conversacion = { valor: null }
    const database = {
      resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: null }),
      getConversation: vi.fn(async () => conversacion.valor),
      advanceConversation: vi.fn(async (_id, patch) => {
        conversacion.valor = {
          current_state: patch.state || 'navegando',
          selected_business_id: patch.clearBusiness
            ? null
            : (patch.businessId ?? conversacion.valor?.selected_business_id ?? null),
          shopping_locked: patch.shoppingLocked ?? conversacion.valor?.shopping_locked ?? false,
          flow_state: patch.flowState ?? conversacion.valor?.flow_state ?? null,
          version: (conversacion.valor?.version || 0) + 1,
        }
        return { conflicto: false }
      }),
      getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
      getMarketplaceBusinesses: vi.fn().mockResolvedValue([MONSTER]),
      getBusinessById: vi.fn().mockResolvedValue({
        id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
        storefront_enabled: true, takes_orders: true,
      }),
      ...overrides.database,
    }
    const enviados = []
    return {
      conversacion,
      database,
      enviados,
      deps: {
        database,
        issueLink: overrides.issueLink
          || vi.fn().mockResolvedValue('https://umbani.app/t/monster-pizza?k=abc'),
        send: async (reply, options) => { enviados.push({ reply, options }) },
        logger: { log: () => {} },
      },
    }
  }

  let handle
  beforeEach(async () => {
    ({ handleMarketplaceMessage: handle } = await import('../dist/services/marketplace-entry.js'))
  })

  it('el primer mensaje ofrece las categorías', async () => {
    const ctx = armar()
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    expect(ctx.enviados).toHaveLength(1)
    expect(ctx.enviados[0].options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
  })

  it('elegir categoría lleva a los locales SIN pedir otro mensaje', async () => {
    const ctx = armar()
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    await handle({ from: '593990978367', text: 'Pizzerías' }, ctx.deps)
    // ⚠️ Las dos fases de `paso` (elegir categoría → consultar locales) se
    // resuelven dentro de la MISMA llamada. Si no, el cliente tendría que
    // escribir dos veces para ver una lista, y cada mensaje se paga.
    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.options).toContain('Monster Pizza')
    expect(ctx.database.getMarketplaceBusinesses).toHaveBeenCalledWith('pizzerias')
  })

  it('elegir local manda su enlace y deja la conversación en ese local', async () => {
    const ctx = armar()
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    await handle({ from: '593990978367', text: 'Pizzerías' }, ctx.deps)
    await handle({ from: '593990978367', text: 'Monster Pizza' }, ctx.deps)

    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).toContain('Monster Pizza')
    expect(ultimo.reply).toContain('https://umbani.app/t/monster-pizza?k=abc')
    expect(ctx.conversacion.valor.selected_business_id).toBe('biz-1')
  })

  it('el local se guarda ANTES de mandar el enlace', async () => {
    // Si se guardara después y el envío fallara, el cliente tendría la tienda
    // abierta y la plataforma lo creería en la portada.
    const orden = []
    const ctx = armar({
      issueLink: vi.fn(async () => { orden.push('enlace'); return 'https://x/y' }),
    })
    ctx.database.advanceConversation.mockImplementation(async (_i, patch) => {
      if (patch.businessId) orden.push('guardar')
      return { conflicto: false }
    })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'navegando', selected_business_id: null, shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 1,
    })
    await handle({ from: '593990978367', text: 'Monster Pizza' }, ctx.deps)
    expect(orden).toEqual(['guardar', 'enlace'])
  })

  it('sin enlace se dice, y se ofrece la salida', async () => {
    const ctx = armar({ issueLink: vi.fn().mockResolvedValue(null) })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'navegando', selected_business_id: null, shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 1,
    })
    await handle({ from: '593990978367', text: 'Monster Pizza' }, ctx.deps)
    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).toMatch(/MENÚ/)
    // Nunca se deja al cliente sin respuesta y sin salida.
    expect(ultimo.reply).not.toBe('')
  })

  it('sin locales disponibles se dice, en vez de una lista vacía', async () => {
    const ctx = armar()
    ctx.database.getMarketplaceCategories.mockResolvedValue([])
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    expect(ctx.enviados[0].reply).toMatch(/no hay locales/i)
    expect(ctx.enviados[0].options).toEqual([])
  })

  describe('un pedido a la vez', () => {
    const conPedidoAbierto = ctx => {
      ctx.database.getConversation.mockResolvedValue({
        current_state: 'en_local',
        selected_business_id: 'biz-1',
        shopping_locked: true,
        flow_state: { vista: { vista: 'negocios', pagina: 0 } },
        version: 3,
      })
    }

    it('con un pedido abierto no se cambia de local en silencio', async () => {
      const ctx = armar()
      conPedidoAbierto(ctx)
      await handle({ from: '593990978367', text: 'ahora quiero pizza' }, ctx.deps)
      const ultimo = ctx.enviados.at(-1)
      expect(ultimo.reply).toContain('Monster Pizza')
      // El bloqueo NO es un muro: dice qué tiene abierto Y cómo salir, en el
      // mismo mensaje. Cada respuesta se paga desde el 1 de octubre.
      expect(ultimo.reply).toMatch(/MENÚ/)
    })

    it('MENÚ con un pedido abierto PREGUNTA antes de tirarlo', async () => {
      const ctx = armar()
      conPedidoAbierto(ctx)
      await handle({ from: '593990978367', text: 'menú' }, ctx.deps)
      const ultimo = ctx.enviados.at(-1)
      expect(ultimo.options).toHaveLength(2)
      // ⚠️ Y NO suelta el local mientras pregunta: el cliente pudo escribir
      // «menú» buscando ayuda, no queriendo perder lo que llevaba.
      const patches = ctx.database.advanceConversation.mock.calls.map(c => c[1])
      expect(patches.every(p => !p.clearBusiness)).toBe(true)
    })

    it('MENÚ sin pedido abierto vuelve a la portada directo', async () => {
      const ctx = armar()
      ctx.database.getConversation.mockResolvedValue({
        current_state: 'navegando', selected_business_id: null, shopping_locked: false,
        flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
        version: 2,
      })
      await handle({ from: '593990978367', text: 'MENÚ' }, ctx.deps)
      expect(ctx.enviados.at(-1).options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
    })
  })
})

describe('el envío por el número de la plataforma', () => {
  it('no le cobra el mensaje a ningún negocio', async () => {
    const fuente = leer('../src/services/platform-channel.ts')
    // Un mensaje de antes de elegir local es de la plataforma. Cargárselo a un
    // local elegido después sería inventarle gasto.
    expect(fuente).toMatch(/id:\s*null/)
  })

  it('cae a texto con las opciones si la lista interactiva falla', async () => {
    const fuente = leer('../src/services/platform-channel.ts')
    // Quedarse sin respuesta es peor que responder sin botones.
    expect(fuente).toContain('sendText')
    expect(fuente).toMatch(/\$\{i \+ 1\}/)
  })
})

describe('el negocio de marketplace ya puede enviar', () => {
  const fuente = leer('../src/integrations/whatsapp.ts')

  it('resuelve el canal antes de decidir el proveedor', () => {
    // Antes lanzaba «todavía no hay canal propio»: un aviso de pedido a un
    // local de marketplace no salía nunca.
    expect(fuente).toContain('conCanalDePlataforma')
    expect(fuente).not.toContain('todavía no hay canal propio')
  })

  it('las credenciales salen del canal resuelto, no del negocio', () => {
    // ⚠️ El fallo silencioso que esto evita: con `ycloudKeyFor(business)` un
    // local de marketplace no tiene key propia y caería a la variable de
    // entorno, mandando por la cuenta equivocada.
    expect(fuente).not.toContain('ycloudKeyFor(business)')
    expect(fuente).not.toContain('ycloudNumberFor(business)')
    expect(fuente).toContain('ycloudKeyFor(canal)')
  })

  it('pero el consumo se le sigue cargando al LOCAL, no a la plataforma', () => {
    // Quien envía es la plataforma; quien gasta es el local.
    expect(fuente).toMatch(/recordAcceptedMessage\(business,/)
    expect(fuente).toMatch(/recordSendFailure\(business,/)
  })

  it('el «escribiendo…» resuelve el canal DENTRO de su try', () => {
    // ⚠️ `sendTyping` es best-effort: nunca puede interrumpir la respuesta.
    // Resolver el canal consulta `server_settings` y puede lanzar, así que
    // fuera del try un negocio sin plataforma configurada tumbaría la
    // respuesta entera por no poder poner el indicador de escritura.
    const typing = fuente.slice(
      fuente.indexOf('async function sendTyping'),
      fuente.indexOf('async function sendText'),
    )
    const try_ = typing.indexOf('try {')
    const resolver = typing.indexOf('conCanalDePlataforma(business)')
    expect(try_).toBeGreaterThan(-1)
    expect(resolver).toBeGreaterThan(try_)
  })
})
