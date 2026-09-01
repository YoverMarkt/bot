import {
  esComandoMenu,
  paso,
  recordarComprobantePendiente,
  recordarPagoEnRevision,
  recordarPedidoEnProceso,
  responderAlMenu,
  verCategorias,
  verResultados,
  resolverReinicio,
  type MarketplaceBusiness,
  type MarketplaceCategory,
  type MarketplaceReply,
  type MarketplaceView,
} from './marketplace-menu'
import { optionTitle } from './bot-menu-flow'
import * as checkout from './marketplace-checkout'
import {
  esComprobante, esComprobanteAmbiguo, esFotoQueNoEsComprobante,
  preguntaDeQueLocal, rechazoDelMarcador, RESPUESTA_COMPROBANTE,
  respuestaNoEsComprobante,
  comprobanteCuadra,
  esComprobanteQueNoCuadra,
  motivoDelDescuadre,
  RESPUESTA_COMPROBANTE_CUADRA,
  respuestaComprobanteNoCuadra,
} from './payment-proof-inbox'
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
    /** El tipo decide si se pide en el chat o por la mini app. */
    type?: string | null
  } | null>
  getProducts(businessId: string): Promise<unknown[]>
  getMenuModifiers?(businessId: string): Promise<unknown[]>
  getLastOrderForContact?(
    businessId: string,
    phone: string,
  ): Promise<{ order_items?: unknown[] } | null>
  getPolicies(businessId: string): Promise<{ welcome_message?: unknown } | null>
  /**
   * ¿Se le contesta a este cliente, o ya se pasó del techo de la hora?
   *
   * Opcional para no romper a quien construya estas dependencias sin él —el
   * simulador, las pruebas—: sin la función se atiende, que es fallar abierto.
   */
  claimMarketplaceReply?(
    customerId: string,
    messageId?: string | null,
  ): Promise<{ permitido: boolean; respuestas: number }>
  /**
   * Buscar locales en TODO el marketplace, sin IA.
   *
   * ⚠️ Estuvo CONSTRUIDA Y DESCONECTADA desde el 2026-08-21: tres capas
   * (alias, texto completo, trigramas), su migración y sus pruebas, y ni un
   * llamador fuera de su repositorio. «Quiero ceviche» caía en «no te
   * entendí» aunque la base supiera resolverlo.
   */
  searchMarketplaceBusinesses?(
    query: string,
    limite?: number,
  ): Promise<{ id: string; slug: string; name: string; type: string }[]>
  /**
   * ¿Lo que escribió es comida CONOCIDA, aunque hoy no la venda nadie?
   *
   * Distingue «no te entiendo» de «te entiendo, pero no lo tengo». Sin esto,
   * «pollo» y «asdfghjkl» recibían el mismo reproche — y «pollo» se entiende
   * perfectamente: lo que falta es un asadero dado de alta.
   */
  marketplaceKnownTerm?(query: string): Promise<string | null>
  /**
   * Cancela el pedido sin pagar de esta persona en este local.
   *
   * Solo cuando el cliente dice que lo deja. Opcional: sin ella el pedido
   * caduca solo a los 15 minutos, que es lo que pasaba antes.
   */
  cancelUnpaidOrderOnPurpose?(businessId: string, customerId: string): Promise<number>
  /** ¿Este local bloqueó a este teléfono? */
  isContactBlocked?(businessId: string, phone: string): Promise<boolean>
  /**
   * ¿Toca EXPLICARLE el bloqueo? Devuelve `true` una sola vez.
   *
   * Sin esto el bloqueado recibía siempre el mismo mensaje neutro y nunca
   * sabía qué hizo mal. Avisarle en CADA intento tampoco vale: quien molesta
   * insiste, y entonces el bloqueado costaría más mensajes que un cliente.
   */
  claimBlockedNotice?(businessId: string, customerId: string): Promise<boolean>
  /**
   * ¿Está bloqueado en TODA la plataforma?
   *
   * Distinto del anterior: este lo pone el superadmin y significa que Umbani
   * entero deja de atenderlo. El del local solo cierra ese local.
   */
  isPlatformBlocked?(customerId: string): Promise<boolean>

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
  /** El motor de personalización, el mismo que usa la mini app. */
  getStorefrontOptionGroups?(businessId: string): Promise<unknown[]>
  getStorefrontOptions?(businessId: string): Promise<unknown[]>
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
   * El enlace de la tienda como BOTÓN de WhatsApp.
   *
   * Opcional: si no está, o si devuelve `false`, se manda el texto de siempre.
   * Un botón que no sale no puede costar el enlace — sin enlace no hay pedido.
   */
  sendLink?(mensaje: {
    body: string
    url: string
    label: string
    footer?: string | null
  }): Promise<boolean>
  /**
   * ¿Este TIPO de local se pide dentro del chat, o se le manda el enlace?
   *
   * ⚠️ Lo decide cuánto hay que ELEGIR para armar el pedido, no cuántos
   * productos hay: una pizzería tiene pocos productos pero pedirla es tamaño,
   * masa, borde y dos sabores; una heladería «vende un solo producto» pero lo
   * que pesa son sus veinte sabores. Los dos van a la mini app. Una
   * almuercería son tres platos del día y se piden hablando.
   *
   * Se inyecta en vez de leerse aquí para poder probar los dos lados sin
   * tocar la base.
   */
  tipoPideEnChat(businessType: string | null | undefined): Promise<boolean>
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
    items: CheckoutPendiente['items']
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
  items: {
    name: string
    qty: number
    note?: string
    productId?: string
    /** Del motor de personalización: id real, lo valida la base. */
    options?: { optionId: string; groupName: string; name: string }[]
  }[]
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
  input: {
    from: string
    text: string
    location?: InboundLocation
    /** Id del mensaje entrante: hace idempotente el reclamo del techo. */
    inboundId?: string | null
  },
  deps: MarketplaceEntryDeps,
): Promise<void> {
  const { database, send } = deps
  const { from, text, location } = input

  const customer = await database.resolveMarketplaceCustomer(from)

  // ── 0. EL TECHO DE GASTO ───────────────────────────────────────────
  //
  // Va lo PRIMERO de todo salvo por el comprobante, y el orden es el punto: el
  // número de Umbani contesta a cada mensaje, y desde el 1 de octubre de 2026
  // cada respuesta se paga. Sin techo, quinientos mensajes son quinientos
  // mensajes pagados — y no hay local al que cargárselos, porque quien molesta
  // no ha elegido ninguno.
  //
  // ⚠️ EL COMPROBANTE SE CONTESTA AUNQUE ESTÉ SILENCIADO. Quien acaba de pagar
  // no es quien molesta, y dejarlo sin respuesta con el dinero ya transferido
  // es el peor momento posible para callarse. Es la misma excepción que ya hace
  // `bot-conversation.ts` en el canal propio.
  //
  // ⚠️ Va ANTES que MENÚ, a diferencia de todo lo demás. MENÚ es la salida del
  // cliente y por eso se comprueba antes que cualquier intención, pero si el
  // techo fuera después bastaría con escribir «MENÚ» sin parar para tener
  // respuestas gratis para siempre — que es justo lo que el techo evita.
  const esMarcadorDeComprobante = esComprobante(text)
    || esFotoQueNoEsComprobante(text)
    || esComprobanteAmbiguo(text)

  // ── 0a. Bloqueado en TODA la plataforma ────────────────────────────
  //
  // Va antes que el techo porque es más fuerte y más barato: ni se cuenta ni se
  // contesta. Lo pone el superadmin, no un dueño — el bloqueo de un local se
  // comprueba mucho más abajo, al elegir ese local, porque solo cierra ese.
  //
  // ⚠️ NUNCA se le avisa, ni siquiera al comprobante: quien está bloqueado en
  // la plataforma entera no tiene ningún pedido válido esperando, y responder
  // es la reacción que busca.
  //
  // ⚠️ Falla ABIERTO: un fallo de la base no puede dejar mudo al marketplace.
  const bloqueadoEnLaPlataforma = database.isPlatformBlocked
    ? await database.isPlatformBlocked(customer.id).catch(() => false)
    : false
  if (bloqueadoEnLaPlataforma) {
    deps.logger?.log('⛔ [marketplace] contacto bloqueado en toda la plataforma: no se responde')
    return
  }

  if (!esMarcadorDeComprobante && database.claimMarketplaceReply) {
    // Falla ABIERTO: un fallo de la base no puede dejar mudo al marketplace.
    const reclamo = await database
      .claimMarketplaceReply(customer.id, input.inboundId ?? null)
      .catch(() => ({ permitido: true, respuestas: 0 }))
    if (!reclamo.permitido) {
      // Ni una palabra. Avisar al silenciado cuesta justo el mensaje que se
      // está ahorrando, y le da la reacción que busca.
      deps.logger?.log(`🔇 [marketplace] techo alcanzado (${reclamo.respuestas}): no se responde`)
      return
    }
  }

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
    // Lo pone el disparador `orders_mark_awaiting_receipt` al crear el pedido,
    // venga de la mini app o del chat. Sin él, a quien ya pidió se le decía
    // «termina tu pedido» — el pedido estaba terminado y faltaba la foto.
    esperandoComprobante: conversation?.current_state === 'esperando_comprobante',
  }
  const vista = vistaDe(conversation?.flow_state ?? null)

  // ── 1. MENÚ, antes que nada ────────────────────────────────────────
  if (esComandoMenu(text)) {
    // ⚠️ SEGUNDO MENÚ = SÍ, y esto arregla un bucle real (2026-08-23).
    //
    // El muro de «un pedido a la vez» dice literalmente «escribe *MENÚ*». El
    // cliente lo escribe, se le pregunta si tira su pedido… y como MENÚ se
    // comprueba antes que la vista, escribirlo otra vez volvía a preguntar lo
    // mismo. Para siempre. El dueño lo vivió: «sigue enviando y enviando lo
    // mismo».
    //
    // Pedir el menú DOS VECES no es una respuesta ambigua: es la misma
    // petición repetida. La regla de no decidir por él sigue en pie para todo
    // lo demás —cualquier otro texto vuelve a preguntar—, porque tirar un
    // carrito es lo único que no tiene vuelta atrás.
    if (vista.vista === 'confirmando_reinicio') {
      // ⚠️ También aquí se cancela. Escribir MENÚ dos veces es la OTRA puerta
      // para abandonar —«✅ Empezar de nuevo» normaliza a un COMANDO_MENU, así
      // que el botón entra por aquí, no por el paso 2—. Si solo cancelara una
      // de las dos, la mitad de los abandonos avisados seguirían caducando y
      // sumando falta.
      await abandonarPedido(deps, conversation?.selected_business_id, customer.id)
      const respuesta = verCategorias(categorias, 0)
      await guardar(deps, customer.id, conversation?.version, respuesta, {
        soltarLocal: true,
      })
      await send(respuesta.reply, respuesta.options)
      return
    }
    const respuesta = responderAlMenu(estado, categorias)
    // Solo se suelta el local cuando NO hay que preguntar nada. Con un pedido
    // en marcha la respuesta es la pregunta, y el carrito sigue donde estaba.
    await guardar(deps, customer.id, conversation?.version, respuesta, {
      soltarLocal: respuesta.vista.vista !== 'confirmando_reinicio',
    })
    await send(respuesta.reply, respuesta.options)
    return
  }

  // ── 1b. La foto que ya se procesó como comprobante ─────────────────
  //
  // ⚠️ Estos textos NO los escribió el cliente: los pone el webhook después de
  // haber subido y adjuntado (o rechazado) su captura. Si cayeran al menú se
  // tratarían como una BÚSQUEDA, y quien acaba de pagar recibiría «no
  // encontramos locales para [el cliente envió su comprobante…]».
  //
  // ⚠️ Va detrás de MENÚ para no romper la regla de que MENÚ se comprueba
  // antes que nada, aunque ninguno de estos marcadores pueda confundirse con
  // él. Y NO toca el estado de la conversación: el carrito, el local elegido y
  // la vista se quedan exactamente donde estaban.
  // ⚠️ El que NO CUADRA va PRIMERO, y el orden importa: su marcador contiene
  // «un pago que no corresponde a este pedido», que no lleva la subcadena de
  // `esComprobante`, pero dejarlo detrás sería confiar en esa separación para
  // siempre. Aquí el error caro es decirle «recibimos tu comprobante» a quien
  // pagó a otra cuenta: se iría a esperar una comida que nadie va a preparar.
  if (esComprobanteQueNoCuadra(text)) {
    await send(respuestaComprobanteNoCuadra(motivoDelDescuadre(text)), [])
    return
  }
  if (esComprobante(text)) {
    // Con el análisis encendido y todo cuadrando se le dice, porque es lo que
    // de verdad tranquiliza mientras el dueño mira. Sin análisis, el de
    // siempre.
    await send(
      comprobanteCuadra(text) ? RESPUESTA_COMPROBANTE_CUADRA : RESPUESTA_COMPROBANTE,
      [],
    )
    return
  }
  if (esFotoQueNoEsComprobante(text)) {
    // ⚠️ La consecuencia viaja DENTRO del marcador, igual que los nombres del
    // comprobante ambiguo: quien lo escribió ya consultó la base, y volver a
    // consultarla aquí sería pagar dos veces por el mismo dato.
    //
    // Sin cola —los marcadores que ya circulaban antes de esto— la respuesta
    // es exactamente la de siempre.
    const rechazo = rechazoDelMarcador(text)

    // ⚠️ AL BLOQUEAR, se ofrecen las DEMÁS CATEGORÍAS (2026-09-02).
    //
    // El mensaje ya decía «mientras tanto puedes pedir en los demás locales» y
    // no daba ninguno: el cliente leía una salida que no podía tomar. El dueño
    // lo pidió con estas palabras: «que me salgan las demás categorías, porque
    // sí puedo pedir en otros locales».
    //
    // ⚠️ Se puede porque el bloqueo es del LOCAL, no de la plataforma. Y se
    // puede AHORA porque al bloquear se expira su pedido, así que ya no queda
    // nada retenido — antes de eso, ofrecerle categorías lo habría llevado
    // contra el muro de «tienes un pedido en proceso».
    //
    // ⚠️ Con opciones hay que GUARDAR la vista, o tocar una categoría se lee
    // con la vista anterior y el cliente tiene que tocarla dos veces. Es el
    // fallo del 2026-08-24, y aquí volvería a entrar por esta puerta.
    if (rechazo?.blocked) {
      const portada = verCategorias(categorias, 0)
      const respuesta = {
        ...portada,
        reply: `${respuestaNoEsComprobante(rechazo)}\n\n${portada.reply}`,
      }
      await guardar(deps, customer.id, conversation?.version, respuesta, {
        soltarLocal: true,
      })
      await send(respuesta.reply, respuesta.options)
      return
    }

    await send(respuestaNoEsComprobante(rechazo), [])
    return
  }
  if (esComprobanteAmbiguo(text)) {
    // Los nombres viajan dentro del propio marcador: quien lo escribió ya
    // consultó la base, y volver a consultarla sería pagar dos veces por la
    // misma respuesta. Es el mismo desempaquetado que hace `bot-conversation`.
    const locales = String(text).split(': ').slice(1).join(': ').replace(/\]$/, '')
    await send(
      preguntaDeQueLocal(
        locales.split(' / ').filter(Boolean).map(businessName => ({
          orderId: '', orderNumber: null, businessName,
        })),
      ),
      [],
    )
    return
  }

  // ── 2. ¿Estaba respondiendo a «¿tiro tu pedido?» ───────────────────
  if (vista.vista === 'confirmando_reinicio') {
    const { reinicia, continua, respuesta } = resolverReinicio(text, estado, categorias)

    if (reinicia) {
      await abandonarPedido(deps, conversation?.selected_business_id, customer.id)
    }

    await guardar(deps, customer.id, conversation?.version, respuesta, {
      soltarLocal: reinicia,
      // ⚠️ Mientras NO reinicie, el estado del pago se conserva: si se pisara
      // con 'navegando', el «Seguir mi pedido» siguiente volvería a decir
      // «termínalo» a quien ya pidió. Al reiniciar da igual — el local se
      // suelta entero.
      conservarEstado: !reinicia
        && (conversation?.current_state === 'esperando_comprobante'
          || conversation?.current_state === 'pago_en_revision'),
    })
    // ⚠️ «Seguir mi pedido» DEVUELVE EL ENLACE (2026-09-03).
    //
    // Hasta ahora contestaba «Termina tu pedido cuando quieras 👍» y nada más:
    // una calle sin salida para quien escribió MENÚ justamente porque no
    // encontraba su enlace —lo borró, lo perdió entre mensajes, cambió de
    // teléfono—. Sus dos opciones eran tirar el pedido o seguir sin poder
    // entrar.
    //
    // Es la salida que el dueño puso como condición del enlace estricto:
    // «escribes MENÚ y listo». Sin esto, «estricto» sería una trampa.
    //
    // ⚠️ Emitirlo NO le mata la sesión que ya tenga abierta: la revocación
    // respeta el local vigente a propósito, o recargar con un token nuevo le
    // vaciaría el carrito.
    if (continua && conversation?.selected_business_id) {
      await devolverElEnlace(
        deps, customer, from, conversation.selected_business_id, respuesta,
      )
      return
    }
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
    // ⚠️ Dos textos, porque son dos situaciones. Quien está a medio armar su
    // pedido tiene que TERMINARLO; quien ya lo hizo y debe la transferencia
    // tiene que mandar una FOTO. Decirle «termínalo» al segundo lo deja
    // buscando un menú que ya completó.
    // ⚠️ TRES mensajes, no dos (2026-08-30). Quien está a medio armar su
    // pedido tiene que TERMINARLO; quien ya lo hizo y debe la transferencia
    // tiene que mandar una FOTO; y quien YA la mandó no tiene que hacer nada
    // —solo esperar—. Decirle «mándanos la foto» a quien acaba de mandarla, o
    // «termínalo» a un pedido terminado, suena a que el bot no se enteró.
    const respuesta = conversation?.current_state === 'pago_en_revision'
      ? recordarPagoEnRevision({ name: negocioActual.name })
      : conversation?.current_state === 'esperando_comprobante'
        ? recordarComprobantePendiente({ name: negocioActual.name })
        : recordarPedidoEnProceso({ name: negocioActual.name })
    // ⚠️ GUARDAR, no solo enviar (2026-08-24). Era la ÚNICA rama que respondía
    // sin persistir su vista, y el efecto no era cosmético: la respuesta ofrece
    // «✅ Empezar de nuevo», y ese texto normalizado es uno de los
    // `COMANDOS_MENU`. Sin la vista guardada, tocar ese botón se leía como MENÚ
    // con la vista ANTERIOR, así que volvía a PREGUNTAR en vez de reiniciar y
    // el cliente tenía que tocarlo dos veces —lo vivió el dueño—. Lo único que
    // evitaba que fuera un bucle infinito era el parche «segundo MENÚ = SÍ»,
    // que lo disfrazó de molestia cosmética en vez de dejarlo a la vista.
    //
    // ⚠️ `soltarLocal: false`: aquí solo se PREGUNTA. El carrito y el local
    // siguen donde estaban hasta que el cliente confirme — tirar un carrito es
    // lo único que no tiene vuelta atrás.
    await guardar(deps, customer.id, conversation?.version, respuesta, {
      soltarLocal: false,
      // ⚠️ El estado del PAGO no se pisa. `guardar` escribe 'navegando' salvo
      // en la confirmación de reinicio, y eso borraría el
      // `pago_en_revision` que puso el disparador al llegar el comprobante —
      // con él perdido, el siguiente mensaje volvería a decir «termínalo» a
      // alguien que ya pagó.
      // ⚠️ Los DOS estados que pone la BASE, no solo el de revisión: sin
      // conservar `esperando_comprobante`, el primer recordatorio lo borraba y
      // el «Seguir mi pedido» siguiente volvía a decir «termínalo».
      conservarEstado: conversation?.current_state === 'pago_en_revision'
        || conversation?.current_state === 'esperando_comprobante',
    })
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
    let negocios: MarketplaceBusiness[] = []
    if (vistaActual.vista === 'negocios' && vistaActual.categoria) {
      negocios = await database.getMarketplaceBusinesses(vistaActual.categoria)
    } else if (vistaActual.vista === 'busqueda' && vistaActual.consulta) {
      // Se repite la búsqueda en vez de guardar los resultados: mantiene el
      // `flow_state` pequeño y la lista fresca. Falla hacia una lista vacía,
      // que `paso` resuelve devolviendo al cliente a las categorías.
      negocios = await buscarLocales(deps, vistaActual.consulta)
    }
    respuesta = paso({
      // ⚠️ En el segundo intento va VACÍO a propósito: el mensaje ya se
      // consumió al elegir la categoría, y esta llamada solo sirve para
      // pintar los locales que se acaban de consultar.
      mensaje: intento === 0 ? text : '',
      vista: vistaActual,
      categorias,
      negocios,
      // Nunca había escrito: su «hola» merece una bienvenida, no un reproche.
      primerContacto: !conversation,
    })
    if (respuesta.reply || respuesta.negocioElegido) break
    vistaActual = respuesta.vista
  }

  // ── El cliente llegó a un local: se le manda su enlace ─────────────
  if (respuesta.negocioElegido) {
    await entregarLocal(deps, customer, from, respuesta.negocioElegido, conversation?.version)
    return
  }

  // ── 7. No casó con el menú: quizá está BUSCANDO ────────────────────
  //
  // «Quiero ceviche» no es una opción equivocada: es un cliente diciendo lo
  // que quiere. La búsqueda existía desde el 2026-08-21 —alias curados, texto
  // completo en español y trigramas— y **no la llamaba nadie**, así que esa
  // frase recibía «🙏 No te entendí» aunque la base supiera resolverla.
  //
  // ⚠️ Va DESPUÉS del menú, no antes: si se buscara primero, «1» o «Pizzerías»
  // se tratarían como texto libre y el cliente que está eligiendo de la lista
  // acabaría en una búsqueda. El menú manda; buscar es la segunda oportunidad.
  //
  // ⚠️ Solo cuando `paso` no entendió Y no hay local elegido: dentro de un
  // local el ámbito es ese local, y traerle el ceviche de otro negocio metería
  // en el carrito un producto que no puede estar ahí.
  //
  // ⚠️ Falla hacia el mensaje de siempre: si la búsqueda revienta o no
  // encuentra nada, el cliente recibe exactamente lo que recibía antes.
  if (respuesta.noEntendido && !conversation?.selected_business_id) {
    const encontrados = await buscarLocales(deps, text)
    if (encontrados.length) {
      const resultados = verResultados(text, encontrados, 0)
      deps.logger?.log(`🔎 [marketplace] «${text}» encontró ${encontrados.length} local(es)`)
      await guardar(deps, customer.id, conversation?.version, resultados, { soltarLocal: false })
      await send(resultados.reply, resultados.options)
      return
    }

    // ── No hay locales… ¿pero le entendimos? ─────────────────────────
    //
    // «pollo» y «asdfghjkl» recibían EXACTAMENTE el mismo «🙏 No te entendí»,
    // y no son lo mismo: el alias de «pollo» existe y apunta a `asados`, así
    // que se le entendió — lo que falta es un asadero dado de alta. Decirle
    // que no se le entendió cuando escribió bien es de las cosas que hacen
    // que una app parezca tonta, y es justo el cliente que SÍ sabe lo que
    // quiere.
    //
    // ⚠️ Falla hacia el mensaje de siempre: si esto revienta o el término no
    // está en el diccionario, se responde lo que se respondía antes.
    const conocido = database.marketplaceKnownTerm
      ? await database.marketplaceKnownTerm(text).catch(() => null)
      : null
    if (conocido) {
      const portada = verCategorias(categorias, 0)
      const aviso = {
        ...portada,
        reply: `😔 Todavía no tenemos *${conocido}* por aquí.\n\n`
          + `Esto es lo que sí puedes pedir hoy 👇`,
      }
      deps.logger?.log(`🔎 [marketplace] «${text}» → ${conocido}, sin locales`)
      await guardar(deps, customer.id, conversation?.version, aviso, { soltarLocal: false })
      await send(aviso.reply, aviso.options)
      return
    }
  }

  await guardar(deps, customer.id, conversation?.version, respuesta, { soltarLocal: false })
  await send(respuesta.reply, respuesta.options)
}

/**
 * Los locales que casan con lo que escribió el cliente.
 *
 * ⚠️ Nunca lanza: la búsqueda es una MEJORA sobre «no te entendí», así que un
 * fallo suyo devuelve al cliente exactamente lo que recibía antes en vez de
 * dejarlo sin respuesta. `prep_min` va a null porque la RPC no lo devuelve y
 * el menú solo lo usa para pintar tiempos de la categoría.
 */
async function buscarLocales(
  deps: MarketplaceEntryDeps,
  consulta: string,
): Promise<MarketplaceBusiness[]> {
  const texto = String(consulta || '').trim()
  if (!texto || !deps.database.searchMarketplaceBusinesses) return []
  const hits = await deps.database
    .searchMarketplaceBusinesses(texto, 9)
    .catch(() => [])
  return hits.map(hit => ({
    id: hit.id, slug: hit.slug, name: hit.name, type: hit.type, prep_min: null,
  }))
}

/**
 * El cliente eligió local. Aquí se decide CÓMO va a pedir.
 *
 * ⚠️ LO DECIDE EL TIPO DE LOCAL, no cuántos productos tiene. Corrección del
 * dueño del 2026-08-23, y la razón es que las dos cosas no miden lo mismo:
 *
 *   «una pizzería puede tener 10 productos pero al momento de elegir tiene
 *    muchas opciones, así como una heladería puede tener 10 helados pero
 *    muchos sabores: eso son mini app. Pero un restaurante que ofrece
 *    almuerzos solo, queda pedir por WhatsApp.»
 *
 * Hasta esa fecha se contaban PRODUCTOS (la «regla de los 20»): hasta 20 se
 * pedía en el chat. Con ese criterio Monster Pizza —17 productos— caía en el
 * chat, y pedir una pizza por lista de WhatsApp es tamaño, masa, borde y dos
 * sabores. Lo que pesa es cuánto hay que ELEGIR, no cuánto hay en la carta.
 *
 * ⚠️ El criterio ya existía —`PEDIDO_SIMPLE` en el panel del admin, con estos
 * mismos ejemplos— pero vivía solo ahí, donde el servidor no podía leerlo, y
 * la regla de los 20 lo sobrescribía. Ahora vive en
 * `marketplace_category_types.pide_en_chat`: una sola fuente para el panel y
 * para el servidor, y reclasificable sin desplegar.
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

  // ── ¿Este local bloqueó a este cliente? ────────────────────────────
  //
  // El bloqueo YA le impedía pedir —la tienda responde 403 y el disparador
  // `orders_reject_blocked` rechaza la inserción—, pero hasta aquí el menú le
  // entregaba igualmente el enlace: el cliente armaba su carrito entero y
  // descubría el rechazo AL CONFIRMAR, que es el peor momento para enterarse.
  //
  // ⚠️ Es del LOCAL, no de la plataforma: bloquear en El Puerto no puede dejar
  // a nadie fuera de Umbani entero. Por eso se comprueba al elegir local y no
  // a la entrada — y por eso el resto del menú sigue igual para él.
  //
  // ⚠️ Se le explica UNA VEZ, y solo una (decisión del dueño, 2026-08-25).
  // Hasta esa fecha no se le decía NUNCA —quien pide para molestar busca una
  // reacción, y avisar cuesta el mensaje que el bloqueo ahorra—, pero callando
  // siempre, el cliente bloqueado por no recoger sus pedidos no se enteraba de
  // qué hizo mal, y el bloqueado por error tampoco. El reclamo da la
  // explicación en su primer intento y vuelve al mensaje neutro después, así
  // el bloqueado nunca cuesta más mensajes que un cliente normal.
  //
  // ⚠️ El texto NO promete que sea temporal: hoy `blocked_at` no caduca, y lo
  // levanta el dueño. Prometer un plazo que el sistema no cumple es cómo nació
  // el fallo del número del 2026-08-23.
  //
  // ⚠️ Falla ABIERTO: si la consulta revienta se atiende. Dejar a un cliente
  // legítimo fuera de un local por un fallo nuestro es peor que dejar entrar a
  // un bloqueado, que además no va a poder cerrar el pedido.
  const bloqueado = database.isContactBlocked
    ? await database.isContactBlocked(negocio.id, phone).catch(() => false)
    : false
  if (bloqueado) {
    logger?.log(`⛔ [marketplace] ${negocio.slug} tiene bloqueado a este contacto`)
    // La PRIMERA vez se le explica; a partir de la segunda vuelve el mensaje
    // neutro. Falla hacia el silencio, que es la conducta anterior a esto.
    const toca = database.claimBlockedNotice
      ? await database.claimBlockedNotice(negocio.id, customer.id).catch(() => false)
      : false
    // ⚠️ También aquí las CATEGORÍAS (2026-09-02): el texto ofrecía «escribe
    // MENÚ para elegir otro local» y hacía teclear para llegar a una lista que
    // cabe en el mismo mensaje. El bloqueo es del LOCAL; los demás siguen
    // abiertos para esta persona.
    const otras = verCategorias(await database.getMarketplaceCategories().catch(() => []), 0)
    await deps.send(
      toca
        ? `⛔ *${negocio.name}* pausó tus pedidos.\n\n`
          + 'Suele pasar cuando quedan pedidos sin confirmar o sin recoger. '
          + 'Si crees que es un error, comunícate directamente con el local '
          + 'para resolverlo.\n\n'
          + 'Mientras tanto puedes pedir en otros locales 👇'
        : `😕 *${negocio.name}* no está recibiendo pedidos tuyos ahora mismo. `
          + 'Elige otro local aquí abajo 👇',
      otras.options,
    )
    // Con opciones, la vista se guarda o el toque siguiente no se entiende.
    if (otras.options.length) {
      await database.advanceConversation(
        customer.id,
        { state: 'navegando', flowState: { vista: otras.vista }, clearBusiness: true },
        version,
      ).catch(() => ({ conflicto: false }))
    }
    return
  }

  // Ante cualquier fallo se manda el ENLACE: la tienda atiende cualquier
  // catálogo y cualquier cantidad de opciones, mientras que un menú de chat
  // mal elegido deja al cliente recorriendo listas interminables. Se falla
  // hacia lo que siempre funciona.
  const enElChat = await deps.tipoPideEnChat(negocio.type).catch(() => false)

  await database.advanceConversation(
    customer.id,
    {
      state: enElChat ? 'pidiendo' : 'en_local',
      businessId: negocio.id,
      // ⚠️ A partir de aquí el cliente ESTÁ pidiendo en este local: con el
      // enlace ya tiene su tienda abierta con su token, y en el chat va a
      // empezar a llenar el carrito. Cambiarlo de local en silencio le
      // tiraría lo que lleva —y le dejaría una mini app abierta que ya no
      // lleva a ninguna parte—, así que a partir de ahora se le PREGUNTA.
      //
      // Se suelta al crear el pedido o al reiniciar con MENÚ. Hasta el
      // 2026-08-22 esta columna existía y NADIE la ponía en `true`: el
      // bloqueo estaba escrito, probado… y nunca se activaba.
      shoppingLocked: true,
      // El menú del local empieza limpio: `advanceMenuFlowConEstado` con
      // estado nulo devuelve la bienvenida y el menú principal.
      flowState: { vista: { vista: 'negocios', categoria: negocio.type, pagina: 0 } },
    },
    version,
  )

  logger?.log(
    `🏬 [marketplace] ${negocio.slug} (${negocio.type || 'sin tipo'}) → ${enElChat ? 'chat' : 'enlace'}`,
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

  // ⚠️ BOTÓN primero, y el texto solo si el botón no sale (2026-08-29).
  //
  // Una URL cruda ocupa tres líneas, se parte en pantallas estrechas y se lee
  // como publicidad: la gente no la toca. `sendLinkButton` y
  // `storefrontInviteButton` existían desde el 2026-08-12 para el canal propio
  // y **nadie los llamaba desde el marketplace**, que es donde están hoy todos
  // los clientes.
  //
  // ⚠️ La etiqueta va SIN EMOJI y corta: WhatsApp la limita a 20 BYTES y un
  // emoji gasta cuatro. El adorno se queda en el cuerpo, que admite 1024.
  const enviadoComoBoton = deps.sendLink
    ? await deps.sendLink({
      body: `🛍️ *${negocio.name}*\n\nArma tu pedido aquí 👇`,
      url,
      label: 'Ver la carta',
      footer: 'Para volver al inicio, escribe MENÚ',
    }).catch(() => false)
    : false
  if (enviadoComoBoton) return

  await send(
    `🛍️ *${negocio.name}*\n\nArma tu pedido aquí 👇\n${url}\n\n`
    + 'Cuando termines te aviso por aquí mismo. Para volver al inicio, escribe *MENÚ*.',
    [],
  )
}

/**
 * El cliente dijo en voz alta que deja su pedido: se cancela en el momento.
 *
 * ⚠️ Hasta el 2026-09-04 ese pedido seguía vivo hasta caducar, y al caducar le
 * sumaba una falta de «pedido sin pagar» — la MISMA que suma quien nunca
 * volvió a contestar. **Avisar y desaparecer no pueden costar lo mismo**, o no
 * hay ningún motivo para avisar; y sin motivo para avisar, todos los
 * abandonos son silenciosos.
 *
 * ⚠️ Lo llaman las DOS puertas de reinicio: el botón «✅ Empezar de nuevo»
 * —que normaliza a un `COMANDO_MENU` y entra por el paso 1— y la respuesta a
 * la confirmación. Si solo lo hiciera una, la mitad de los abandonos avisados
 * seguirían costando una falta.
 *
 * ⚠️ Falla en silencio: si cancelar no sale, el pedido caduca solo a los 15
 * minutos como siempre. Nunca puede impedirle reiniciar.
 */
async function abandonarPedido(
  deps: MarketplaceEntryDeps,
  businessId: string | null | undefined,
  customerId: string,
): Promise<void> {
  if (!businessId || !deps.database.cancelUnpaidOrderOnPurpose) return
  const cancelados = await deps.database
    .cancelUnpaidOrderOnPurpose(businessId, customerId)
    .catch(() => 0)
  if (cancelados) {
    deps.logger?.log(`🚪 [marketplace] se fue avisando: ${cancelados} pedido(s) cancelado(s)`)
  }
}

/**
 * «Seguir mi pedido»: se le recuerda dónde está y se le devuelve su enlace.
 *
 * ⚠️ Solo con los locales de MINI APP. En los que se piden dentro del chat no
 * hay enlace que dar —el pedido se arma aquí mismo—, y el siguiente mensaje ya
 * lo devuelve a su menú.
 *
 * ⚠️ Falla hacia el texto de siempre. Quedarse sin enlace no puede dejar sin
 * respuesta a alguien que acaba de decir que sigue con su pedido.
 */
async function devolverElEnlace(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  businessId: string,
  respuesta: MarketplaceReply,
): Promise<void> {
  const { database, send, logger } = deps
  const business = await database.getBusinessById(businessId).catch(() => null)

  const enElChat = business
    ? await deps.tipoPideEnChat(business.type).catch(() => false)
    : false
  if (!business || enElChat) {
    await send(respuesta.reply, respuesta.options)
    return
  }

  const url = await deps.issueLink({
    business,
    phone,
    name: customer.name,
    // Lo acaba de pedir con todas las letras: el cooldown no aplica.
    force: true,
  })
  if (!url) {
    logger?.log(`⚠️  [marketplace] «seguir mi pedido» sin enlace para ${business.slug}`)
    await send(respuesta.reply, respuesta.options)
    return
  }

  // Mismo botón que al entregar el local: es el mismo enlace y el mismo toque.
  const enviadoComoBoton = deps.sendLink && !respuesta.options.length
    ? await deps.sendLink({
      body: respuesta.reply,
      url,
      label: 'Ver la carta',
      footer: 'Para volver al inicio, escribe MENÚ',
    }).catch(() => false)
    : false
  if (enviadoComoBoton) return

  await send(`${respuesta.reply}\n\nSigue aquí 👇\n${url}`, respuesta.options)
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

  const [productos, modifiers, lastOrder, policies, grupos, opcionesDelMotor] = await Promise.all([
    database.getProducts(businessId).catch(() => [] as unknown[]),
    database.getMenuModifiers
      ? database.getMenuModifiers(businessId).catch(() => [] as unknown[])
      : Promise.resolve([] as unknown[]),
    database.getLastOrderForContact
      ? database.getLastOrderForContact(businessId, phone).catch(() => null)
      : Promise.resolve(null),
    database.getPolicies(businessId).catch(() => null),
    // El MISMO motor que usa la mini app. Sin esto, el chat seguiría con
    // `menu_modifiers`: un texto suelto colgado de la categoría entera, que
    // preguntaba el sabor antes de saber si el cliente quería jugo o cola.
    database.getStorefrontOptionGroups
      ? database.getStorefrontOptionGroups(businessId).catch(() => [])
      : Promise.resolve([]),
    database.getStorefrontOptions
      ? database.getStorefrontOptions(businessId).catch(() => [])
      : Promise.resolve([]),
  ])
  const catalogoDeOpciones = opcionesDelMotor

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
    optionGroups: grupos as MenuFlowInput['optionGroups'],
    options: catalogoDeOpciones as MenuFlowInput['options'],
    // Para los grupos que cuelgan de una CATEGORÍA y no de un producto.
    productCategories: Object.fromEntries(
      (productos as Array<{ id?: string; category_id?: string | null }>)
        .filter(producto => producto.id)
        .map(producto => [producto.id as string, producto.category_id ?? null]),
    ),
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
        ...(item.productId ? { productId: item.productId } : {}),
        ...(item.options?.length ? { options: item.options } : {}),
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

  // ⚠️ El motivo se conserva cuando la BASE rechazó el pedido por una regla que
  // el cliente PUEDE resolver —ya tiene tres sin confirmar—. Antes se tragaba
  // el error entero y recibía «fallo técnico, no reintentes»: ni era verdad, ni
  // le decía qué hacer, y le dejaba pensando que el fallo era nuestro.
  let pedido: { orderNumber: number | null; total: unknown } | null = null
  let rechazo: string | null = null
  try {
    pedido = await deps.crearPedidoCompleto({
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
    })
  } catch (error) {
    rechazo = error instanceof Error ? error.message : null
  }

  if (!pedido) {
    logger?.log(`❌ [checkout] el pedido no se pudo crear${rechazo ? ` (${rechazo})` : ''}`)
    const fallo = checkout.pedidoNoCreado(rechazo)
    await send(fallo.reply, fallo.options)
    return
  }

  // ── El carrito se suelta; el CANDADO, solo si ya no debe nada ───────────
  //
  // ⚠️ Hasta el 2026-08-30 esto soltaba el bloqueo SIEMPRE, con un
  // `clearBusiness: true` que además apaga `shopping_locked` en la base. O sea
  // que crear el pedido dejaba vía libre para empezar otro en otro local sin
  // haber mandado el comprobante — y sin escribir MENÚ siquiera. Combinado con
  // un tope que contaba por local, el salto entre locales salía gratis:
  // «pido aquí, no pago, pido allá».
  //
  // Ahora se distingue por el estado en que NACIÓ el pedido:
  //
  //   · `esperando_pago` (transferencia) — el cliente debe el comprobante. Se
  //     suelta el carrito y la vista, pero el LOCAL y el candado se quedan.
  //     Los suelta `orders_release_shopping_lock` cuando el pedido salga de
  //     ese estado, y MENÚ sigue siendo la salida de siempre.
  //   · Cualquier otro (efectivo, pago al retirar) — no debe nada: se suelta
  //     todo como antes.
  //
  // ⚠️ El candado se suelta en la BASE, no aquí, y es deliberado: el pedido se
  // resuelve por caminos que no pasan por este archivo —el botón del dueño, el
  // barrido que caduca los impagados, y mañana los motorizados—. Un disparador
  // los cubre todos; una línea de TypeScript solo cubre este.
  // ⚠️ Se pregunta por el MÉTODO, no por `requires_proof`, porque es lo que
  // mira la base: `create_storefront_order` hace
  // `case when p_payment_method = 'transferencia' then 'esperando_pago' else
  // 'pendiente' end`. Usar el otro campo daría dos reglas para lo mismo, y el
  // día que se separen el candado quedaría puesto sobre pedidos que no deben
  // nada — o suelto sobre los que sí.
  const debeComprobante = elegido.code === 'transferencia'
  await database.advanceConversation(
    customer.id,
    debeComprobante
      // Sin `clearBusiness`: apagaría el candado de paso, que es justo lo que
      // aquí no se quiere. El local elegido se queda con él.
      ? { state: 'esperando_comprobante', clearFlow: true }
      : { state: 'navegando', clearFlow: true, clearBusiness: true, shoppingLocked: false },
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
  items: CheckoutPendiente['items'],
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
  opciones: {
    soltarLocal: boolean
    /**
     * No tocar `current_state`.
     *
     * La RPC hace `coalesce(p_state, conv.current_state)`, así que un nulo lo
     * conserva. Hace falta para los estados que NO los pone el menú sino la
     * base —`pago_en_revision`, que escribe el disparador al llegar el
     * comprobante—: escribir 'navegando' encima los borraría y el bot
     * respondería lo de antes de pagar.
     */
    conservarEstado?: boolean
  },
): Promise<void> {
  await deps.database.advanceConversation(
    customerId,
    {
      // `undefined`, no `null`: el repositorio hace `patch.state ?? null` y la
      // RPC `coalesce(p_state, conv.current_state)`, así que omitirlo conserva
      // el estado. Ponerlo en `null` explícito choca con el tipo del parche.
      state: opciones.conservarEstado
        ? undefined
        : respuesta.vista.vista === 'confirmando_reinicio'
          ? 'confirmando_reinicio'
          : 'navegando',
      flowState: { vista: respuesta.vista },
      ...(opciones.soltarLocal ? { clearBusiness: true } : {}),
    },
    version,
  )
}
