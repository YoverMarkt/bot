import type {
  ActionBusiness,
  ActionProduct,
  ActionSession,
  BookingCreationOutcome,
} from './bot-actions'
import type { BookingTag, ParsedBotOutput } from './bot-tags'
import type { MenuFlowInput, MenuFlowResult } from './bot-menu-flow'
import type {
  BotMediaBusiness,
  BotMediaHistoryMessage,
  BotMediaProduct,
  SendRequestedProductMediaInput,
} from './bot-media'

interface ConversationBusiness extends ActionBusiness, BotMediaBusiness {
  suspended?: boolean | null
  bot_active?: boolean | null
  ai_provider?: string | null
  // 'menu' → la conversación la conduce bot-menu-flow (sin IA)
  chat_mode?: string | null
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
  getAvailableSlots(businessId: string): Promise<unknown>
  countProducts(businessId: string): Promise<number>
  searchProductsByVector(
    businessId: string,
    embedding: number[],
    limit: number,
  ): Promise<ConversationProduct[]>
  getProducts(businessId: string): Promise<ConversationProduct[]>
  // Solo los usa el modo menú
  getLodgingRoomTypes?(businessId: string): Promise<Record<string, unknown>[]>
  getLastOrderForContact?(
    businessId: string,
    contactPhone: string,
  ): Promise<{ order_items?: Record<string, unknown>[] } | null>
  recordConsultations(businessId: string, productIds: string[]): Promise<unknown>
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
  callAI(
    prompt: string,
    history: ConversationHistory[],
    text: string,
    provider?: string | null,
  ): Promise<string>
  embedText(text: string): Promise<number[]>
}

interface ConversationPrompt {
  buildPrompt(
    business: ConversationBusiness,
    products: ConversationProduct[],
    policies: unknown,
    userQuery: string,
    availableSlots: unknown,
    schedule: unknown[],
    preFiltered: boolean,
    postSale: boolean,
  ): string
}

interface ConversationTags {
  detectMediaRequest(text: string): { wantsImage: boolean; wantsVideo: boolean }
  isInsultMessage(text: string): boolean
  parseBotOutput(reply: string): ParsedBotOutput
  impersonatesOfficialSummary(text: string): boolean
}

interface ConversationActions {
  createBookingFromTag(
    business: ActionBusiness,
    phone: string,
    booking: BookingTag | null,
    products: ActionProduct[],
  ): Promise<BookingCreationOutcome>
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
    products: ActionProduct[]
    preFiltered: boolean
    send(message: string): Promise<unknown>
  }): Promise<boolean>
  processLodgingQuote(input: {
    business: ActionBusiness
    phone: string
    originalText: string
    quote: ParsedBotOutput['lodgingQuote']
    guestMessages?: string[]
    send(message: string): Promise<unknown>
    sendImage?: (url: string, caption?: string) => Promise<unknown>
    sendVideo?: (url: string, caption?: string) => Promise<unknown>
  }): Promise<unknown>
  processLodgingRequest(input: {
    business: ActionBusiness
    phone: string
    originalText: string
    request: ParsedBotOutput['lodgingRequest']
    guestMessages?: string[]
    send(message: string): Promise<unknown>
  }): Promise<unknown>
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

export interface BotConversationDependencies {
  database: ConversationDatabase
  reports: ConversationReports
  schedule: ConversationSchedule
  ai: ConversationAi
  prompt: ConversationPrompt
  tags: ConversationTags
  actions: ConversationActions
  media: ConversationMedia
  menuFlow: ConversationMenuFlow
  logger?: ConversationLogger
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

export interface ProcessMessageInput {
  business: ConversationBusiness
  phone: string
  text: string
  send(message: string): Promise<unknown>
  sendImage?: (url: string, caption?: string) => Promise<unknown>
  sendTyping?: () => Promise<unknown>
  sendVideo?: (url: string, caption?: string) => Promise<unknown>
  // Menú con botones/listas nativas. Devuelve false si el canal no lo soporta
  // y entonces las opciones se mandan numeradas como texto.
  sendOptions?: (
    body: string,
    options: { id: string; title: string; description?: string }[],
  ) => Promise<boolean>
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
    database, reports, schedule, ai, prompt, tags, actions, media, menuFlow,
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

  async function runMenuMode(input: {
    business: ConversationBusiness
    phone: string
    text: string
    session?: ConversationSession | null
    send: (message: string) => Promise<unknown>
    sendImage?: (url: string, caption?: string) => Promise<unknown>
    sendVideo?: (url: string, caption?: string) => Promise<unknown>
    sendOptions?: ProcessMessageInput['sendOptions']
  }): Promise<void> {
    const { business, phone, text, session, send, sendImage } = input
    const [products, roomTypes, availableSlots, lastOrder] = await Promise.all([
      database.getProducts(business.id).catch(() => [] as ConversationProduct[]),
      business.lodging_enabled === true && database.getLodgingRoomTypes
        ? database.getLodgingRoomTypes(business.id).catch(() => [])
        : Promise.resolve([]),
      business.takes_bookings === true
        ? database.getAvailableSlots(business.id).catch(() => null)
        : Promise.resolve(null),
      business.takes_orders !== false && database.getLastOrderForContact
        ? database.getLastOrderForContact(business.id, phone).catch(() => null)
        : Promise.resolve(null),
    ])

    const flow = menuFlow.advanceMenuFlow({
      business: business as MenuFlowInput['business'],
      contact: phone,
      message: text,
      products: products as MenuFlowInput['products'],
      roomTypes: roomTypes as MenuFlowInput['roomTypes'],
      availableSlots: (availableSlots || {}) as MenuFlowInput['availableSlots'],
      lastOrderItems: (lastOrder?.order_items || []) as MenuFlowInput['lastOrderItems'],
    })

    await database.saveMessage(business.id, phone, 'user', text)
    const action = flow.action

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
      await actions.processOrderPayload({
        business,
        phone,
        session,
        payload: action.payload,
        products,
        preFiltered: false,
        send,
      })
    } else if (action?.type === 'stay_quote') {
      await actions.processLodgingQuote({
        business,
        phone,
        originalText: text,
        quote: action.quote as ParsedBotOutput['lodgingQuote'],
        guestMessages: [text],
        send,
        sendImage,
        sendVideo: input.sendVideo,
      })
    } else if (action?.type === 'stay_request') {
      await actions.processLodgingRequest({
        business,
        phone,
        originalText: text,
        request: {
          roomTypeIdOrName: action.roomTypeId,
          contactName: action.contactName,
        } as ParsedBotOutput['lodgingRequest'],
        guestMessages: [text, action.contactName],
        send,
      })
    } else if (action?.type === 'booking') {
      // El día y la hora vienen de la agenda real, ya resueltos por el menú:
      // los campos "raw" y los normalizados coinciden a propósito.
      await actions.createBookingFromTag(business, phone, {
        contactName: action.name,
        bookingDateRaw: action.date,
        bookingTimeRaw: action.time,
        bookingDate: action.date,
        bookingTime: action.time,
        service: 'Cita',
      }, products)
    }

    // El texto propio del menú (bienvenida, listas, confirmaciones) va después
    // de la acción, que ya envió su propio mensaje oficial cuando corresponde.
    // Primero se intentan botones/listas nativas; si el canal no los soporta
    // (Telegram, Meta) se cae a texto numerado, que el motor entiende igual.
    const message = renderMenuOptions(flow.reply, flow.options)
    let sentNatively = false
    if (flow.options.length && input.sendOptions) {
      const nativeOptions = flow.options.map((option, index) => ({
        id: String(index + 1),
        title: typeof option === 'string' ? option : option.title,
        description: typeof option === 'string' ? undefined : option.description,
      }))
      try {
        sentNatively = await input.sendOptions(
          flow.reply.trim() || PROMPT_PICK_OPTION,
          nativeOptions,
        )
      } catch { /* el fallback de texto cubre cualquier fallo */ }
      if (sentNatively) {
        await database.saveMessage(business.id, phone, 'assistant', message)
      }
    }
    if (!sentNatively && message.trim()) {
      await send(message)
      await database.saveMessage(business.id, phone, 'assistant', message)
    }
    if (flow.image && sendImage) {
      try { await sendImage(flow.image) } catch { /* best-effort */ }
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

    // MODO MENÚ: el CÓDIGO conduce toda la conversación con opciones armadas
    // desde los datos reales. No pasa por IA ni por el parser de etiquetas.
    // El dinero sigue el mismo camino de siempre (payload → money.ts + RPC).
    if (business.chat_mode === 'menu') {
      await runMenuMode({
        business, phone, text, session, send, sendImage, sendVideo,
        sendOptions: input.sendOptions,
      })
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
      if (business.lodging_enabled !== true) {
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
    }

    if (sendTyping) {
      try { await sendTyping() } catch { /* best-effort */ }
    }

    const needsMemory = /vez pasada|anterior|última vez|last time|antes|pedí|ordené|compré/i
      .test(text)
    const historyLimit = needsMemory ? 24 : 8
    const [policies, history, availableSlots, totalProducts] = await Promise.all([
      database.getPolicies(business.id),
      database.getContactHistory(
        business.id, phone, historyLimit, session?.closed_sale_at || null,
      ),
      business.takes_bookings === true
        ? database.getAvailableSlots(business.id).catch(() => null)
        : Promise.resolve(null),
      database.countProducts(business.id).catch(() => 0),
    ])

    const postSale = Boolean(session?.closed_sale_at)
      && !history.some(message => message.role === 'assistant')
    let products: ConversationProduct[] = []
    let preFiltered = false
    if (totalProducts > 40) {
      try {
        const embedding = await ai.embedText(text)
        const found = await database.searchProductsByVector(
          business.id, embedding, 12,
        )
        if (found?.length) {
          products = found
          preFiltered = true
          logger.log(`🔎 [${business.name}] RAG: ${found.length} de ${totalProducts} productos relevantes`)
        }
      } catch (error) {
        logger.error(
          'RAG (usando fallback):',
          error instanceof Error ? error.message : error,
        )
      }
    }
    if (!products.length) products = await database.getProducts(business.id)

    await database.saveMessage(business.id, phone, 'user', text)
    if (outsideHoursMessage) {
      await database.saveMessage(
        business.id, phone, 'assistant', outsideHoursMessage,
      )
    }
    try {
      const productIds = mentionedProductIds(products, text)
      if (productIds.length) {
        void database.recordConsultations(business.id, productIds).catch(() => {})
      }
    } catch { /* las métricas no bloquean la conversación */ }

    const { wantsImage, wantsVideo } = tags.detectMediaRequest(text)
    let reply = ''
    try {
      reply = await ai.callAI(
        prompt.buildPrompt(
          business, products, policies, text, availableSlots,
          outsideHours && business.lodging_enabled === true ? [] : businessSchedule,
          preFiltered, postSale,
        ),
        history,
        text,
        business.ai_provider,
      )
    } catch (error) {
      logger.error('❌ IA:', error instanceof Error ? error.message : error)
      reply = 'Disculpa, tuve un problema técnico. Intenta de nuevo 🙏'
    }

    const parsedOutput = tags.parseBotOutput(reply)
    if (parsedOutput.hasActionConflict) {
      logger.error(`❌ [${business.name}] respuesta de IA con acciones incompatibles`)
      await actions.handleConversationOutcome({
        business,
        phone,
        originalText: text,
        hasSale: false,
        hasHandoffTag: parsedOutput.hasHandoffTag,
        isUncertain: true,
        wasManual: session?.manual_mode,
        send,
      })
      return
    }

    // La IA jamás escribe montos: si imita el formato de los resúmenes
    // oficiales (cotizaciones/pedidos del servidor) está inventando cifras.
    // Falla cerrado: el cliente no ve ese texto y continúa una persona.
    if (tags.impersonatesOfficialSummary(parsedOutput.finalText)) {
      logger.error(`❌ [${business.name}] la IA imitó un resumen oficial con datos propios; se deriva fallando cerrado`)
      await actions.handleConversationOutcome({
        business,
        phone,
        originalText: text,
        hasSale: false,
        hasHandoffTag: false,
        isUncertain: true,
        wasManual: session?.manual_mode,
        send,
      })
      return
    }

    // Lo que ESCRIBIÓ el huésped (historial + mensaje actual): de aquí salen
    // las fechas relativas de las cotizaciones y el nombre de las solicitudes
    const guestMessages = [
      ...history
        .filter(message => message.role === 'user')
        .map(message => String(message.content ?? '')),
      text,
    ]

    if (parsedOutput.lodgingQuote) {
      await actions.processLodgingQuote({
        business,
        phone,
        originalText: text,
        quote: parsedOutput.lodgingQuote,
        guestMessages,
        send,
        sendImage,
        sendVideo,
      })
      return
    }

    if (parsedOutput.lodgingRequest) {
      await actions.processLodgingRequest({
        business,
        phone,
        originalText: text,
        request: parsedOutput.lodgingRequest,
        guestMessages,
        send,
      })
      return
    }

    if (parsedOutput.isUncertain) {
      const handoffOutcome = await actions.handleConversationOutcome({
        business,
        phone,
        originalText: text,
        hasSale: parsedOutput.hasSale,
        hasHandoffTag: parsedOutput.hasHandoffTag,
        isUncertain: true,
        wasManual: session?.manual_mode,
        send,
      })
      if (handoffOutcome.handled) return
    }

    const hasBookingTag = Boolean(parsedOutput.booking)
    const hasOrderTag = Boolean(parsedOutput.orderPayload)
    const hasTransactionalConflict = hasBookingTag && hasOrderTag
    const canBook = business.takes_bookings === true
    const canOrder = business.takes_orders !== false

    if (hasTransactionalConflict && !canBook) {
      await actions.handleConversationOutcome({
        business,
        phone,
        originalText: text,
        hasSale: true,
        hasHandoffTag: false,
        isUncertain: false,
        wasManual: session?.manual_mode,
        send,
      })
      if (canOrder) {
        const orderProcessed = await actions.processOrderPayload({
          business,
          phone,
          session,
          payload: parsedOutput.orderPayload,
          products,
          preFiltered,
          send,
        })
        const message = orderProcessed
          ? 'Procesé únicamente el pedido. No registré una reserva porque este negocio no agenda mediante el bot.'
          : 'No registré la reserva y tampoco pude procesar el pedido de forma segura. Un asesor continuará contigo 🙏'
        await database.saveMessage(business.id, phone, 'assistant', message)
        await send(message)
        return
      }

      const message = 'Este negocio no procesa reservas ni pedidos mediante el bot. Un asesor continuará contigo para ayudarte 🙏'
      await database.saveMessage(business.id, phone, 'assistant', message)
      await send(message)
      return
    }

    if (hasOrderTag && !canOrder && !hasBookingTag) {
      await actions.handleConversationOutcome({
        business,
        phone,
        originalText: text,
        hasSale: true,
        hasHandoffTag: false,
        isUncertain: false,
        wasManual: session?.manual_mode,
        send,
      })
      const message = 'Este negocio no procesa pedidos mediante el bot. Un asesor continuará contigo para ayudarte con la compra 🙏'
      await database.saveMessage(business.id, phone, 'assistant', message)
      await send(message)
      return
    }

    const bookingOutcome = await actions.createBookingFromTag(
      business, phone, parsedOutput.booking, products,
    )
    if (
      bookingOutcome === 'duplicate'
      || bookingOutcome === 'conflict'
      || bookingOutcome === 'error'
    ) {
      if (hasTransactionalConflict && !canOrder) {
        await actions.handleConversationOutcome({
          business,
          phone,
          originalText: text,
          hasSale: true,
          hasHandoffTag: false,
          isUncertain: false,
          wasManual: session?.manual_mode,
          send,
        })
      }
      const purchaseSuffix = hasTransactionalConflict
        ? canOrder
          ? ' La compra todavía no fue procesada; confírmame el pedido en tu siguiente mensaje.'
          : ' La compra tampoco se procesó; un asesor continuará contigo.'
        : ''
      const bookingMessage = (bookingOutcome === 'duplicate'
        ? 'Tu solicitud para ese horario ya está registrada. No necesitas enviarla de nuevo 😊'
        : bookingOutcome === 'conflict'
          ? 'Ese horario acaba de ocuparse. Por favor dime otro horario y revisaré la disponibilidad actualizada 🙏'
          : 'No pude guardar tu solicitud de reserva de forma segura. Por favor intenta nuevamente o espera la ayuda de un asesor 🙏') + purchaseSuffix
      await database.saveMessage(business.id, phone, 'assistant', bookingMessage)
      await send(bookingMessage)
      return
    }

    if (hasTransactionalConflict) {
      if (!canOrder) {
        await actions.handleConversationOutcome({
          business,
          phone,
          originalText: text,
          hasSale: true,
          hasHandoffTag: false,
          isUncertain: false,
          wasManual: session?.manual_mode,
          send,
        })
      }
      const message = canOrder
        ? 'Tu solicitud de reserva quedó registrada y está pendiente de confirmación del dueño. Para evitar duplicados, todavía no procesé la compra; confírmame el pedido en tu siguiente mensaje.'
        : 'Tu solicitud de reserva quedó registrada y está pendiente de confirmación del dueño. La compra no se procesó mediante el bot; un asesor continuará contigo.'
      logger.log(`⚠️ [${business.name}] ##PEDIDO## pospuesto: la respuesta ya procesó ##BOOK##`)
      await database.saveMessage(business.id, phone, 'assistant', message)
      await send(message)
      return
    }

    const outcome = await actions.handleConversationOutcome({
      business,
      phone,
      originalText: text,
      hasSale: hasBookingTag ? false : parsedOutput.hasSale,
      hasHandoffTag: parsedOutput.hasHandoffTag,
      isUncertain: false,
      wasManual: session?.manual_mode,
      send,
    })
    if (outcome.handled) return

    if (parsedOutput.orderPayload) {
      const orderProcessed = await actions.processOrderPayload({
        business,
        phone,
        session,
        payload: parsedOutput.orderPayload,
        products,
        preFiltered,
        send,
      })
      if (!orderProcessed) {
        const message = 'No pude registrar el pedido con un total oficial de forma segura. Un asesor continuará contigo para revisarlo 🙏'
        await database.saveMessage(business.id, phone, 'assistant', message)
        await send(message)
      }
      return
    }

    await humanizedSend(parsedOutput.finalText, send, sendTyping)
    await actions.processOrderPayload({
      business,
      phone,
      session,
      payload: parsedOutput.orderPayload,
      products,
      preFiltered,
      send,
    })
    await media.sendRequestedProductMedia({
      business,
      text,
      reply,
      history,
      products,
      preFiltered,
      wantsImage,
      wantsVideo,
      send,
      sendImage,
      sendVideo,
    })

    await database.saveMessage(
      business.id, phone, 'assistant', parsedOutput.finalText,
    )
    logger.log(`🤖 [${business.name}] respondido`)
  }

  return { humanizedSend, processMessage }
}

const conversation = createBotConversation({
  database: require('../db') as ConversationDatabase,
  reports: require('./reports') as ConversationReports,
  schedule: require('./schedule') as ConversationSchedule,
  ai: require('./ai') as ConversationAi,
  prompt: require('./prompt') as ConversationPrompt,
  tags: require('./bot-tags') as ConversationTags,
  actions: require('./bot-actions') as ConversationActions,
  media: require('./bot-media') as ConversationMedia,
  menuFlow: require('./bot-menu-flow') as ConversationMenuFlow,
})

export const processMessage = conversation.processMessage
export { createBotConversation, mentionedProductIds }
