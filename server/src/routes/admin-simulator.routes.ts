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

    const imageMatch = rawReply.match(/##IMG##(https?:\/\/[^\s#]+)##/)
    const hasHandoff = /##\s*handoff\s*##/i.test(rawReply)
    let reply = rawReply
      .replace(/##IMG##[^\s#]+##/g, '')
      .replace(/##\s*handoff\s*##/gi, '')
      .replace('##BOOKING##', '')
      .trim()
    if (hasHandoff) reply = HANDOFF_REPLY

    databaseError(
      await db.saveMessage(business.id, SIMULATOR_CONTACT, 'assistant', reply),
      'guardar respuesta de prueba',
    )
    console.log(`🧪 [Sim] ${business.name || business.id}: respondido`)
    res.json({ reply, image: imageMatch?.[1] || null })
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
