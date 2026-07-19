import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

interface BusinessRecord extends Record<string, unknown> {
  id: string
  name?: string
  ai_provider?: string | null
}

interface DatabaseResult {
  error?: { message?: string } | null
}

const db = require('../db') as {
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
  getProducts(businessId: string): Promise<unknown[]>
  getPolicies(businessId: string): Promise<Record<string, unknown> | null>
  getContactHistory(businessId: string, phone: string, limit: number): Promise<unknown[]>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<DatabaseResult>
  clearSimHistory(businessId: string): Promise<DatabaseResult>
}
const bot = require('../services/bot-entry') as {
  buildPrompt(
    business: BusinessRecord,
    products: unknown[],
    policies: Record<string, unknown> | null,
    voiceMode: boolean,
    userQuery: string,
  ): string
  callAI(
    systemPrompt: string,
    history: unknown[],
    userMessage: string,
    provider?: string | null,
  ): Promise<string>
}
const auth = require('../middleware/auth') as {
  authAdmin: RequestHandler
}
const tags = require('../services/bot-tags') as {
  detectMediaRequest(text: string): { wantsImage: boolean; wantsVideo: boolean }
  impersonatesOfficialSummary(text: string): boolean
  parseBotOutput(reply: string): {
    finalText: string
    booking: unknown
    orderPayload: string | null
    lodgingQuote: Record<string, unknown> | null
    lodgingRequest: { roomTypeIdOrName: string; contactName: string } | null
    hasSale: boolean
    hasHandoffTag: boolean
    hasActionConflict: boolean
  }
}
const actions = require('../services/bot-actions') as {
  guestWroteName(contactName: unknown, guestMessages: unknown[]): boolean
  computeLodgingQuoteReply(
    business: BusinessRecord,
    contactPhone: string,
    quote: Record<string, unknown>,
    guestText?: string,
  ): Promise<{
    outcome: 'quoted' | 'retry' | 'handoff' | 'error'
    message: string
    mediaOptions?: { mediaUrls?: string[] }[]
  }>
}
const media = require('../services/bot-media') as {
  sendRequestedProductMedia(input: {
    business: { id: string; name: string }
    text: string
    reply: string
    history: { content?: string | null }[]
    products: unknown[]
    preFiltered: boolean
    wantsImage: boolean
    wantsVideo: boolean
    send(message: string): Promise<unknown>
    sendImage?: (url: string, caption?: string) => Promise<unknown>
    sendVideo?: (url: string, caption?: string) => Promise<unknown>
  }): Promise<boolean>
}

const router = createRouter()
const SIMULATOR_CONTACT = 'sim_admin'
const HANDOFF_REPLY = 'Permítame un momento por favor 🙏 enseguida un asesor de nuestro equipo continuará con usted para ayudarle mejor ✨'

function databaseError(result: DatabaseResult, operation: string): void {
  if (!result.error) return
  throw new Error(`${operation}: ${result.error.message || 'Error desconocido'}`)
}

router.post('/api/admin/simulate', auth.authAdmin, async (req, res) => {
  const { business_id: businessId, message: rawMessage } = req.body as {
    business_id?: unknown
    message?: unknown
  }
  if (typeof businessId !== 'string' || typeof rawMessage !== 'string' || !rawMessage.trim()) {
    return res.status(400).json({ error: 'business_id y message requeridos' })
  }
  const message = rawMessage.trim()
  const business = await db.getBusinessById(businessId)
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })

  try {
    const [products, policies, history] = await Promise.all([
      db.getProducts(business.id),
      db.getPolicies(business.id),
      db.getContactHistory(business.id, SIMULATOR_CONTACT, 8),
    ])

    databaseError(
      await db.saveMessage(business.id, SIMULATOR_CONTACT, 'user', message),
      'guardar mensaje de prueba',
    )

    const rawReply = await bot.callAI(
      bot.buildPrompt(business, products, policies, false, message),
      history,
      message,
      business.ai_provider,
    )

    // Mismo parser de etiquetas que WhatsApp/Telegram: nada de limpiar a mano
    const imageMatch = rawReply.match(/##IMG##(https?:\/\/[^\s#]+)##/)
    const parsed = tags.parseBotOutput(rawReply)
    let reply = parsed.finalText
    let actionNote: string | null = null
    let mediaImage: string | null = null
    let mediaVideo: string | null = null
    const mediaNotes: string[] = []

    if (parsed.hasActionConflict) {
      // Igual que el canal real: acciones incompatibles fallan cerrado
      reply = HANDOFF_REPLY
      actionNote = '⚠️ La IA emitió varias acciones incompatibles en una sola respuesta; en el canal real esto falla cerrado y la conversación pasa a un asesor.'
    } else if (tags.impersonatesOfficialSummary(parsed.finalText)) {
      // La IA intentó escribir montos/cotización con formato oficial: cifras inventadas
      reply = HANDOFF_REPLY
      actionNote = '⚠️ La IA intentó escribir una cotización o total con formato oficial SIN pasar por el cálculo del servidor (cifras inventadas). Falla cerrado: igual que en WhatsApp/Telegram, el cliente nunca ve montos inventados y la conversación pasa a un asesor.'
    } else if (parsed.hasHandoffTag) {
      reply = HANDOFF_REPLY
    } else if (parsed.lodgingQuote) {
      // El huésped real recibe SOLO la cotización oficial del servidor
      const computed = await actions.computeLodgingQuoteReply(
        business, SIMULATOR_CONTACT, parsed.lodgingQuote, message,
      )
      reply = computed.message
      for (const url of (computed.mediaOptions || []).flatMap(option => option.mediaUrls || [])) {
        if (!/^https:\/\//i.test(url)) continue
        if (/\.(?:mp4|mov|webm)(?:$|[?#])/i.test(url)) mediaVideo = mediaVideo || url
        else mediaImage = mediaImage || url
      }
      actionNote = computed.outcome === 'handoff' || computed.outcome === 'error'
        ? '🏨 En el canal real esta conversación pasa a un asesor del equipo (la cotización no pudo resolverse automáticamente).'
        : '🏨 Respuesta oficial calculada por el servidor con cupos y tarifas reales, igual que en WhatsApp/Telegram.'
    } else if (parsed.lodgingRequest) {
      const guestTexts = [
        ...(history as { role?: string; content?: string }[])
          .filter(item => item.role === 'user')
          .map(item => String(item.content ?? '')),
        message,
      ]
      if (!actions.guestWroteName(parsed.lodgingRequest.contactName, guestTexts)) {
        // Igual que el canal real: nombre no escrito por el cliente → se pide
        reply = 'Para registrar la solicitud solo me falta el nombre de la persona que se hospedará. ¿Me lo escribes, por favor?'
        actionNote = '🛎️ La IA intentó registrar la solicitud con un nombre que el cliente nunca escribió. Igual que en WhatsApp/Telegram, se descarta y se pide el nombre antes de crear nada.'
      } else {
        actionNote = '🛎️ Solicitud de hospedaje detectada: en el canal real el sistema retiene el cupo y la deja en Hospedaje → Solicitudes para que el equipo la confirme. El simulador no crea retenciones reales.'
      }
    } else if (parsed.booking) {
      actionNote = '📅 Reserva detectada: en el canal real se crearía la cita pendiente de confirmación del equipo. El simulador no crea citas reales.'
    } else if (parsed.orderPayload || parsed.hasSale) {
      actionNote = '🛒 Cierre de venta detectado: en el canal real el sistema calcula el total oficial y avisa al equipo. El simulador no registra pedidos reales.'
    }

    if (reply) {
      databaseError(
        await db.saveMessage(business.id, SIMULATOR_CONTACT, 'assistant', reply),
        'guardar respuesta de prueba',
      )
    }
    // El flujo real envía la media DESPUÉS de responder (bot-conversation →
    // bot-media). Aquí se replica con enviadores que capturan la media en vez
    // de mandarla por un canal, para que el simulador muestre exactamente lo
    // que el cliente recibiría en WhatsApp/Telegram.
    const { wantsImage, wantsVideo } = tags.detectMediaRequest(message)
    const skipProductMedia = parsed.hasHandoffTag || parsed.hasActionConflict
      || Boolean(parsed.lodgingQuote) || Boolean(parsed.lodgingRequest)
    if (!skipProductMedia && (wantsImage || wantsVideo)) {
      await media.sendRequestedProductMedia({
        business: { id: business.id, name: business.name || business.id },
        text: message,
        reply: rawReply,
        history: history as { content?: string | null }[],
        products,
        preFiltered: false,
        wantsImage,
        wantsVideo,
        send: async (note: string) => { mediaNotes.push(note) },
        sendImage: async (url: string) => { mediaImage = url },
        sendVideo: async (url: string) => { mediaVideo = url },
      })
    }

    console.log(`🧪 [Sim] ${business.name || business.id}: respondido`)
    res.json({
      reply,
      image: mediaImage || imageMatch?.[1] || null,
      video: mediaVideo,
      mediaNote: mediaNotes.length ? mediaNotes.join('\n') : null,
      actionNote,
    })
  } catch (error) {
    console.error(
      '❌ Simulate:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
    res.status(500).json({ error: 'No se pudo completar la simulación' })
  }
})

router.delete(
  '/api/admin/simulate/:bizId/history',
  auth.authAdmin,
  async (req, res) => {
    try {
      databaseError(
        await db.clearSimHistory(req.params.bizId),
        'limpiar historial de prueba',
      )
      res.json({ ok: true })
    } catch (error) {
      console.error(
        '❌ limpiar simulador:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      res.status(500).json({ error: 'No se pudo limpiar el historial' })
    }
  },
)

export = router
