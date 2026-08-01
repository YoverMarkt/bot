import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  SALDO_MINIMO_USD,
  checkAllCredentials,
  checkBusinessCredentials,
} = require('../dist/services/credential-monitor')

const BASE_URL = 'https://web-production-3433c.up.railway.app'

const negocio = (extra = {}) => ({
  id: 'biz-1',
  name: 'Hostal Vista Andina',
  active: true,
  suspended: false,
  whatsapp_provider: 'ycloud',
  whatsapp_number: '+593991716574',
  ycloud_number: '+593991716574',
  ycloud_api_key: 'clave-de-prueba',
  ...extra,
})

// Cuenta sana: número conectado, webhook bien apuntado y saldo suficiente.
const clienteSano = (extra = {}) => ({
  listPhoneNumbers: async () => [{ phoneNumber: '+593991716574', status: 'CONNECTED' }],
  listWebhooks: async () => [{
    id: 'wh-1',
    url: `${BASE_URL}/webhook/ycloud`,
    status: 'active',
    enabledEvents: ['whatsapp.inbound_message.received'],
  }],
  getBalance: async () => ({ amount: 25, currency: 'USD' }),
  getTelegramBotName: async () => 'bot_de_prueba',
  ...extra,
})

const codigos = problemas => problemas.map(p => p.code)

describe('vigilancia de credenciales', () => {
  it('no reporta nada cuando la cuenta está sana', async () => {
    const problemas = await checkBusinessCredentials(
      negocio(), clienteSano(), { baseUrl: BASE_URL },
    )
    expect(problemas).toEqual([])
  })

  describe('cosas que dejan al bot incomunicado', () => {
    it('detecta que falta la API Key', async () => {
      const problemas = await checkBusinessCredentials(
        negocio({ ycloud_api_key: '' }), clienteSano(), { baseUrl: BASE_URL },
      )
      expect(codigos(problemas)).toContain('sin_api_key')
      expect(problemas[0].severity).toBe('error')
    })

    it('detecta una API Key que el proveedor rechaza', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listPhoneNumbers: async () => { throw new Error('401 Unauthorized') },
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('api_key_rechazada')
    })

    it('detecta que el número no está en la cuenta', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listPhoneNumbers: async () => [{ phoneNumber: '+593000000000', status: 'CONNECTED' }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('numero_ajeno')
    })

    it('detecta un número que dejó de estar conectado', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listPhoneNumbers: async () => [{ phoneNumber: '+593991716574', status: 'FLAGGED' }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('numero_desconectado')
    })
  })

  // Lo que realmente pasó en julio de 2026: el webhook quedó apuntando mal y
  // sin entregar, mientras todo lo demás se veía perfecto.
  describe('el webhook, que es donde se rompió', () => {
    it('detecta que no hay ningún webhook activo', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listWebhooks: async () => [{ id: 'w', url: `${BASE_URL}/webhook/ycloud`, status: 'disabled' }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('sin_webhook')
    })

    it('detecta un webhook apuntando a otro dominio', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listWebhooks: async () => [{
          id: 'w',
          url: 'https://dominio-viejo.up.railway.app/webhook/ycloud',
          status: 'active',
          enabledEvents: ['whatsapp.inbound_message.received'],
        }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('webhook_desviado')
    })

    it('detecta un webhook que no escucha los mensajes entrantes', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listWebhooks: async () => [{
          id: 'w', url: `${BASE_URL}/webhook/ycloud`, status: 'active', enabledEvents: [],
        }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('webhook_sin_evento')
    })
  })

  describe('saldo', () => {
    it('avisa antes de quedarse sin servicio, no después', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        getBalance: async () => ({ amount: 0.5, currency: 'USD' }),
      }), { baseUrl: BASE_URL })
      const saldo = problemas.find(p => p.code === 'saldo_bajo')
      expect(saldo).toBeTruthy()
      expect(saldo.severity).toBe('aviso')
      expect(SALDO_MINIMO_USD).toBeGreaterThan(0)
    })

    it('no convierte un saldo ilegible en un problema del canal', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        getBalance: async () => { throw new Error('sin permiso') },
      }), { baseUrl: BASE_URL })
      expect(problemas).toEqual([])
    })
  })

  describe('Telegram', () => {
    it('detecta un token que Telegram no reconoce', async () => {
      const problemas = await checkBusinessCredentials(
        negocio({ whatsapp_provider: 'telegram', telegram_bot_token: 'token-malo' }),
        clienteSano({ getTelegramBotName: async () => null }),
      )
      expect(codigos(problemas)).toContain('token_invalido')
    })
  })

  describe('revisión de toda la plataforma', () => {
    it('omite negocios inactivos o suspendidos', async () => {
      const problemas = await checkAllCredentials([
        negocio({ id: 'a', active: false, ycloud_api_key: '' }),
        negocio({ id: 'b', suspended: true, ycloud_api_key: '' }),
      ], clienteSano(), { baseUrl: BASE_URL })
      expect(problemas).toEqual([])
    })

    it('un negocio que falla no impide revisar los demás', async () => {
      const problemas = await checkAllCredentials([
        negocio({ id: 'a' }),
        negocio({ id: 'b', ycloud_api_key: '' }),
      ], clienteSano(), { baseUrl: BASE_URL })
      expect(problemas).toHaveLength(1)
      expect(problemas[0].businessId).toBe('b')
    })

    it('identifica el negocio de cada problema', async () => {
      const problemas = await checkAllCredentials(
        [negocio({ id: 'biz-x', name: 'Pizzería', ycloud_api_key: '' })],
        clienteSano(), { baseUrl: BASE_URL },
      )
      expect(problemas[0].businessId).toBe('biz-x')
      expect(problemas[0].businessName).toBe('Pizzería')
    })
  })
})
