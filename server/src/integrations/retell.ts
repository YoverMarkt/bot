import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

interface RetellBusiness {
  id: string
  name: string
  type?: string | null
  hours?: string | null
  address?: string | null
  payment_methods?: string | null
  ai_provider?: string | null
  suspended?: boolean | null
}

interface RetellProduct {
  name?: string | null
  brand?: string | null
  price?: string | number | null
  stock?: string | number | null
}

interface RetellPolicies { bot_instructions?: string | null }

interface RetellDatabase {
  getBusinessByPhone(phone: string): Promise<RetellBusiness | null>
  getProducts(businessId: string): Promise<RetellProduct[]>
  getPolicies(businessId: string): Promise<RetellPolicies | null>
  saveMessage(
    businessId: string,
    phone: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<unknown>
}

interface RetellSettings {
  get(key: 'retell_api_key'): Promise<string | null>
}

interface RetellAi {
  callAI(
    prompt: string,
    history: Array<{ role: string; content: string }>,
    text: string,
    provider?: string | null,
  ): Promise<string>
}

interface RetellLogger {
  log(...values: unknown[]): void
  warn(...values: unknown[]): void
  error(...values: unknown[]): void
}

export interface RetellDependencies {
  database: RetellDatabase
  settings: RetellSettings
  ai: RetellAi
  env?: NodeJS.ProcessEnv
  logger?: RetellLogger
  now?: () => number
}

interface RetellTranscriptItem {
  role?: string
  content?: string
}

interface RetellCall {
  to_number?: string
  from_number?: string
  call_id?: string
  call_duration?: number
}

interface RetellBody {
  interaction_type?: string
  transcript?: RetellTranscriptItem[]
  response_id?: unknown
  event?: string
  call?: RetellCall
}

const RETELL_REPLAY_WINDOW_MS = 5 * 60 * 1000

function verifyRetellSignature(
  rawBody: unknown,
  apiKey: unknown,
  signature: unknown,
  now = Date.now(),
): boolean {
  if (!rawBody || !apiKey || !signature) return false
  const match = String(signature).match(/^v=(\d+),d=([a-f0-9]+)$/i)
  if (!match) return false
  const timestampText = match[1] || ''
  const timestamp = Number(timestampText)
  if (!Number.isFinite(timestamp)
    || Math.abs(now - timestamp) > RETELL_REPLAY_WINDOW_MS) return false
  const expected = crypto.createHmac('sha256', String(apiKey))
    .update(String(rawBody) + timestampText).digest('hex')
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(match[2] || '', 'hex'),
    )
  } catch {
    return false
  }
}

function constantTimeTextEqual(received: unknown, expected: string): boolean {
  if (!received) return false
  const left = Buffer.from(String(received))
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function buildVoicePrompt(
  business: RetellBusiness,
  products: RetellProduct[] | null | undefined,
  policies: RetellPolicies | null | undefined,
): string {
  const catalog = (products || []).slice(0, 10).map(product => (
    `- ${product.name}${product.brand ? ` (${product.brand})` : ''}: $${Number.parseFloat(String(product.price)).toFixed(2)} — ${product.stock}`
  )).join('\n')

  return `Eres el asistente telefónico de "${business.name}" (${business.type || 'negocio'}).
Estás respondiendo una LLAMADA DE VOZ.

DATOS:
Horario: ${business.hours || 'No especificado'}
Dirección: ${business.address || 'No especificada'}
Métodos de pago: ${business.payment_methods || ''}

PRODUCTOS (primeros 10):
${catalog || 'Sin productos cargados.'}

POLÍTICAS: ${policies?.bot_instructions || ''}

REGLAS ESTRICTAS PARA VOZ:
1. Respuestas MUY cortas (1-2 oraciones máximo).
2. Sin markdown, sin asteriscos, sin emojis, sin listas.
3. Habla natural, como si fuera una conversación real.
4. Si no sabes algo, di: "Permíteme verificar eso."
5. Si quieren comprar: pide nombre y dirección.`
}

function cleanVoiceContent(value: unknown): string {
  return String(value || '')
    .replace(/##IMG##[^#]+##/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/##BOOKING##/g, '')
    .trim()
}

const response = (responseId: unknown, content: string) => ({
  response_type: 'response',
  response_id: responseId || 1,
  content,
  content_complete: true,
})

function createRetellIntegration(dependencies: RetellDependencies) {
  const { database, settings, ai } = dependencies
  const env = dependencies.env || process.env
  const logger = dependencies.logger || console
  const now = dependencies.now || Date.now

  async function verifyRetellRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<unknown> {
    try {
      const apiKey = await settings.get('retell_api_key')
      const local = env.NODE_ENV !== 'production' && !env.BASE_URL
      if (!apiKey) {
        if (local) return next()
        return res.status(503).json({ error: 'Retell no configurado' })
      }
      const rawBody = req.rawBody?.toString('utf8') || ''
      const signature = req.headers['x-retell-signature']
      if (!verifyRetellSignature(rawBody, apiKey, signature, now())) {
        logger.warn('⚠️  Retell: firma inválida — solicitud rechazada')
        return res.status(401).json({ error: 'Firma inválida' })
      }
      return next()
    } catch (error) {
      logger.error(
        '❌ Verificación Retell:',
        error instanceof Error ? error.message : error,
      )
      return res.status(500).json({ error: 'No se pudo verificar la solicitud' })
    }
  }

  function verifyRetellLLMRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): unknown {
    const configured = env.RETELL_LLM_SECRET
    const local = env.NODE_ENV !== 'production' && !env.BASE_URL
    if (!configured) {
      if (local) return next()
      return res.status(503).json({ error: 'Retell LLM no configurado' })
    }
    const received = req.query.secret || req.headers['x-retell-llm-secret']
    if (!constantTimeTextEqual(received, configured)) {
      return res.status(401).json({ error: 'Secreto inválido' })
    }
    return next()
  }

  async function handleRetellLLM(req: Request, res: Response): Promise<unknown> {
    const body = (req.body || {}) as RetellBody
    const {
      interaction_type: interactionType,
      response_id: responseId,
      call,
    } = body
    if (interactionType === 'call_details' || interactionType === 'ping_pong') {
      return res.json({ response_type: 'ping_pong', timestamp: now() })
    }

    const toNumber = (call?.to_number || '').replace(/\D/g, '')
    const fromNumber = (call?.from_number || '').replace(/\D/g, '')
    try {
      const business = toNumber
        ? await database.getBusinessByPhone(toNumber)
        : null
      if (!business) {
        return res.json(response(
          responseId,
          'Lo siento, no pude identificar el negocio. Por favor intenta de nuevo.',
        ))
      }
      if (business.suspended) {
        return res.json(response(
          responseId,
          'Este servicio tiene un pago pendiente. Contacta al administrador.',
        ))
      }

      const [products, policies] = await Promise.all([
        database.getProducts(business.id),
        database.getPolicies(business.id),
      ])
      const systemPrompt = buildVoicePrompt(business, products, policies)
      const transcript = Array.isArray(body.transcript) ? body.transcript : []
      const messages = transcript.filter(item => item.content).map(item => ({
        role: item.role === 'agent' ? 'assistant' : 'user',
        content: item.content as string,
      }))
      if (!messages.length) messages.push({ role: 'user', content: 'Hola' })

      const last = messages[messages.length - 1]
      const userMessage = last?.role === 'user' ? last.content : 'Hola'
      const history = last?.role === 'user' ? messages.slice(0, -1) : messages
      const rawText = await ai.callAI(
        systemPrompt, history, userMessage, business.ai_provider,
      )
      const content = cleanVoiceContent(rawText)
      const contact = `voice_${fromNumber}`
      await database.saveMessage(
        business.id, contact, 'user', transcript.at(-1)?.content || '',
      )
      await database.saveMessage(
        business.id, contact, 'assistant', content,
      )
      logger.log(`📞 [Retell] ${business.name} — respondido`)
      return res.json(response(responseId, content))
    } catch (error) {
      logger.error(
        '❌ Retell LLM:', error instanceof Error ? error.message : error,
      )
      return res.json(response(
        responseId,
        'Disculpa el inconveniente. ¿Puedes repetir tu consulta?',
      ))
    }
  }

  function handleRetellCallEvent(req: Request, res: Response): unknown {
    const body = (req.body || {}) as RetellBody
    logger.log(`📞 [Retell] Evento: ${body.event} — ${body.call?.call_id}`)
    if (body.event === 'call_ended') {
      logger.log(
        `📞 [Retell] Llamada terminada: duración ${body.call?.call_duration}s`,
      )
    }
    return res.json({ ok: true })
  }

  return {
    handleRetellCallEvent,
    handleRetellLLM,
    verifyRetellLLMRequest,
    verifyRetellRequest,
  }
}

const integration = createRetellIntegration({
  database: require('../db') as RetellDatabase,
  settings: require('../services/settings') as RetellSettings,
  ai: require('../services/ai') as RetellAi,
})

export const handleRetellLLM = integration.handleRetellLLM
export const handleRetellCallEvent = integration.handleRetellCallEvent
export const verifyRetellRequest = integration.verifyRetellRequest
export const verifyRetellLLMRequest = integration.verifyRetellLLMRequest
export {
  buildVoicePrompt,
  cleanVoiceContent,
  constantTimeTextEqual,
  createRetellIntegration,
  verifyRetellSignature,
}
