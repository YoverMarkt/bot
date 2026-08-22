import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import type { BusinessRecord } from '../db/types'
import { buildWelcomeMenu, menuAsHistory, wantsWelcomeMenu } from '../services/bot-menu'
import {
  advanceMenuFlow,
  resetMenuFlow,
  type MenuFlowInput,
} from '../services/bot-menu-flow'

interface DatabaseResult {
  error?: { message?: string } | null
}

const db: {
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
  getMenuModifiers(businessId: string, categoryTag?: string | null): Promise<unknown[]>
  getLastOrderForContact(
    businessId: string,
    contactPhone: string,
  ): Promise<{ order_items?: Record<string, unknown>[] } | null>
} = require('../db') as typeof import('../db')
const auth: {
  authAdmin: RequestHandler
} = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const SIMULATOR_CONTACT = 'sim_admin'
const HANDOFF_REPLY = 'Permítame un momento por favor 🙏 enseguida un asesor de nuestro equipo continuará con usted para ayudarle mejor ✨'
const MINIAPP_REPLY = '🛍️ En el canal real, aquí se envía el enlace personal de la tienda para hacer el pedido.'
const MINIAPP_NOTE = 'Modo mini app: no se llamó a la IA. El simulador no crea enlaces personales ni pedidos reales.'

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
    // MODO MENÚ (estilo banco): el CÓDIGO conduce toda la conversación con
    // opciones de los datos reales; la IA no participa en ningún mensaje. Se
    // despacha por el modo REAL del negocio, así que lo que se prueba aquí es
    // exactamente lo que recibe su cliente.
    if (business.chat_mode === 'menu') {
      const [products, modifiers, lastOrder, policies] = await Promise.all([
        db.getProducts(business.id),
        business.takes_orders !== false ? db.getMenuModifiers(business.id) : Promise.resolve([]),
        // Paridad con el canal real: el simulador también ofrece repetir pedido
        business.takes_orders !== false
          ? db.getLastOrderForContact(business.id, SIMULATOR_CONTACT).catch(() => null)
          : Promise.resolve(null),
        db.getPolicies(business.id).catch(() => null),
      ])
      const flow = advanceMenuFlow({
        business,
        contact: SIMULATOR_CONTACT,
        message,
        products: products as MenuFlowInput['products'],
        welcomeMessage: typeof policies?.welcome_message === 'string' ? policies.welcome_message : null,
        modifiers: modifiers as MenuFlowInput['modifiers'],
        lastOrderItems: (lastOrder?.order_items || []) as MenuFlowInput['lastOrderItems'],
      })

      let reply = flow.reply
      let flowOptions = flow.options
      let actionNote: string | null = null
      const flowImage = flow.image || null
      const flowVideo: string | null = null
      if (flow.action?.type === 'handoff') {
        reply = HANDOFF_REPLY
        actionNote = '🤚 El cliente pidió una persona: en el canal real la conversación pasa a modo manual y el equipo continúa.'
      } else if (flow.action?.type === 'order') {
        actionNote = `🛒 Pedido armado 100% con menús y total calculado por el servidor con el catálogo real (${(flow.action.totalCents / 100).toFixed(2)} USD). En el canal real se registraría con la RPC atómica y se avisaría al equipo.`
      }

      databaseError(
        await db.saveMessage(business.id, SIMULATOR_CONTACT, 'user', message),
        'guardar mensaje de prueba',
      )
      if (reply) {
        databaseError(
          await db.saveMessage(business.id, SIMULATOR_CONTACT, 'assistant', reply),
          'guardar respuesta de prueba',
        )
      }
      console.log(`🧪 [Sim] ${business.name || business.id}: modo menú`)
      return res.json({
        reply,
        options: flowOptions,
        image: flowImage,
        video: flowVideo,
        // Paso "Ver fotos y videos": lista completa (fotos + video) que el canal
        // real envía como mensajes separados; el simulador la muestra igual.
        media: (flow.media || []).map(item => ({ url: item.url, isVideo: item.isVideo })),
        mediaNote: null,
        actionNote,
      })
    }

    // El simulador no puede convertir miniapp en una conversación con IA: el
    // negocio real corta antes del modelo y emite un enlace personal.
    if (business.chat_mode === 'miniapp') {
      databaseError(
        await db.saveMessage(business.id, SIMULATOR_CONTACT, 'user', message),
        'guardar mensaje de prueba',
      )
      databaseError(
        await db.saveMessage(business.id, SIMULATOR_CONTACT, 'assistant', MINIAPP_REPLY),
        'guardar respuesta de prueba',
      )
      console.log(`🧪 [Sim] ${business.name || business.id}: miniapp sin IA`)
      return res.json({
        reply: MINIAPP_REPLY,
        options: null,
        image: null,
        video: null,
        mediaNote: null,
        actionNote: MINIAPP_NOTE,
      })
    }

    if (wantsWelcomeMenu(message)) {
      // Saludo o pedido de menú: responde el SERVIDOR con las capacidades
      // reales del negocio, sin gastar una llamada de IA.
      const products = await db.getProducts(business.id)
      const menu = buildWelcomeMenu(business, products.length)
      databaseError(
        await db.saveMessage(business.id, SIMULATOR_CONTACT, 'user', message),
        'guardar mensaje de prueba',
      )
      databaseError(
        await db.saveMessage(business.id, SIMULATOR_CONTACT, 'assistant', menuAsHistory(menu)),
        'guardar respuesta de prueba',
      )
      console.log(`🧪 [Sim] ${business.name || business.id}: menú de bienvenida`)
      return res.json({
        reply: menu.text,
        options: menu.options,
        image: null,
        video: null,
        mediaNote: null,
        actionNote: '📋 Menú de bienvenida generado por el servidor con las capacidades reales del negocio, sin llamada a la IA. Prototipo del simulador: en WhatsApp/Telegram el saludo sigue el flujo normal por ahora.',
      })
    }

    // Sin modo reconocido el simulador no inventa una respuesta.
    //
    // Aquí caía el MODO IA hasta el 2026-08-21: se armaba un prompt con el
    // catálogo y las políticas y el modelo redactaba. Se retiró con la IA —
    // todo lo que ve el cliente lo escribe ahora el código.
    console.log(`🧪 [Sim] ${business.name || business.id}: modo no reconocido (${business.chat_mode || 'vacío'})`)
    return res.json({
      reply: 'Este negocio no tiene un modo de conversación válido configurado.',
      options: [],
      image: null,
      video: null,
      mediaNote: null,
      actionNote: '⚠️ El modo de conversación del negocio no es válido. Configúralo en el panel del superadmin.',
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
      // El modo menú también empieza de cero al limpiar el chat
      resetMenuFlow(req.params.bizId, SIMULATOR_CONTACT)
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
