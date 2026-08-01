import axios from 'axios'
import type {
  ProviderClient,
  YCloudPhoneNumber,
  YCloudWebhookEndpoint,
} from '../services/credential-monitor'

// Consultas de SOLO LECTURA al estado de las cuentas en los proveedores.
// Alimenta la vigilancia de credenciales; no envía mensajes ni modifica nada.

const TIMEOUT_MS = 12_000

const ycloudGet = async <T>(path: string, apiKey: string): Promise<T> => {
  const response = await axios.get<T>(`https://api.ycloud.com/v2/${path}`, {
    headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
    timeout: TIMEOUT_MS,
  })
  return response.data
}

export const providerStatusClient: ProviderClient = {
  async listPhoneNumbers(apiKey) {
    const data = await ycloudGet<{ items?: YCloudPhoneNumber[] }>(
      'whatsapp/phoneNumbers?limit=20',
      apiKey,
    )
    return data.items || []
  },

  async listWebhooks(apiKey) {
    const data = await ycloudGet<{ items?: YCloudWebhookEndpoint[] }>(
      'webhookEndpoints?limit=20',
      apiKey,
    )
    return data.items || []
  },

  async getBalance(apiKey) {
    const data = await ycloudGet<{ amount?: number; currency?: string }>('balance', apiKey)
    if (typeof data.amount !== 'number') return null
    return { amount: data.amount, currency: data.currency || 'USD' }
  },

  async getTelegramBotName(token) {
    const response = await axios.get<{ ok?: boolean; result?: { username?: string } }>(
      `https://api.telegram.org/bot${token}/getMe`,
      { timeout: TIMEOUT_MS },
    )
    return response.data.ok ? (response.data.result?.username || 'bot') : null
  },
}
