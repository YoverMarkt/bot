import {
  esComandoMenu,
  paso,
  recordarPedidoEnProceso,
  responderAlMenu,
  resolverReinicio,
  type MarketplaceBusiness,
  type MarketplaceCategory,
  type MarketplaceReply,
  type MarketplaceView,
} from './marketplace-menu'

/**
 * LA ENTRADA DEL MARKETPLACE
 *
 * Qué pasa cuando alguien escribe al número de Umbani. Es el eslabón que
 * faltaba: `marketplace-menu.ts` sabía armar cada pantalla y
 * `marketplace_conversations` sabía dónde está cada cliente, pero nadie los
 * llamaba — el menú estaba construido y desconectado.
 *
 * ⚠️ Sin IA, como todo lo que ve el cliente desde el 2026-08-21: cada texto
 * de aquí sale del código con datos de la base.
 *
 * ⚠️ El menú termina en el ENLACE del local, a propósito. La mini app ya sabe
 * hacer productos, opciones, carrito, dirección, pago y seguimiento; rehacer
 * ese camino en botones de WhatsApp sería una segunda implementación del
 * mismo flujo y un cuarto sitio donde el precio puede divergir.
 */

export interface MarketplaceEntryDatabase {
  resolveMarketplaceCustomer(phone: string): Promise<{ id: string; name: string | null }>
  getConversation(customerId: string): Promise<{
    current_state: string
    selected_business_id: string | null
    shopping_locked: boolean
    flow_state: Record<string, unknown> | null
    version: number
  } | null>
  advanceConversation(
    customerId: string,
    patch: {
      state?: string
      businessId?: string
      clearBusiness?: boolean
      shoppingLocked?: boolean
      flowState?: Record<string, unknown>
      clearFlow?: boolean
    },
    expectedVersion?: number,
  ): Promise<{ conflicto: boolean }>
  getMarketplaceCategories(): Promise<MarketplaceCategory[]>
  getMarketplaceBusinesses(code: string): Promise<MarketplaceBusiness[]>
  getBusinessById(id: string): Promise<{
    id: string
    name: string
    slug: string | null
    storefront_enabled?: boolean | null
    takes_orders?: boolean | null
  } | null>
}

export interface MarketplaceEntryDeps {
  database: MarketplaceEntryDatabase
  /** Crea la sesión de tienda y devuelve el enlace. Null si no se pudo. */
  issueLink(input: {
    business: { id: string; slug: string | null; storefront_enabled?: boolean | null }
    phone: string
    name?: string | null
    force?: boolean
  }): Promise<string | null>
  send(reply: string, options: string[]): Promise<void>
  logger?: { log(...args: unknown[]): void }
}

/** La vista guardada, o la portada si es el primer mensaje. */
const vistaDe = (flowState: Record<string, unknown> | null): MarketplaceView => {
  const guardada = flowState?.vista as MarketplaceView | undefined
  if (guardada && typeof guardada.vista === 'string' && typeof guardada.pagina === 'number') {
    return guardada
  }
  return { vista: 'categorias', pagina: 0 }
}

/**
 * Atiende un mensaje que llegó al número de la plataforma.
 *
 * El orden de las comprobaciones NO es casual:
 *
 *   1. MENÚ, siempre y en cualquier vista. Es la única salida del cliente, y
 *      hacerla depender de dónde está la volvería inútil justo el día que se
 *      atasque.
 *   2. La confirmación de reinicio, que es la única pregunta con consecuencia
 *      irreversible (tirar un carrito).
 *   3. El bloqueo de «un pedido a la vez».
 *   4. El menú normal.
 */
export async function handleMarketplaceMessage(
  input: { from: string; text: string },
  deps: MarketplaceEntryDeps,
): Promise<void> {
  const { database, send } = deps
  const { from, text } = input

  const customer = await database.resolveMarketplaceCustomer(from)
  const conversation = await database.getConversation(customer.id)
  const categorias = await database.getMarketplaceCategories()

  // Un marketplace sin un solo local disponible no puede ofrecer nada, y una
  // lista vacía es una calle sin salida que además cuesta un mensaje.
  if (!categorias.length) {
    await send(
      '🙏 Ahora mismo no hay locales disponibles. Vuelve a escribirnos en un rato.',
      [],
    )
    return
  }

  const negocioActual = conversation?.selected_business_id
    ? await database.getBusinessById(conversation.selected_business_id)
    : null
  const estado = {
    negocio: negocioActual
      ? { name: negocioActual.name, slug: negocioActual.slug || '' }
      : null,
    bloqueado: Boolean(conversation?.shopping_locked),
  }
  const vista = vistaDe(conversation?.flow_state ?? null)

  // ── 1. MENÚ, antes que nada ────────────────────────────────────────
  if (esComandoMenu(text)) {
    const respuesta = responderAlMenu(estado, categorias)
    // Solo se suelta el local cuando NO hay que preguntar nada. Con un pedido
    // en marcha la respuesta es la pregunta, y el carrito sigue donde estaba.
    await guardar(deps, customer.id, conversation?.version, respuesta, {
      soltarLocal: respuesta.vista.vista !== 'confirmando_reinicio',
    })
    await send(respuesta.reply, respuesta.options)
    return
  }

  // ── 2. ¿Estaba respondiendo a «¿tiro tu pedido?» ───────────────────
  if (vista.vista === 'confirmando_reinicio') {
    const { reinicia, respuesta } = resolverReinicio(text, estado, categorias)
    await guardar(deps, customer.id, conversation?.version, respuesta, {
      soltarLocal: reinicia,
    })
    await send(respuesta.reply, respuesta.options)
    return
  }

  // ── 3. Un pedido a la vez ──────────────────────────────────────────
  if (estado.bloqueado && negocioActual) {
    const respuesta = recordarPedidoEnProceso({ name: negocioActual.name })
    await send(respuesta.reply, respuesta.options)
    return
  }

  // ── 4. El menú ─────────────────────────────────────────────────────
  //
  // `paso` es una función PURA: no consulta nada. Cuando el cliente elige una
  // categoría devuelve la vista nueva con el texto vacío, porque los locales
  // de esa categoría todavía no están consultados. Se consultan y se vuelve a
  // llamar — dos fases, y por eso el bucle tiene tope: sin él, una vista que
  // no avanzara dejaría el proceso girando dentro de un webhook.
  let respuesta: MarketplaceReply = { reply: '', options: [], vista }
  let vistaActual = vista
  for (let intento = 0; intento < 2; intento += 1) {
    const negocios = vistaActual.vista === 'negocios' && vistaActual.categoria
      ? await database.getMarketplaceBusinesses(vistaActual.categoria)
      : []
    respuesta = paso({
      mensaje: intento === 0 ? text : '',
      vista: vistaActual,
      categorias,
      negocios,
    })
    if (respuesta.reply || respuesta.negocioElegido) break
    vistaActual = respuesta.vista
  }

  // ── El cliente llegó a un local: se le manda su enlace ─────────────
  if (respuesta.negocioElegido) {
    await entregarLocal(deps, customer, from, respuesta.negocioElegido, conversation?.version)
    return
  }

  await guardar(deps, customer.id, conversation?.version, respuesta, { soltarLocal: false })
  await send(respuesta.reply, respuesta.options)
}

/**
 * El cliente eligió local: se le manda el enlace de su tienda y la
 * conversación queda apuntando ahí.
 *
 * ⚠️ El local se guarda ANTES de mandar el enlace. Si se guardara después y
 * el envío fallara, el cliente tendría un enlace en el chat y la plataforma
 * creería que sigue en la portada — y su siguiente mensaje lo devolvería al
 * menú, con la tienda abierta en el teléfono.
 */
async function entregarLocal(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  negocio: MarketplaceBusiness,
  version: number | undefined,
): Promise<void> {
  const { database, send, logger } = deps

  await database.advanceConversation(
    customer.id,
    {
      state: 'en_local',
      businessId: negocio.id,
      flowState: { vista: { vista: 'negocios', categoria: negocio.type, pagina: 0 } },
    },
    version,
  )

  const business = await database.getBusinessById(negocio.id)
  const url = business
    ? await deps.issueLink({
        business,
        phone,
        name: customer.name,
        // El cliente acaba de pedirlo eligiendo el local: el cooldown de
        // reenvío no aplica, o elegir dos veces seguidas no daría enlace.
        force: true,
      })
    : null

  if (!url) {
    logger?.log(`⚠️  [marketplace] sin enlace para ${negocio.slug}`)
    await send(
      `😕 No pude abrir la tienda de *${negocio.name}* ahora mismo. `
      + 'Escribe *MENÚ* para elegir otro local.',
      [],
    )
    return
  }

  await send(
    `🛍️ *${negocio.name}*\n\nArma tu pedido aquí 👇\n${url}\n\n`
    + 'Cuando termines te aviso por aquí mismo. Para volver al inicio, escribe *MENÚ*.',
    [],
  )
}

/** Guarda dónde quedó la conversación. */
async function guardar(
  deps: MarketplaceEntryDeps,
  customerId: string,
  version: number | undefined,
  respuesta: MarketplaceReply,
  opciones: { soltarLocal: boolean },
): Promise<void> {
  await deps.database.advanceConversation(
    customerId,
    {
      state: respuesta.vista.vista === 'confirmando_reinicio'
        ? 'confirmando_reinicio'
        : 'navegando',
      flowState: { vista: respuesta.vista },
      ...(opciones.soltarLocal ? { clearBusiness: true } : {}),
    },
    version,
  )
}
