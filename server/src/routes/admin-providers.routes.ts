import axios from 'axios'
import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

type Provider = 'ycloud' | 'meta' | 'kapso' | 'telegram' | 'retell' | string

interface VerifyProviderPayload {
  provider?: Provider
  ycloud_api_key?: string
  ycloud_number?: string
  meta_token?: string
  meta_phone_id?: string
  kapso_api_key?: string
  telegram_bot_token?: string
  retell_api_key?: string
}

interface BusinessRecord extends VerifyProviderPayload {
  whatsapp_provider?: Provider
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

function redactSecrets(text: string, payload: VerifyProviderPayload): string {
  let safe = text
  const secrets = [
    payload.ycloud_api_key,
    payload.meta_token,
    payload.kapso_api_key,
    payload.telegram_bot_token,
    payload.retell_api_key,
  ]
  for (const secret of secrets) {
    if (secret && secret.length >= 4) safe = safe.split(secret).join('••••••')
  }
  return safe.slice(0, 300)
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
  return { ok: false, info: redactSecrets(`${prefix}${message}${hint}`, payload) }
}

async function verifyProvider(payload: VerifyProviderPayload): Promise<VerificationResult> {
  const {
    provider,
    ycloud_api_key: ycloudApiKey,
    ycloud_number: ycloudNumber,
    meta_token: metaToken,
    meta_phone_id: metaPhoneId,
    telegram_bot_token: telegramBotToken,
    retell_api_key: retellApiKey,
  } = payload
  try {
    if (provider === 'ycloud') {
      const key = (ycloudApiKey || process.env.YCLOUD_API_KEY || '').trim()
      if (!key) return { ok: false, info: 'Falta YCloud API Key' }
      const response = await axios.get<{ items?: YCloudNumber[]; data?: YCloudNumber[] }>(
        'https://api.ycloud.com/v2/whatsapp/phoneNumbers',
        {
          headers: { 'X-API-Key': key, Accept: 'application/json' },
          params: { page: 1, limit: 10 },
          timeout: 10000,
        },
      )
      const numbers = response.data.items || response.data.data || []
      const digits = (ycloudNumber || '').replace(/\D/g, '')
      const tail = digits.slice(-9)
      const found = tail.length >= 8
        ? numbers.find(number => (
            (number.phoneNumber || '').replace(/\D/g, '').slice(-9) === tail
          ))
        : undefined
      if (!numbers.length) {
        return {
          ok: false,
          info: 'API Key válida pero NO hay números de WhatsApp en tu cuenta YCloud. Vincula tu número primero.',
        }
      }
      if (digits && !found) {
        const available = numbers.map(number => number.phoneNumber).join(', ')
        return {
          ok: false,
          info: `⚠️ La API Key sirve, pero el número ${ycloudNumber} NO coincide con los de tu cuenta. Números disponibles: ${available}`,
        }
      }
      return {
        ok: true,
        info: found
          ? `✅ Conectado: ${found.phoneNumber} — ${found.displayName || found.verifiedName || 'activo'}`
          : `✅ API Key válida — ${numbers.length} número(s) en tu cuenta. Ingresa el número para confirmar cuál usar.`,
      }
    }

    if (provider === 'meta') {
      if (!metaPhoneId || !metaToken) {
        return { ok: false, info: 'Faltan Meta Token y Phone ID' }
      }
      const response = await axios.get<{
        verified_name?: string
        display_phone_number?: string
        code_verification_status?: string
      }>(`https://graph.facebook.com/v19.0/${metaPhoneId}`, {
        params: {
          access_token: metaToken,
          fields: 'display_phone_number,verified_name,code_verification_status',
        },
        timeout: 8000,
      })
      return {
        ok: true,
        info: `${response.data.verified_name} — ${response.data.display_phone_number} (${response.data.code_verification_status || 'verificado'})`,
      }
    }

    if (provider === 'kapso') {
      const key = payload.kapso_api_key || process.env.KAPSO_API_KEY
      if (!key) return { ok: false, info: 'Falta la Kapso API Key' }
      const response = await axios.get<{ name?: string }>('https://api.kapso.ai/v1/account', {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 8000,
      })
      return { ok: true, info: `Kapso conectado — ${response.data.name || 'cuenta activa'}` }
    }

    if (provider === 'telegram') {
      const token = telegramBotToken || process.env.TELEGRAM_BOT_TOKEN
      if (!token) return { ok: false, info: 'Falta el Bot Token de Telegram' }
      const response = await axios.get<{
        ok?: boolean
        result?: { username?: string; first_name?: string }
      }>(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8000 })
      if (!response.data.ok) throw new Error('Token inválido')
      const telegramBot = response.data.result || {}
      return {
        ok: true,
        info: `@${telegramBot.username} (${telegramBot.first_name}) — bot activo`,
      }
    }

    if (provider === 'retell') {
      const key = retellApiKey || process.env.RETELL_API_KEY
      if (!key) return { ok: false, info: 'Falta RETELL_API_KEY en el .env del servidor' }
      const response = await axios.get<unknown>('https://api.retell.ai/list-agents', {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 8000,
      })
      const agents = Array.isArray(response.data) ? response.data : []
      return { ok: true, info: `${agents.length} agente(s) configurado(s) en Retell` }
    }

    return { ok: false, info: `Proveedor "${provider}" no reconocido` }
  } catch (error) {
    return providerError(error, payload)
  }
}

router.post('/api/admin/verify-provider', auth.authAdmin, async (req, res) => {
  res.json(await verifyProvider(req.body as VerifyProviderPayload))
})

router.post('/api/admin/clients/:id/verify', auth.authAdmin, async (req, res) => {
  const business = await db.getBusinessById(req.params.id)
  if (!business) return res.status(404).json({ error: 'No encontrado' })
  res.json(await verifyProvider({
    provider: business.whatsapp_provider || 'ycloud',
    ycloud_api_key: business.ycloud_api_key,
    ycloud_number: business.ycloud_number,
    meta_token: business.meta_token,
    meta_phone_id: business.meta_phone_id,
    kapso_api_key: business.kapso_api_key,
    telegram_bot_token: business.telegram_bot_token,
  }))
})

export = router
