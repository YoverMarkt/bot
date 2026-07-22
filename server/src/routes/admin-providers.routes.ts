import axios from 'axios'
import type { RequestHandler } from 'express'
import { metaGraphUrl } from '../config/meta-graph'
import { createRouter } from '../middleware/async'
import { normalizeChannelIdentifier } from '../types/channels'

const ALLOWED_PROVIDERS = ['ycloud', 'meta', 'telegram'] as const
type Provider = (typeof ALLOWED_PROVIDERS)[number]

interface VerifyProviderPayload {
  provider: Provider
  ycloud_api_key?: string
  ycloud_number?: string
  ycloud_webhook_secret?: string
  ycloud_webhook_endpoint_id?: string
  meta_token?: string
  meta_phone_id?: string
  telegram_bot_token?: string
}

interface BusinessRecord {
  whatsapp_provider?: unknown
  ycloud_api_key?: unknown
  ycloud_number?: unknown
  ycloud_webhook_secret?: unknown
  ycloud_webhook_endpoint_id?: unknown
  meta_token?: unknown
  meta_phone_id?: unknown
  telegram_bot_token?: unknown
}

interface YCloudNumber {
  phoneNumber?: string
  displayName?: string
  verifiedName?: string
}

interface VerificationResult {
  ok: boolean
  info: string
}

const db = require('../db') as {
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
}
const auth = require('../middleware/auth') as {
  authAdmin: RequestHandler
}

const router = createRouter()

function providerFrom(value: unknown): Provider | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return ALLOWED_PROVIDERS.find(provider => provider === normalized) || null
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function directVerificationPayload(body: Record<string, unknown>): VerifyProviderPayload | null {
  const provider = providerFrom(body.provider)
  if (!provider) return null
  return {
    provider,
    ycloud_api_key: optionalText(body.ycloud_api_key),
    ycloud_number: optionalText(body.ycloud_number),
    ycloud_webhook_secret: optionalText(body.ycloud_webhook_secret),
    ycloud_webhook_endpoint_id: optionalText(body.ycloud_webhook_endpoint_id),
    meta_token: optionalText(body.meta_token),
    meta_phone_id: optionalText(body.meta_phone_id),
    telegram_bot_token: optionalText(body.telegram_bot_token),
  }
}

function mergedSecret(
  body: Record<string, unknown>,
  business: BusinessRecord,
  field: 'ycloud_api_key' | 'meta_token' | 'telegram_bot_token' | 'ycloud_webhook_secret',
): string | undefined {
  const submitted = optionalText(body[field])
  // Los inputs secretos vacíos significan “conservar el guardado”. El panel
  // nunca necesita recibir el valor existente para verificar un cambio.
  return submitted?.trim() ? submitted : optionalText(business[field])
}

function mergedText(
  body: Record<string, unknown>,
  business: BusinessRecord,
  field: 'ycloud_number' | 'meta_phone_id' | 'ycloud_webhook_endpoint_id',
): string | undefined {
  return Object.prototype.hasOwnProperty.call(body, field)
    ? optionalText(body[field])
    : optionalText(business[field])
}

function prospectiveVerificationPayload(
  body: Record<string, unknown>,
  business: BusinessRecord,
): VerifyProviderPayload | null {
  const provider = providerFrom(
    Object.prototype.hasOwnProperty.call(body, 'provider')
      ? body.provider
      : business.whatsapp_provider || 'ycloud',
  )
  if (!provider) return null
  return {
    provider,
    ycloud_api_key: mergedSecret(body, business, 'ycloud_api_key'),
    ycloud_number: mergedText(body, business, 'ycloud_number'),
    ycloud_webhook_secret: mergedSecret(body, business, 'ycloud_webhook_secret'),
    ycloud_webhook_endpoint_id: mergedText(body, business, 'ycloud_webhook_endpoint_id'),
    meta_token: mergedSecret(body, business, 'meta_token'),
    meta_phone_id: mergedText(body, business, 'meta_phone_id'),
    telegram_bot_token: mergedSecret(body, business, 'telegram_bot_token'),
  }
}

function redactSecrets(text: string, payload: VerifyProviderPayload): string {
  let safe = text
  const secrets = [
    payload.ycloud_api_key,
    payload.meta_token,
    payload.telegram_bot_token,
  ]
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      for (const representation of new Set([secret, encodeURIComponent(secret)])) {
        safe = safe.split(representation).join('••••••')
      }
    }
  }
  return safe.slice(0, 300)
}

function verificationResult(
  ok: boolean,
  info: string,
  payload: VerifyProviderPayload,
): VerificationResult {
  return { ok, info: redactSecrets(info, payload) }
}

// El webhook pesa tanto como la API Key: sin Signing Secret el servidor rechaza
// las entregas de YCloud en producción (503) y el bot deja de recibir mensajes.
// Avisarlo aquí evita descubrirlo recién al intentar guardar (o peor, ya en vivo).
function ycloudWebhookGap(payload: VerifyProviderPayload): string {
  const configured = (value: unknown, fallback?: string) => (
    Boolean((typeof value === 'string' && value.trim()) || fallback?.trim())
  )
  const missing: string[] = []
  if (!configured(payload.ycloud_webhook_secret, process.env.YCLOUD_WEBHOOK_SECRET)) {
    missing.push('Signing Secret')
  }
  if (!configured(payload.ycloud_webhook_endpoint_id, process.env.YCLOUD_WEBHOOK_ENDPOINT_ID)) {
    missing.push('Endpoint ID')
  }
  if (!missing.length) return ''
  return `\n⚠️ Falta ${missing.join(' y ')} del webhook (cópialos en YCloud → Developers → Webhooks). Sin eso no puedes guardar el negocio y en producción el bot no recibirá mensajes.`
}

function providerError(error: unknown, payload: VerifyProviderPayload): VerificationResult {
  let status: number | undefined
  let message = error instanceof Error ? error.message : 'Error de conexión'
  if (axios.isAxiosError(error)) {
    status = error.response?.status
    const response = error.response?.data as {
      error?: { message?: string }
      message?: string
      description?: string
    } | undefined
    message = response?.error?.message
      || response?.message
      || response?.description
      || error.message
      || message
  }
  const hint = status === 401 || status === 403
    ? ' (API Key inválida o sin permisos)'
    : status === 404
      ? ' (endpoint no encontrado)'
      : ''
  const prefix = status ? `[HTTP ${status}] ` : ''
  const safeMessage = typeof message === 'string' ? message : 'Error de conexión'
  return { ok: false, info: redactSecrets(`${prefix}${safeMessage}${hint}`, payload) }
}

async function verifyProvider(payload: VerifyProviderPayload): Promise<VerificationResult> {
  const {
    provider,
    ycloud_api_key: ycloudApiKey,
    ycloud_number: ycloudNumber,
    meta_token: metaToken,
    meta_phone_id: metaPhoneId,
    telegram_bot_token: telegramBotToken,
  } = payload
  const effectiveSecrets = { ...payload }
  try {
    if (provider === 'ycloud') {
      const key = (ycloudApiKey || process.env.YCLOUD_API_KEY || '').trim()
      if (!key) return verificationResult(false, 'Falta YCloud API Key', effectiveSecrets)
      effectiveSecrets.ycloud_api_key = key
      const response = await axios.get<{ items?: YCloudNumber[]; data?: YCloudNumber[] }>(
        'https://api.ycloud.com/v2/whatsapp/phoneNumbers',
        {
          headers: { 'X-API-Key': key, Accept: 'application/json' },
          params: { page: 1, limit: 10 },
          timeout: 10000,
        },
      )
      const numbers = response.data.items || response.data.data || []
      const canonical = normalizeChannelIdentifier('phone', ycloudNumber)
      const found = canonical
        ? numbers.find(number => (
            normalizeChannelIdentifier('phone', number.phoneNumber) === canonical
          ))
        : undefined
      if (!numbers.length) {
        return verificationResult(
          false,
          'API Key válida pero NO hay números de WhatsApp en tu cuenta YCloud. Vincula tu número primero.',
          effectiveSecrets,
        )
      }
      if (ycloudNumber && !canonical) {
        return verificationResult(
          false,
          'El número YCloud debe usar formato internacional E.164 con 8 a 15 dígitos.',
          effectiveSecrets,
        )
      }
      const webhookGap = ycloudWebhookGap(effectiveSecrets)
      if (canonical && !found) {
        const available = numbers.map(number => number.phoneNumber).join(', ')
        return verificationResult(
          false,
          `⚠️ La API Key sirve, pero el número ${ycloudNumber} NO coincide con los de tu cuenta. Números disponibles: ${available}${webhookGap}`,
          effectiveSecrets,
        )
      }
      return verificationResult(
        !webhookGap,
        (found
          ? `✅ Conectado: ${found.phoneNumber} — ${found.displayName || found.verifiedName || 'activo'}`
          : `✅ API Key válida — ${numbers.length} número(s) en tu cuenta. Ingresa el número para confirmar cuál usar.`
        ) + webhookGap,
        effectiveSecrets,
      )
    }

    if (provider === 'meta') {
      if (!metaPhoneId || !metaToken) {
        return verificationResult(false, 'Faltan Meta Token y Phone ID', effectiveSecrets)
      }
      const response = await axios.get<{
        verified_name?: string
        display_phone_number?: string
        code_verification_status?: string
      }>(metaGraphUrl(metaPhoneId), {
        params: {
          access_token: metaToken,
          fields: 'display_phone_number,verified_name,code_verification_status',
        },
        timeout: 8000,
      })
      return verificationResult(
        true,
        `${response.data.verified_name} — ${response.data.display_phone_number} (${response.data.code_verification_status || 'verificado'})`,
        effectiveSecrets,
      )
    }

    if (provider === 'telegram') {
      const token = telegramBotToken || process.env.TELEGRAM_BOT_TOKEN
      if (!token) {
        return verificationResult(false, 'Falta el Bot Token de Telegram', effectiveSecrets)
      }
      effectiveSecrets.telegram_bot_token = token
      const response = await axios.get<{
        ok?: boolean
        result?: { username?: string; first_name?: string }
      }>(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8000 })
      if (!response.data.ok) throw new Error('Token inválido')
      const telegramBot = response.data.result || {}
      return verificationResult(
        true,
        `@${telegramBot.username} (${telegramBot.first_name}) — bot activo`,
        effectiveSecrets,
      )
    }

    return verificationResult(false, 'Proveedor no reconocido', effectiveSecrets)
  } catch (error) {
    return providerError(error, effectiveSecrets)
  }
}

router.post('/api/admin/verify-provider', auth.authAdmin, async (req, res) => {
  const payload = directVerificationPayload(req.body as Record<string, unknown>)
  if (!payload) return res.json({ ok: false, info: 'Proveedor no reconocido' })
  res.json(await verifyProvider(payload))
})

router.post('/api/admin/clients/:id/verify', auth.authAdmin, async (req, res) => {
  const business = await db.getBusinessById(req.params.id)
  if (!business) return res.status(404).json({ error: 'No encontrado' })
  const payload = prospectiveVerificationPayload(
    req.body as Record<string, unknown>,
    business,
  )
  if (!payload) return res.json({ ok: false, info: 'Proveedor no reconocido' })
  res.json(await verifyProvider(payload))
})

export = router
