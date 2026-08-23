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
import { optionTitle } from './bot-menu-flow'
import * as checkout from './marketplace-checkout'
import type { InboundLocation } from './inbound-webhook'
import type {
  FlowState,
  MenuFlowInput,
  MenuFlowResult,
} from './bot-menu-flow'

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
  /** Cuántos productos ACTIVOS tiene el local. Decide chat o enlace. */
  countProducts(businessId: string): Promise<number>
  getProducts(businessId: string): Promise<unknown[]>
  getMenuModifiers?(businessId: string): Promise<unknown[]>
  getLastOrderForContact?(
    businessId: string,
    phone: string,
  ): Promise<{ order_items?: unknown[] } | null>
  getPolicies(businessId: string): Promise<{ welcome_message?: unknown } | null>

  // ── Lo que hace falta para cerrar el pedido dentro del chat ────────
  /** Guarda la dirección del cliente para ESTE negocio. */
  createCustomerAddress(input: {
    businessId: string
    customerId: string
    address: string
    reference?: string | null
    latitude?: number | null
    longitude?: number | null
  }): Promise<{ id: string } | null>
  /** Los métodos que acepta este local, nunca una lista fija. */
  getStorefrontPaymentMethods(businessId: string): Promise<checkout.MetodoDePago[]>
  /** La cuenta a la que transferir. Null si el local no cargó ninguna. */
  getBusinessBankAccount(businessId: string): Promise<checkout.CuentaBancaria | null>
  /** Resuelve nombres del catálogo a `product_id`. */
  getProductsForOrder?(businessId: string): Promise<unknown[]>
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
  /**
   * Cuántos productos caben en el chat. Por encima, se manda el enlace.
   *
   * Se inyecta en vez de leerse aquí para poder probar los dos lados del
   * umbral sin tocar `server_settings`.
   */
  maxProductosEnChat(): Promise<number>
  /** Un paso de la máquina de estados del menú, con el estado fuera. */
  avanzarMenu(
    input: MenuFlowInput,
    estadoPrevio: FlowState | null,
  ): { resultado: MenuFlowResult; estado: FlowState | null }
  /** Crea el pedido con `money.ts` y las RPC atómicas de siempre. */
  crearPedido(input: {
    business: Record<string, unknown>
    phone: string
    items: { name: string; qty: number; note?: string | null }[]
    payload: string
    products: unknown[]
    send: (mensaje: string) => Promise<unknown>
  }): Promise<boolean>
  /**
   * Crea el pedido COMPLETO con `create_storefront_order`: la RPC atómica de
   * siempre, con dirección, método de pago y el total oficial.
   */
  crearPedidoCompleto(input: {
    businessId: string
    customerId: string
    phone: string
    contactName?: string | null
    addressId: string
    paymentMethod: string
    items: { name: string; qty: number; note?: string }[]
    products: unknown[]
    notes?: string | null
  }): Promise<{ orderNumber: number | null; total: unknown } | null>
  logger?: { log(...args: unknown[]): void }
}

/**
 * El carrito que espera dirección y método de pago.
 *
 * Vive en `flow_state.checkout` hasta que hay todo para crear el pedido de
 * una vez. Guarda lo que el cliente ELIGIÓ, no importes: el total lo calcula
 * `create_storefront_order` al final, con los precios de ese momento.
 */
export interface CheckoutPendiente {
  items: { name: string; qty: number; note?: string }[]
  addressId?: string
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
  input: { from: string; text: string; location?: InboundLocation },
  deps: MarketplaceEntryDeps,
): Promise<void> {
  const { database, send } = deps
  const { from, text, location } = input

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

  // ── 3. El CHECKOUT: ubicación y método de pago ─────────────────────
  //
  // Van antes que el menú porque el cliente ya terminó de elegir: su mensaje
  // es la respuesta a lo que se le acaba de preguntar, no una opción del
  // catálogo. MENÚ sigue por delante de todo, así que nunca queda atrapado.
  if (conversation?.selected_business_id
    && (conversation.current_state === 'esperando_ubicacion'
      || conversation.current_state === 'esperando_metodo_pago')) {
    await avanzarCheckout({
      deps,
      customer,
      phone: from,
      texto: text,
      location,
      businessId: conversation.selected_business_id,
      conversacion: conversation,
    })
    return
  }

  // ── 4. ¿Está pidiendo DENTRO del chat en un local pequeño? ─────────
  //
  // Va antes del bloqueo de «un pedido a la vez» porque aquí el cliente no
  // está intentando empezar otra cosa: está en medio de su pedido, y este
  // mensaje es su siguiente elección del menú.
  if (conversation?.current_state === 'pidiendo' && conversation.selected_business_id) {
    await conducirEnElChat(
      deps, customer, from, conversation.selected_business_id, text, conversation,
    )
    return
  }

  // ── 5. Un pedido a la vez ──────────────────────────────────────────
  if (estado.bloqueado && negocioActual) {
    const respuesta = recordarPedidoEnProceso({ name: negocioActual.name })
    await send(respuesta.reply, respuesta.options)
    return
  }

  // ── 6. El menú ─────────────────────────────────────────────────────
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
 * El cliente eligió local. Aquí se decide CÓMO va a pedir.
 *
 * ⚠️ La regla la decide el CATÁLOGO REAL, contado en este momento, y no el
 * tipo de negocio ni una estimación del alta. Al crear un local tiene cero
 * productos —`apply_business_template` siembra categorías y grupos de
 * opciones, no productos—, así que en el alta no hay nada que contar y
 * cualquier respuesta de entonces sería inventada.
 *
 * ⚠️ Esto NO pisa `chat_mode`. Aquel gobierna el canal PROPIO de un negocio
 * (su número, si lo tiene); esto gobierna la experiencia dentro del
 * marketplace, donde el cliente llegó por el número de la plataforma. Son dos
 * contextos distintos y no se contradicen, así que no hace falta ninguna
 * columna nueva ni sobrescribir la decisión de nadie.
 */
async function entregarLocal(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  negocio: MarketplaceBusiness,
  version: number | undefined,
): Promise<void> {
  const { database, logger } = deps

  const [productos, maximo] = await Promise.all([
    database.countProducts(negocio.id).catch(() => Number.MAX_SAFE_INTEGER),
    deps.maxProductosEnChat(),
  ])
  // Ante un fallo al contar se manda el ENLACE: la tienda sabe atender
  // cualquier catálogo, mientras que el menú del chat con cientos de
  // productos sería inusable. Se falla hacia lo que siempre funciona.
  const enElChat = productos > 0 && productos <= maximo

  await database.advanceConversation(
    customer.id,
    {
      state: enElChat ? 'pidiendo' : 'en_local',
      businessId: negocio.id,
      // El menú del local empieza limpio: `advanceMenuFlowConEstado` con
      // estado nulo devuelve la bienvenida y el menú principal.
      flowState: { vista: { vista: 'negocios', categoria: negocio.type, pagina: 0 } },
    },
    version,
  )

  logger?.log(
    `🏬 [marketplace] ${negocio.slug}: ${productos} productos → ${enElChat ? 'chat' : 'enlace'}`,
  )

  if (enElChat) {
    // Se entra en el menú del local YA, con este mismo mensaje: hacerle
    // escribir otra vez para ver la carta costaría un mensaje de más.
    await conducirEnElChat(deps, customer, phone, negocio.id, '', null)
    return
  }

  await mandarElEnlace(deps, customer, phone, negocio)
}

/** El local es grande: se pide en la mini app. */
async function mandarElEnlace(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  negocio: MarketplaceBusiness,
): Promise<void> {
  const { database, send, logger } = deps
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

/**
 * El local es pequeño: se pide DENTRO del chat, eligiendo de una lista.
 *
 * Reutiliza `bot-menu-flow`, la misma máquina de estados que ya conduce a los
 * negocios con número propio en modo menú. No hay un segundo motor: un
 * segundo motor sería un segundo sitio donde arreglar cada bug.
 *
 * ⚠️ El estado vive en `marketplace_conversations.flow_state`, NO en el `Map`
 * en memoria de `bot-menu-flow`. Ese `Map` se pierde en cada despliegue de
 * Railway y con dos instancias lleva dos cuentas del mismo carrito: un
 * cliente a media compra perdería lo que llevaba sin que nada lo avisara.
 */
async function conducirEnElChat(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  businessId: string,
  mensaje: string,
  conversacion: { flow_state: Record<string, unknown> | null; version: number } | null,
): Promise<void> {
  const { database, send, logger } = deps

  const business = await database.getBusinessById(businessId)
  if (!business) {
    // El local desapareció a media compra. Se dice y se ofrece la salida en
    // vez de dejar al cliente hablando con un catálogo que ya no existe.
    await send(
      '😕 Ese local ya no está disponible. Escribe *MENÚ* para elegir otro.',
      [],
    )
    return
  }

  const [productos, modifiers, lastOrder, policies] = await Promise.all([
    database.getProducts(businessId).catch(() => [] as unknown[]),
    database.getMenuModifiers
      ? database.getMenuModifiers(businessId).catch(() => [] as unknown[])
      : Promise.resolve([] as unknown[]),
    database.getLastOrderForContact
      ? database.getLastOrderForContact(businessId, phone).catch(() => null)
      : Promise.resolve(null),
    database.getPolicies(businessId).catch(() => null),
  ])

  const saludo = policies && typeof policies.welcome_message === 'string'
    ? policies.welcome_message
    : null
  const estadoPrevio = (conversacion?.flow_state?.menu as FlowState | undefined) ?? null

  const { resultado, estado } = deps.avanzarMenu({
    business: business as unknown as MenuFlowInput['business'],
    contact: phone,
    message: mensaje,
    products: productos as MenuFlowInput['products'],
    welcomeMessage: saludo,
    modifiers: modifiers as MenuFlowInput['modifiers'],
    lastOrderItems: (lastOrder?.order_items || []) as MenuFlowInput['lastOrderItems'],
  }, estadoPrevio)

  let respuesta = resultado.reply
  // `MenuOption` puede traer descripción; el envío del marketplace manda
  // títulos. `optionTitle` es el mismo conversor que usa el canal propio.
  let opciones = resultado.options.map(optionTitle)

  // ── El cliente confirmó su pedido ──────────────────────────────────
  //
  // El total oficial lo calcula SIEMPRE `money.ts` con las RPC atómicas: el
  // menú solo aporta QUÉ pidió, nunca un monto. Es la regla #8 y aquí no
  // cambia por venir del marketplace.
  // ── El cliente confirmó el carrito: empieza el CHECKOUT ────────────
  //
  // ⚠️ El pedido NO se crea todavía. Antes hacen falta la dirección y el
  // método de pago, y crearlo ahora dejaría un pedido sin destino ni forma de
  // cobro en el panel del dueño cada vez que alguien abandone a media
  // conversación — pedidos que él ve como reales y no puede preparar.
  //
  // El carrito espera en `flow_state.checkout` y el pedido nace COMPLETO y de
  // una sola vez, con `create_storefront_order`, al final.
  if (resultado.action?.type === 'order') {
    const pendiente: CheckoutPendiente = {
      items: resultado.action.items.map(item => ({
        name: item.name,
        qty: item.qty,
        ...(item.note ? { note: item.note } : {}),
      })),
    }
    await database.advanceConversation(
      customer.id,
      {
        state: 'esperando_ubicacion',
        businessId,
        flowState: {
          menu: (estado ?? null) as unknown as Record<string, unknown>,
          checkout: pendiente as unknown as Record<string, unknown>,
        },
      },
      conversacion?.version,
    )
    const pide = checkout.pedirUbicacion()
    logger?.log(`🛒 [marketplace] carrito confirmado, pidiendo ubicación`)
    await send(pide.reply, pide.options)
    return
  }

  await database.advanceConversation(
    customer.id,
    {
      state: 'pidiendo',
      businessId,
      flowState: { menu: (estado ?? null) as unknown as Record<string, unknown> },
    },
    conversacion?.version,
  )

  if (respuesta || opciones.length) await send(respuesta, opciones)
}

/**
 * Los dos pasos que van entre el carrito y el pedido: dónde lo llevo y cómo
 * pagas.
 *
 * ⚠️ El pedido nace al FINAL, de una vez, con `create_storefront_order`. No se
 * crea antes y se completa después: eso obligaría a una segunda función que
 * actualice la del dinero —hoy hay una sola— y dejaría pedidos sin dirección
 * en el panel del dueño cada vez que alguien abandone a media conversación.
 */
async function avanzarCheckout(input: {
  deps: MarketplaceEntryDeps
  customer: { id: string; name: string | null }
  phone: string
  texto: string
  location?: InboundLocation
  businessId: string
  conversacion: {
    current_state: string
    flow_state: Record<string, unknown> | null
    version: number
  }
}): Promise<void> {
  const { deps, customer, phone, texto, location, businessId, conversacion } = input
  const { database, send, logger } = deps

  const pendiente = conversacion.flow_state?.checkout as CheckoutPendiente | undefined
  if (!pendiente?.items?.length) {
    // El carrito se perdió (conversación vencida, estado inconsistente). Se
    // dice y se ofrece la salida en vez de dejarlo respondiendo al vacío.
    logger?.log('⚠️  [checkout] sin carrito pendiente: se reinicia')
    await database.advanceConversation(
      customer.id, { state: 'navegando', clearFlow: true }, conversacion.version,
    )
    await send(
      '😕 Se me perdió tu pedido. Escribe *MENÚ* para empezar de nuevo.', [],
    )
    return
  }

  // ── Paso 1: la ubicación ───────────────────────────────────────────
  if (conversacion.current_state === 'esperando_ubicacion') {
    // El punto del mapa es lo bueno: llega exacto y sin que el cliente
    // escriba. Pero quien no lo comparta —o abra WhatsApp en un navegador que
    // no lo permita— tiene que poder pedir igual escribiendo su dirección.
    const direccion = location
      ? checkout.direccionDesdeUbicacion(location)
      : texto.trim()

    if (!location && direccion.length < 8) {
      await send(
        '🙏 No entendí la dirección. Comparte tu ubicación con el clip 📎 '
        + 'o escríbela con más detalle (calle, número y referencia).',
        [],
      )
      return
    }

    const guardada = await database.createCustomerAddress({
      businessId,
      customerId: customer.id,
      address: direccion,
      // Las coordenadas viajan juntas o no viajan: media apunta al ecuador.
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
    }).catch(() => null)

    if (!guardada?.id) {
      logger?.log('⚠️  [checkout] no se pudo guardar la dirección')
      await send(
        '😕 No pude guardar tu dirección. Inténtalo otra vez o escribe *MENÚ*.', [],
      )
      return
    }

    const metodos = await database.getStorefrontPaymentMethods(businessId)
      .catch(() => [] as checkout.MetodoDePago[])
    const pide = checkout.pedirMetodoPago(metodos)

    await database.advanceConversation(
      customer.id,
      {
        state: 'esperando_metodo_pago',
        businessId,
        flowState: {
          ...(conversacion.flow_state || {}),
          checkout: { ...pendiente, addressId: guardada.id } as unknown as Record<string, unknown>,
        },
      },
      conversacion.version,
    )
    logger?.log(`📍 [checkout] dirección guardada, ${metodos.length} métodos de pago`)
    await send(pide.reply, pide.options)
    return
  }

  // ── Paso 2: el método de pago, y el pedido ─────────────────────────
  const metodos = await database.getStorefrontPaymentMethods(businessId)
    .catch(() => [] as checkout.MetodoDePago[])
  const elegido = checkout.elegirMetodo(texto, metodos)

  if (!elegido) {
    const repetir = checkout.pedirMetodoPago(metodos)
    await send(`🙏 No te entendí.\n\n${repetir.reply}`, repetir.options)
    return
  }

  if (!pendiente.addressId) {
    // No debería pasar: se guarda antes de llegar aquí. Si pasa, se vuelve al
    // paso anterior en vez de crear un pedido sin destino.
    logger?.log('⚠️  [checkout] método elegido sin dirección guardada')
    await database.advanceConversation(
      customer.id, { state: 'esperando_ubicacion', businessId }, conversacion.version,
    )
    const pide = checkout.pedirUbicacion()
    await send(pide.reply, pide.options)
    return
  }

  const [productos, negocio, cuenta] = await Promise.all([
    database.getProducts(businessId).catch(() => [] as unknown[]),
    database.getBusinessById(businessId),
    elegido.requires_proof
      ? database.getBusinessBankAccount(businessId).catch(() => null)
      : Promise.resolve(null),
  ])

  const pedido = await deps.crearPedidoCompleto({
    businessId,
    customerId: customer.id,
    phone,
    contactName: customer.name,
    addressId: pendiente.addressId,
    paymentMethod: elegido.code,
    items: pendiente.items,
    products: productos,
    // El modificador que eligió en el chat (el sabor del jugo) viaja como
    // nota del pedido: la comanda del dueño lo tiene que ver aunque no sea
    // una opción del motor de personalización.
    notes: notasDeLosItems(pendiente.items),
  }).catch(() => null)

  if (!pedido) {
    logger?.log('❌ [checkout] el pedido no se pudo crear')
    const fallo = checkout.pedidoNoCreado()
    await send(fallo.reply, fallo.options)
    return
  }

  // El pedido existe: la conversación suelta el carrito. Si el método pide
  // comprobante, el pedido nació esperando pago y el buzón que ya existe
  // adjunta la foto solo — por eso aquí no hay un paso más.
  await database.advanceConversation(
    customer.id,
    { state: 'navegando', clearFlow: true, clearBusiness: true },
    conversacion.version,
  )

  const confirmacion = checkout.pedidoCreado({
    orderNumber: pedido.orderNumber,
    total: pedido.total,
    metodo: elegido,
    cuenta,
    telefonoDelLocal: (negocio as { phone?: string | null } | null)?.phone ?? null,
  })
  logger?.log(
    `✅ [checkout] pedido #${pedido.orderNumber} creado — ${elegido.code}`,
  )
  await send(confirmacion.reply, confirmacion.options)
}

/** Las elecciones del menú que no son opciones del catálogo, para la comanda. */
function notasDeLosItems(
  items: { name: string; qty: number; note?: string }[],
): string | null {
  const notas = items
    .filter(item => item.note)
    .map(item => `${item.name}: ${item.note}`)
  return notas.length ? notas.join(' · ').slice(0, 300) : null
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
