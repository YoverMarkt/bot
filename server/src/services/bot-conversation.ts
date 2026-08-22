import type {
  ActionBusiness,
  ActionProduct,
  ActionSession,
} from './bot-actions'
import type { ParsedBotOutput } from './bot-tags'
import type { MenuFlowInput, MenuFlowResult } from './bot-menu-flow'
import {
  RESPUESTA_COMPROBANTE, esComprobante, esComprobanteAmbiguo, preguntaDeQueLocal,
} from './payment-proof-inbox'
import type {
  BotMediaBusiness,
  BotMediaHistoryMessage,
  BotMediaProduct,
  SendRequestedProductMediaInput,
} from './bot-media'

interface ConversationBusiness extends ActionBusiness, BotMediaBusiness {
  /** Para ofrecérselo a quien lleva cinco mensajes y no se aclara con la app. */
  phone?: string | null
  suspended?: boolean | null
  bot_active?: boolean | null
  ai_provider?: string | null
  // 'menu' → la conversación la conduce bot-menu-flow (sin IA)
  chat_mode?: string | null
  // Para el enlace de la mini app: la URL se arma con el slug real.
  slug?: string | null
  storefront_enabled?: boolean | null
}

interface ConversationProduct extends ActionProduct, BotMediaProduct {
  id?: string
  tags?: string[] | null
}

interface ConversationSession extends ActionSession {
  manual_mode?: boolean | null
  closed_sale_at?: string | null
}

interface ConversationHistory extends BotMediaHistoryMessage {
  role?: string | null
}

interface ConversationDatabase {
  getSession(businessId: string, phone: string): Promise<ConversationSession | null>
  saveMessage(
    businessId: string,
    phone: string,
    role: string,
    content: string,
  ): Promise<unknown>
  upsertSession(
    businessId: string,
    phone: string,
    data: Record<string, unknown>,
  ): Promise<unknown>
  getSchedule(businessId: string): Promise<unknown[]>
  getPolicies(businessId: string): Promise<unknown>
  getContactHistory(
    businessId: string,
    phone: string,
    limit: number,
    after?: string | null,
  ): Promise<ConversationHistory[]>
  countProducts(businessId: string): Promise<number>
  searchProductsByVector(
    businessId: string,
    embedding: number[],
    limit: number,
  ): Promise<ConversationProduct[]>
  getProducts(businessId: string): Promise<ConversationProduct[]>
  // Solo los usa el modo menú
  getMenuModifiers?(businessId: string, categoryTag?: string | null): Promise<Record<string, unknown>[]>
  getLastOrderForContact?(
    businessId: string,
    contactPhone: string,
  ): Promise<{ order_items?: Record<string, unknown>[] } | null>
  recordConsultations(businessId: string, productIds: string[]): Promise<unknown>
  // Modo mini app: quién es el cliente y si toca mandarle el enlace.
  resolveCustomer(input: {
    businessId: string
    phone: string
    name?: string | null
  }): Promise<{ id: string }>
  claimStorefrontLinkSend(businessId: string, customerId: string): Promise<boolean>
  /**
   * ¿El dueño bloqueó este número? Vale para todos los modos.
   *
   * ⚠️ OPCIONAL como el resto de capacidades nuevas de esta interfaz. No es
   * pereza de tipado: quien monte esta conversación con una base parcial —los
   * arneses de prueba, el simulador— no puede reventar por una función que
   * todavía no conoce. Sin ella no hay bloqueo, que es exactamente como se
   * comportaba el bot antes de que existiera.
   */
  isContactBlocked?(businessId: string, phone: string): Promise<boolean>
  /** Cuenta la respuesta y decide si sale, con teléfono, o si toca callar. */
  claimMiniappReply?(businessId: string, customerId: string, limites?: {
    mensajeId?: string | null
  }): Promise<{
    permitido: boolean
    motivo: 'ok' | 'con_telefono' | 'bloqueado' | 'silenciado'
    respuestas: number
  }>
}

interface ConversationReports {
  handleOwnerMessage(
    business: ConversationBusiness,
    phone: string,
    text: string,
  ): Promise<{ handled: boolean; reply: string }>
}

interface ConversationSchedule {
  isOutsideHours(schedule: unknown[]): boolean
  buildScheduleMessage(business: ConversationBusiness, schedule: unknown[]): string
}

interface ConversationAi {
}


interface ConversationTags {
  detectMediaRequest(text: string): { wantsImage: boolean; wantsVideo: boolean }
  isInsultMessage(text: string): boolean
  parseBotOutput(reply: string): ParsedBotOutput
  impersonatesOfficialSummary(text: string): boolean
}

interface ConversationActions {
  handleConversationOutcome(input: {
    business: ActionBusiness
    phone: string
    originalText: string
    hasSale: boolean
    hasHandoffTag: boolean
    isUncertain: boolean
    wasManual?: boolean | null
    send(message: string): Promise<unknown>
  }): Promise<{ handled: boolean }>
  processOrderPayload(input: {
    business: ActionBusiness
    phone: string
    session?: ActionSession | null
    payload: string | null
    items?: { name: string; qty: number; note?: string | null }[]
    products: ActionProduct[]
    preFiltered: boolean
    send(message: string): Promise<unknown>
  }): Promise<boolean>
}

interface ConversationMedia {
  sendRequestedProductMedia(input: SendRequestedProductMediaInput): Promise<boolean>
}

interface ConversationLogger {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
}

interface ConversationMenuFlow {
  advanceMenuFlow(input: MenuFlowInput): MenuFlowResult
}

interface ConversationStorefrontLink {
  issueLink(input: {
    business: { id: string; slug?: string | null; storefront_enabled?: boolean | null
      takes_orders?: boolean | null }
    phone: string
    name?: string | null
    /** Salta el cooldown en memoria: en modo mini app decide la base. */
    force?: boolean
  }): Promise<string | null>
  storefrontInvite(
    business: { takes_orders?: boolean | null },
    url: string,
    opciones?: { repetido?: boolean; telefonoDeAyuda?: string | null },
  ): string
  /** El mismo enlace, listo para ir como botón nativo del canal. */
  storefrontInviteButton(
    business: { takes_orders?: boolean | null },
    url: string,
    opciones?: { repetido?: boolean; telefonoDeAyuda?: string | null },
  ): { body: string; url: string; label: string; footer: string }
}

/**
 * Lo que se responde cuando el cliente sigue escribiendo dentro de la ventana
 * de 24 h. Corto a propósito: no es una conversación, es una señal.
 */
export const MINIAPP_RECORDATORIO =
  'Usa el enlace que te envié para ver los productos y hacer tu pedido 🛍️'

export interface BotConversationDependencies {
  database: ConversationDatabase
  reports: ConversationReports
  schedule: ConversationSchedule
  ai: ConversationAi
  tags: ConversationTags
  actions: ConversationActions
  media: ConversationMedia
  menuFlow: ConversationMenuFlow
  // Enlace de la mini app. Opcional: sin él el bot atiende igual por chat, que
  // es exactamente como funcionaba antes de que la tienda existiera.
  storefrontLink?: ConversationStorefrontLink
  logger?: ConversationLogger
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  // Vigilante de precios: comprueba que la IA no cite montos que no existen en
  // el catálogo. Opcional para no obligar a cada prueba a montarlo.
}

export interface ConversationPriceGuard {
  check(input: {
    text: unknown
    allowedAmounts: Array<number | string | null | undefined>
  }): { ok: boolean; invented: number[]; quoted: number[] }
  mode(): 'observar' | 'bloquear'
  onInvented(input: {
    businessId: string
    invented: number[]
    text: string
  }): void
}

export interface ProcessMessageInput {
  business: ConversationBusiness
  phone: string
  text: string
  send(message: string): Promise<unknown>
  sendImage?: (
    url: string,
    caption?: string,
    deliveryMode?: 'queued' | 'direct',
  ) => Promise<unknown>
  sendTyping?: () => Promise<unknown>
  sendVideo?: (
    url: string,
    caption?: string,
    deliveryMode?: 'queued' | 'direct',
  ) => Promise<unknown>
  // Menú con botones/listas nativas. Devuelve false si el canal no lo soporta
  // y entonces las opciones se mandan numeradas como texto.
  sendOptions?: (
    body: string,
    options: { id: string; title: string; description?: string }[],
    deliveryMode?: 'queued' | 'direct',
  ) => Promise<boolean>
  // El enlace de la tienda como BOTÓN nativo. Devuelve false si el canal no lo
  // soporta o si el envío falla, y entonces el enlace sale como texto — que es
  // como salía hasta el 2026-08-12.
  sendLink?: (
    message: { body: string; url: string; label: string; footer?: string | null },
  ) => Promise<boolean>
  /**
   * El id del mensaje ENTRANTE, si el canal lo da.
   *
   * Solo se usa para no contar dos veces la misma respuesta en el techo: la
   * entrada es at-least-once y un reintento del worker vuelve a pasar por
   * aquí. Sin id se cuenta como antes — el riesgo de contar de más es menor
   * que el de no contar.
   */
  inboundId?: string | null
}

const PROMPT_PICK_OPTION = 'Elige una opción 👇'
const OFF_HOURS_RENOTIFY = 6 * 60 * 60 * 1000
const defaultSleep = (milliseconds: number) => new Promise<void>(resolve => {
  setTimeout(resolve, milliseconds)
})

function mentionedProductIds(products: ConversationProduct[], text: string): string[] {
  const normalizedText = text.toLowerCase()
  return products.filter(product => {
    const name = (product.name || '').toLowerCase()
    if (name && normalizedText.includes(name)) return true
    if (name.split(/\s+/).some(word => (
      word.length > 3 && normalizedText.includes(word)
    ))) return true
    if (product.brand && product.brand.length > 2
      && normalizedText.includes(product.brand.toLowerCase())) return true
    return (product.tags || []).some(tag => (
      tag && tag.length > 3 && normalizedText.includes(tag.toLowerCase())
    ))
  }).slice(0, 5).flatMap(product => product.id ? [product.id] : [])
}

function createBotConversation(dependencies: BotConversationDependencies) {
  const {
    database, reports, schedule, tags, actions, menuFlow, storefrontLink,
  } = dependencies
  const logger = dependencies.logger || console
  const sleep = dependencies.sleep || defaultSleep
  const now = dependencies.now || Date.now
  const offHoursNotified = new Map<string, number>()

  async function humanizedSend(
    text: string,
    send: (message: string) => Promise<unknown>,
    sendTyping?: () => Promise<unknown>,
  ): Promise<void> {
    let parts = String(text || '').split(/\n\s*\n+/)
      .map(part => part.trim()).filter(Boolean)
    if (!parts.length) parts = [String(text || '')]
    if (parts.length > 3) {
      parts = [
        parts.slice(0, parts.length - 2).join('\n\n'),
        parts[parts.length - 2] as string,
        parts[parts.length - 1] as string,
      ]
    }
    for (const part of parts) {
      if (sendTyping) {
        try { await sendTyping() } catch { /* best-effort */ }
      }
      await sleep(Math.min(4500, 900 + part.length * 28))
      await send(part)
    }
  }

  // ── MODO MENÚ (sin IA) ──────────────────────────────────────────────
  // Las opciones se envían numeradas: hoy WhatsApp solo recibe texto desde
  // esta integración. El motor acepta tanto el texto exacto como el número,
  // así que al agregar botones nativos el flujo no cambia.
  function renderMenuOptions(reply: string, options: MenuFlowResult['options']): string {
    if (!options.length) return reply
    const list = options.map((option, index) => {
      const title = typeof option === 'string' ? option : option.title
      const detail = typeof option === 'string' ? '' : option.description
      return detail ? `${index + 1}. ${title} — ${detail}` : `${index + 1}. ${title}`
    }).join('\n')
    return reply ? `${reply}\n\n${list}` : list
  }

  /**
   * Crea el enlace de la mini app y lo devuelve ya redactado, o '' si no
   * corresponde (el negocio no tiene tienda, falta BASE_URL, o se mandó hace
   * poco). Nunca lanza: quedarse sin enlace no puede tumbar la conversación —
   * el cliente sigue siendo atendido por chat como toda la vida.
   */
  async function storefrontUrlFor(
    business: ConversationBusiness,
    phone: string,
    name?: string | null,
    /** En modo mini app la ventana de 24 h ya la decidió la base, así que el
        cooldown en memoria de `issueLink` no debe volver a filtrar y dejar al
        cliente sin enlace. */
    force = false,
  ): Promise<string | null> {
    if (!storefrontLink) return null
    try {
      const url = await storefrontLink.issueLink({ business, phone, name, force })
      if (!url) return null
      logger.log(`🛍️ [${business.name}] enlace de tienda enviado a ${phone}`)
      return url
    } catch {
      return null
    }
  }

  /**
   * Manda la invitación por el mejor formato que admita el canal.
   *
   * WhatsApp con YCloud la recibe como BOTÓN nativo (`cta_url`) desde el
   * 2026-08-12: una URL cruda ocupa tres líneas, se parte en pantallas
   * estrechas y se lee como publicidad. Telegram, Meta directo y el simulador
   * la reciben como el texto de siempre.
   *
   * ⚠️ El texto NO es un plan B triste: es el respaldo que garantiza que el
   * enlace SIEMPRE sale. En modo mini app ese enlace es lo único que le permite
   * pedir al cliente, así que un botón rechazado por el canal no puede
   * traducirse en silencio. Por eso `sendLink` devuelve false en vez de lanzar,
   * y aquí se cae al texto sin ruido.
   *
   * ⚠️ En el historial se guarda SIEMPRE el texto, con la URL a la vista. El
   * dueño lee su panel para saber qué se le mandó a un cliente, y «botón» no
   * le dice a dónde apuntaba.
   */
  async function enviarInvitacion(input: {
    business: ConversationBusiness
    url: string
    send: (message: string) => Promise<unknown>
    sendLink?: ProcessMessageInput['sendLink']
    /** Ya se le mandó hace poco: cambia el texto, nunca el envío. */
    repetido?: boolean
    /** A partir de la quinta respuesta en una hora, a quién llamar. */
    telefonoDeAyuda?: string | null
  }): Promise<string> {
    const { business, url, send, sendLink, repetido = false } = input
    const opciones = { repetido, telefonoDeAyuda: input.telefonoDeAyuda || null }
    // El texto se redacta siempre, salga o no por él: es lo que se guarda en
    // el historial para que el dueño vea a dónde apuntaba lo que se mandó.
    const texto = storefrontLink
      ? storefrontLink.storefrontInvite(business, url, opciones)
      : url
    if (sendLink && storefrontLink) {
      try {
        const enviado = await sendLink(
          storefrontLink.storefrontInviteButton(business, url, opciones),
        )
        if (enviado) return texto
      } catch { /* el canal no pudo con el botón: sale el texto */ }
    }
    await send(texto)
    return texto
  }

  /**
   * MODO MINI APP: WhatsApp es la puerta de la app, no un canal de atención.
   *
   * Ni una llamada al modelo. El negocio que elige este modo dijo que atiende
   * por la app; contestarle dudas por chat sería cobrarle tokens por un
   * servicio que no pidió, y además le partiría la atención en dos sitios.
   *
   * La decisión de mandar el enlace o solo recordarlo la toma la BASE, con un
   * reclamo atómico de 24 h. Antes vivía en un `Map` del proceso: se perdía al
   * reiniciar y con dos instancias cada una llevaba su cuenta.
   */
  async function runMiniappMode(input: {
    business: ConversationBusiness
    phone: string
    text: string
    session: ConversationSession | null
    send: (text: string) => Promise<unknown>
    sendTyping?: () => Promise<unknown>
    sendLink?: ProcessMessageInput['sendLink']
    inboundId?: string | null
  }): Promise<void> {
    const { business, phone, text, session, send } = input

    // ⚠️ El «leído» ya NO es lo primero: primero se decide si se atiende.
    //
    // `sendTyping` no solo pinta «escribiendo…», también marca el mensaje como
    // LEÍDO (van juntas en `integrations/whatsapp.ts`). A quien está silenciado
    // o bloqueado no se le da ninguna señal: el doble check azul le dice «te
    // estoy leyendo», que es exactamente la reacción que busca quien escribe
    // por molestar. Y es una llamada a la API que se ahorra.
    //
    // Para el cliente normal no cambia nada perceptible: el reclamo es una
    // consulta indexada, y el check azul sigue saliendo antes de la respuesta.
    const marcarLeido = async () => {
      if (!input.sendTyping) return
      try { await input.sendTyping() } catch { /* best-effort, como en el resto */ }
    }

    // El mensaje del cliente se guarda igual: el dueño tiene que poder leer en
    // su panel qué le escribieron, aunque el bot no le haya contestado nada.
    await database.saveMessage(business.id, phone, 'user', text)

    let toca = true
    // Cuántas respuestas lleva en esta hora, y si toca callar. Ante cualquier
    // fallo se contesta con normalidad: quedarse mudo por un problema NUESTRO
    // deja sin atender a un cliente de verdad, y eso cuesta más que un mensaje.
    let reclamo = { permitido: true, motivo: 'ok' as string, respuestas: 0 }
    try {
      const customer = await database.resolveCustomer({
        businessId: business.id,
        phone,
        name: session?.contact_name || null,
      })
      if (database.claimMiniappReply) {
        reclamo = await database.claimMiniappReply(business.id, customer.id, {
          mensajeId: input.inboundId || null,
        })
      }
      // El enlace solo se reclama si de verdad se va a contestar: gastar la
      // ventana de 24 h mientras se está callado dejaría al cliente sin enlace
      // justo cuando vuelva a escribir en condiciones.
      if (reclamo.permitido) {
        toca = await database.claimStorefrontLinkSend(business.id, customer.id)
      }
    } catch {
      toca = true
    }

    // ⚠️ EL ENLACE SALE SIEMPRE, y el reclamo solo decide cómo se dice.
    //
    // Hasta el 2026-08-12 este `toca` decidía si había enlace: dentro de las 24
    // h se respondía «usa el enlace que te envié», y quien había borrado el
    // chat —o cambiado de teléfono, o archivado la conversación— se quedaba sin
    // forma de pedir. No es teórico: en la conversación real de Monster Pizza
    // hay un cliente pegando la URL de la tienda en el chat dos veces
    // intentando entrar, y las dos veces recibió ese muro.
    //
    // El freno no ahorraba nada donde duele: se contesta un mensaje igual en
    // los dos casos, así que el coste en WhatsApp es el mismo. Lo único que
    // ahorraba era una fila de sesión, en una tabla que llevaba NUEVE. Ahora
    // solo cambia el texto: «Mira la carta» la primera vez, «Aquí tienes tu
    // enlace otra vez» después.
    // ⚠️ Si la foto era el comprobante de un pedido que espera pago, ya quedó
    // adjunta (`services/payment-proof-inbox.ts`) y lo que toca decir es otra
    // cosa. Mandarle el enlace a quien acaba de pagar es contestarle a una
    // pregunta que no hizo — y era exactamente lo que pasaba: el cliente
    // mandaba su captura y el bot le respondía «aquí tienes el menú».
    if (esComprobante(text)) {
      await marcarLeido()
      await send(RESPUESTA_COMPROBANTE)
      await database.saveMessage(business.id, phone, 'assistant', RESPUESTA_COMPROBANTE)
      logger.log(`🧾 [${business.name}] comprobante recibido por el chat de ${phone}`)
      return
    }

    // ⚠️ Comprobante con pagos pendientes en MÁS DE UN local: se pregunta a
    // cuál corresponde y no se adjunta a ninguno mientras tanto. Adivinar sería
    // dar por cobrado a un local lo que pagó otro — y el cliente que sí pagó
    // seguiría viendo la pantalla de espera.
    if (esComprobanteAmbiguo(text)) {
      await marcarLeido()
      // Los nombres viajan dentro del propio marcador: quien lo escribió ya
      // consultó la base, y volver a consultarla aquí sería pagar dos veces
      // por la misma respuesta.
      const locales = String(text).split(': ').slice(1).join(': ').replace(/\]$/, '')
      const pregunta = preguntaDeQueLocal(
        locales.split(' / ').filter(Boolean).map(businessName => ({
          orderId: '', orderNumber: null, businessName,
        })),
      )
      await send(pregunta)
      await database.saveMessage(business.id, phone, 'assistant', pregunta)
      logger.log(`🧾 [${business.name}] comprobante ambiguo: se preguntó el local a ${phone}`)
      return
    }

    // ── Se pasó del techo: silencio ───────────────────────────────────────
    //
    // ⚠️ Va DESPUÉS del comprobante a propósito. Quien acaba de pagar no es
    // quien molesta, y dejarle sin confirmación después de transferir es el
    // peor momento posible para ahorrarse un mensaje.
    //
    // El silencio dura 24 h y NO se levanta a la hora siguiente. Con una
    // ventana que se reinicia sola, quien escribe con paciencia pagaría el
    // techo entero cada hora — diez mensajes por hora son doscientos al día.
    //
    // No se le avisa de que está callado: quien escribe para molestar busca
    // una reacción, y «te voy a dejar de contestar» es una reacción. Además
    // cuesta un mensaje, que es justo lo que se está evitando.
    if (!reclamo.permitido) {
      await database.upsertSession(business.id, phone, {
        last_message: text,
        last_message_at: new Date(now()).toISOString(),
        // Marcado para el dueño: si alguien llegó hasta aquí, merece que una
        // persona mire esa conversación y decida si la bloquea.
        unread_owner: true,
      })
      logger.log(
        `🔇 [${business.name}] ${reclamo.motivo} — mensaje de ${phone} guardado, sin respuesta`,
      )
      return
    }

    // ⚠️ El enlace se crea AQUÍ, y no antes, porque crearlo tiene coste: cada
    // llamada abre una sesión de tienda con su token. Estaba antes del corte,
    // así que un silenciado seguía generando una fila por mensaje — justo la
    // tabla que el techo quería dejar de llenar— y un comprobante generaba una
    // que nadie iba a usar. El reclamo de 24 h ya se saltaba; la sesión no.
    const url = await storefrontUrlFor(business, phone, session?.contact_name, true)

    await marcarLeido()

    // `invite` puede venir vacío si el negocio no tiene tienda utilizable —sin
    // catálogo no hay nada que enseñar—. Ahí se recuerda igual, con el
    // teléfono del local, en vez de dejar el mensaje sin respuesta.
    //
    // ⚠️ El guardado en el historial se hace en los DOS caminos, y con el
    // mismo texto que se envió: el dueño abre su panel para saber qué recibió
    // su cliente, y un mensaje que salió sin quedar escrito es un hueco en esa
    // conversación.
    if (url) {
      const texto = await enviarInvitacion({
        business,
        url,
        send,
        sendLink: input.sendLink,
        repetido: !toca,
        // A partir de la quinta del cliente en esta hora. No cuesta un mensaje
        // más: es el mismo, con una línea que puede desatascarlo.
        telefonoDeAyuda: reclamo.motivo === 'con_telefono' ? business.phone : null,
      })
      await database.saveMessage(business.id, phone, 'assistant', texto)
    } else {
      await send(MINIAPP_RECORDATORIO)
      await database.saveMessage(business.id, phone, 'assistant', MINIAPP_RECORDATORIO)
    }
    logger.log(
      `🛍️ [${business.name}] modo mini app — ${
        url ? (toca ? 'enlace enviado' : 'enlace reenviado') : 'sin tienda, recordatorio'
      } a ${phone} (sin IA)`,
    )
  }

  async function runMenuMode(input: {
    business: ConversationBusiness
    phone: string
    text: string
    session?: ConversationSession | null
    send: (message: string) => Promise<unknown>
    sendImage?: ProcessMessageInput['sendImage']
    sendTyping?: () => Promise<unknown>
    sendVideo?: ProcessMessageInput['sendVideo']
    sendOptions?: ProcessMessageInput['sendOptions']
  }): Promise<void> {
    const { business, phone, text, session, send, sendImage } = input
    if (input.sendTyping) {
      try { await input.sendTyping() } catch { /* best-effort */ }
    }
    const [products, modifiers, lastOrder, policies] = await Promise.all([
      database.getProducts(business.id).catch(() => [] as ConversationProduct[]),
      business.takes_orders !== false && database.getMenuModifiers
        ? database.getMenuModifiers(business.id).catch(() => [])
        : Promise.resolve([]),
      business.takes_orders !== false && database.getLastOrderForContact
        ? database.getLastOrderForContact(business.id, phone).catch(() => null)
        : Promise.resolve(null),
      database.getPolicies(business.id).catch(() => null),
    ])
    const configuredPrompt = policies && typeof policies === 'object' && 'bot_prompt' in policies
      ? (policies as { bot_prompt?: unknown }).bot_prompt
      : null
    const botPrompt = typeof configuredPrompt === 'string' ? configuredPrompt : null

    const flow = menuFlow.advanceMenuFlow({
      business: business as MenuFlowInput['business'],
      contact: phone,
      message: text,
      products: products as MenuFlowInput['products'],
      botPrompt,
      modifiers: modifiers as MenuFlowInput['modifiers'],
      lastOrderItems: (lastOrder?.order_items || []) as MenuFlowInput['lastOrderItems'],
    })

    await database.saveMessage(business.id, phone, 'user', text)

    // ⚠️ Esto vivía SOLO en el camino de la IA, que se retiró el 2026-08-21.
    // Sin traerlo aquí, «Productos más consultados» y «Consultas sin venta»
    // del panel del dueño se habrían quedado vacíos para siempre, en silencio.
    //
    // Y el dato es mejor que antes: en el menú, el mensaje del cliente ES el
    // nombre del producto que eligió, no una frase suelta donde había que
    // adivinar de qué hablaba.
    try {
      const consultados = mentionedProductIds(products as ConversationProduct[], text)
      if (consultados.length) {
        void database.recordConsultations(business.id, consultados).catch(() => {})
      }
    } catch { /* las métricas no bloquean la conversación */ }

    const action = flow.action
    let menuReply = flow.reply
    let menuOptions = flow.options

    // Derivar a una persona: misma ruta que el resto del bot
    if (action?.type === 'handoff') {
      const outcome = await actions.handleConversationOutcome({
        business,
        phone,
        originalText: text,
        hasSale: false,
        hasHandoffTag: true,
        isUncertain: false,
        wasManual: session?.manual_mode,
        send,
      })
      if (outcome.handled) return
    }

    // El total oficial lo calcula SIEMPRE money.ts con las RPC atómicas: el
    // menú solo aporta qué pidió el cliente, nunca un monto.
    if (action?.type === 'order') {
      const orderProcessed = await actions.processOrderPayload({
        business,
        phone,
        session,
        payload: action.payload,
        // Ítems con su sabor: money.ts resuelve el precio por el tamaño y
        // pliega el sabor en el nombre de la línea.
        items: action.items,
        products,
        preFiltered: false,
        send,
      })
      // processOrderPayload ya envía el resumen oficial cuando crea el pedido.
      // El menú solo vuelve a presentar navegación; si falló, reemplaza por
      // completo la confirmación optimista que produjo la máquina de estados.
      menuReply = orderProcessed
        ? `¿Necesitas algo más? ${PROMPT_PICK_OPTION}`
        : `No pude confirmar de forma segura si el pedido quedó registrado. Para evitar duplicarlo, no lo envíes otra vez por ahora; habla con el equipo para que lo revise 🙏`
    }

    // Media solicitada por el cliente ("Ver fotos y videos"): fotos, video y
    // recién después el CTA. YCloud usa envío directo para esta secuencia:
    // su endpoint normal solo encola y puede adelantar el texto a la media.
    const requestedMedia = [
      ...(flow.image ? [{ url: flow.image, isVideo: false }] : []),
      ...(flow.media || []),
    ]
    if (requestedMedia.length) {
      for (const item of requestedMedia) {
        try {
          if (item.isVideo) {
            if (input.sendVideo) await input.sendVideo(item.url, undefined, 'direct')
          } else if (sendImage) {
            await sendImage(item.url, undefined, 'direct')
          }
        } catch { /* best-effort */ }
      }
    }

    // ⚠️ En modo MENÚ no va enlace, y no es un olvido: el menú de botones YA
    // es el sitio donde se pide. Mandar además la mini app ponía dos formas de
    // hacer lo mismo compitiendo en el mismo chat — el negocio que quiera la
    // app se pone en modo 'miniapp'.

    // El texto propio del menú (bienvenida, listas, confirmaciones) va después
    // de la acción, que ya envió su propio mensaje oficial cuando corresponde.
    // Primero se intentan botones/listas nativas; si el canal no los soporta
    // (Telegram, Meta) se cae a texto numerado, que el motor entiende igual.
    const message = renderMenuOptions(menuReply, menuOptions)
    let sentNatively = false
    if (menuOptions.length && input.sendOptions) {
      const nativeOptions = menuOptions.map((option, index) => {
        const title = typeof option === 'string' ? option : option.title
        // Si la opción ES un número (cantidades, adultos, niños), el id lleva
        // ese número para que "0 niños" registre 0 y no la posición del botón.
        const id = /^\d+$/.test(title.trim()) ? title.trim() : String(index + 1)
        return {
          id,
          title,
          description: typeof option === 'string' ? undefined : option.description,
        }
      })
      try {
        const body = menuReply.trim() || PROMPT_PICK_OPTION
        sentNatively = requestedMedia.length
          ? await input.sendOptions(body, nativeOptions, 'direct')
          : await input.sendOptions(body, nativeOptions)
      } catch { /* el fallback de texto cubre cualquier fallo */ }
      if (sentNatively) {
        await database.saveMessage(business.id, phone, 'assistant', message)
      }
    }
    if (!sentNatively && message.trim()) {
      await send(message)
      await database.saveMessage(business.id, phone, 'assistant', message)
    }
    await database.upsertSession(business.id, phone, {
      last_message: text,
      last_message_at: new Date(now()).toISOString(),
    })
    logger.log(`📋 [${business.name}] modo menú — ${phone}`)
  }

  async function processMessage(input: ProcessMessageInput): Promise<void> {
    const {
      business, phone, text, send, sendImage, sendTyping, sendVideo,
    } = input

    if (business.suspended) {
      await send('⚠️ Este servicio tiene un pago pendiente. Contacta al administrador para regularizar tu cuenta. Disculpa los inconvenientes.')
      logger.log(`⛔ [${business.name}] suspendido — aviso enviado`)
      return
    }
    if (!business.bot_active) {
      logger.log(`⏸️  [${business.name}] bot inactivo`)
      return
    }

    const report = await reports.handleOwnerMessage(business, phone, text)
    if (report.handled) {
      await send(report.reply)
      logger.log(`📊 [${business.name}] reporte entregado al dueño (${phone})`)
      return
    }

    const session = await database.getSession(business.id, phone)

    // ── Bloqueado por el dueño ────────────────────────────────────────────
    //
    // Va aquí, junto al modo manual, porque hacen lo mismo con motivos
    // distintos: el bot calla y el dueño se queda con el mensaje. La
    // diferencia es que el modo manual espera que una persona conteste, y esto
    // espera que nadie conteste.
    //
    // ⚠️ El mensaje SE GUARDA igual. Bloquear no es dejar de ver: el dueño
    // tiene que poder leer qué le escriben, y decidir si desbloquea. Borrar la
    // prueba de lo que pasó es exactamente lo contrario de lo que necesita
    // quien está aguantando a alguien.
    //
    // ⚠️ Y NUNCA se le avisa al bloqueado. Decirle «estás bloqueado» convierte
    // el bloqueo en un juego con marcador, y quien escribe para molestar busca
    // precisamente una reacción. El silencio no da nada con lo que jugar.
    //
    // Vale para TODOS los modos: en IA, en menú y en mini app. Cuesta una
    // consulta indexada por mensaje, que al lado de las seis que ya hace el
    // bot —y de una llamada al modelo— es ruido.
    const bloqueado = database.isContactBlocked
      ? await database.isContactBlocked(business.id, phone)
        .catch(() => false) // si la base falla se atiende: callar por un fallo
                            // nuestro deja sin servicio a un cliente de verdad
      : false
    if (bloqueado) {
      await database.saveMessage(business.id, phone, 'user', text)
      await database.upsertSession(business.id, phone, {
        last_message: text,
        last_message_at: new Date(now()).toISOString(),
        unread_owner: true,
      })
      logger.log(`⛔ [${business.name}] contacto bloqueado — mensaje de ${phone} guardado, sin respuesta`)
      return
    }

    if (session?.manual_mode) {
      await database.saveMessage(business.id, phone, 'user', text)
      await database.upsertSession(business.id, phone, {
        manual_mode: true,
        last_message: text,
        last_message_at: new Date(now()).toISOString(),
        unread_owner: true,
      })
      logger.log(`🤚 [${business.name}] modo manual — mensaje de ${phone} guardado para el dueño`)
      return
    }

    if (tags.isInsultMessage(text)) {
      const handoff = 'Entiendo que puede haber frustración 🙏 Permítame transferirle con un asesor de nuestro equipo que podrá ayudarle mejor.'
      await database.saveMessage(business.id, phone, 'user', text)
      await database.upsertSession(business.id, phone, {
        manual_mode: true,
        last_message: text,
        last_message_at: new Date(now()).toISOString(),
        unread_owner: true,
      })
      await database.saveMessage(business.id, phone, 'assistant', handoff)
      await send(handoff)
      logger.log(`🤚 [${business.name}] handoff por insulto/falta de respeto — ${phone}`)
      return
    }

    const businessSchedule = await database.getSchedule(business.id).catch(() => [])
    const outsideHours = schedule.isOutsideHours(businessSchedule)
    let outsideHoursMessage: string | null = null
    if (outsideHours) {
      const key = `${business.id}::${phone}`
      const currentTime = now()
      const lastNotice = offHoursNotified.get(key) || 0
      if (currentTime - lastNotice > OFF_HOURS_RENOTIFY) {
        if (offHoursNotified.size > 5000) offHoursNotified.clear()
        offHoursNotified.set(key, currentTime)
        outsideHoursMessage = schedule.buildScheduleMessage(business, businessSchedule)
        await send(outsideHoursMessage)
        logger.log(`🌙 [${business.name}] fuera de horario — horarios enviados a ${phone}`)
      } else {
        logger.log(`🌙 [${business.name}] fuera de horario — silencio (ya avisado) — ${phone}`)
      }
      // Fuera de horario NADIE atiende, tampoco el modo menú. Hubo excepciones
      // y convertían el horario del dueño en una decoración: el modo menú salía
      // por su propia rama ANTES de mirar el reloj, así que un negocio con el
      // menú activado atendía domingos y de madrugada aunque su horario dijera
      // lo contrario. Esta comprobación va delante de TODOS los modos para que
      // no vuelva a pasar. Quien quiera atender de madrugada configura
      // 00:00–23:59; el control es suyo, no de una regla escondida aquí.
      await database.saveMessage(business.id, phone, 'user', text)
      await database.upsertSession(business.id, phone, {
        last_message: text,
        last_message_at: new Date(now()).toISOString(),
      })
      if (outsideHoursMessage) {
        await database.saveMessage(
          business.id, phone, 'assistant', outsideHoursMessage,
        )
      }
      return
    }

    // MODO MENÚ: el CÓDIGO conduce toda la conversación con opciones armadas
    // desde los datos reales. No pasa por IA ni por el parser de etiquetas.
    // El dinero sigue el mismo camino de siempre (payload → money.ts + RPC).
    if (business.chat_mode === 'menu') {
      await runMenuMode({
        business, phone, text, session, send, sendImage, sendTyping, sendVideo,
        sendOptions: input.sendOptions,
      })
      return
    }

    // MODO MINI APP: WhatsApp es SOLO la puerta de la app, no un canal de
    // atención. Se manda el enlace (o se recuerda que lo use) y se termina.
    //
    // Va aquí, antes de leer políticas, historial y catálogo y antes de
    // cualquier llamada al modelo, y ese orden es el punto entero: un negocio
    // en este modo no puede generar coste de OpenAI. Antes el enlace se
    // añadía al FINAL, después de que la IA ya hubiera respondido y cobrado.
    if (business.chat_mode === 'miniapp') {
      await runMiniappMode({
        business, phone, text, session, send, sendTyping,
        sendLink: input.sendLink, inboundId: input.inboundId,
      })
      return
    }

    // Sin modo reconocido no se responde nada, y es deliberado.
    //
    // Hasta el 2026-08-21 aquí caía el MODO IA: se leían políticas, historial y
    // catálogo, se armaba un prompt y el modelo redactaba la respuesta. Se
    // retiró entero — el dueño decidió que todo lo que ve el cliente lo escriba
    // el código, con datos de la base y nada inventado.
    //
    // ⚠️ Callar es lo correcto aquí. Un negocio sin modo válido es una
    // configuración rota, y contestarle algo genérico al cliente esconde el
    // problema: se registra para que se vea y se arregla en el panel.
    logger.error(
      `❌ [${business.name}] modo de conversación no reconocido: ${business.chat_mode || '(vacío)'}`,
    )
  }


  return { humanizedSend, processMessage }
}

// Solo la instancia real ata estas dependencias concretas: el módulo en sí
// sigue siendo puro y las pruebas lo montan con lo que necesiten.
// Se tipa con las firmas REALES del módulo (no con las que espera la
// conversación) para que el compilador compare las dos y avise si divergen.
interface ModuloStorefrontLinkService {
  issueStorefrontLink: ConversationStorefrontLink['issueLink']
  storefrontInvite: ConversationStorefrontLink['storefrontInvite']
  storefrontInviteButton: ConversationStorefrontLink['storefrontInviteButton']
}
const storefrontLinkService: ModuloStorefrontLinkService = require('./storefront-link') as typeof import('./storefront-link')

const conversation = createBotConversation({
  database: require('../db') as ConversationDatabase,
  reports: require('./reports') as ConversationReports,
  schedule: require('./schedule') as ConversationSchedule,
  ai: require('./ai') as ConversationAi,
  tags: require('./bot-tags') as ConversationTags,
  actions: require('./bot-actions') as ConversationActions,
  media: require('./bot-media') as ConversationMedia,
  menuFlow: require('./bot-menu-flow') as ConversationMenuFlow,
  // Adaptador explícito, sin `as`: los nombres del módulo y los que espera la
  // conversación no coinciden, y un cast a ciegas dejaría pasar la diferencia
  // hasta producción — que es exactamente lo que ocurrió al escribirlo.
  storefrontLink: {
    issueLink: storefrontLinkService.issueStorefrontLink,
    storefrontInvite: storefrontLinkService.storefrontInvite,
    storefrontInviteButton: storefrontLinkService.storefrontInviteButton,
  },
})

export const processMessage = conversation.processMessage
export { createBotConversation, mentionedProductIds }
