import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const axios = require('axios')
const ycloud = require('../dist/integrations/ycloud')
const whatsapp = require('../dist/integrations/whatsapp')

let originalYCloudKey

beforeEach(() => {
  originalYCloudKey = process.env.YCLOUD_API_KEY
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalYCloudKey === undefined) delete process.env.YCLOUD_API_KEY
  else process.env.YCLOUD_API_KEY = originalYCloudKey
})

describe('integración multi-proveedor de WhatsApp', () => {
  it('envía texto por Meta con las credenciales del negocio', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})
    await whatsapp.sendText({
      whatsapp_provider: 'meta',
      meta_phone_id: 'phone-a',
      meta_token: 'meta-business-token',
    }, '593990000001', 'Hola')

    expect(post).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/phone-a/messages',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '593990000001',
        type: 'text',
        text: { body: 'Hola' },
      },
      {
        headers: {
          Authorization: 'Bearer meta-business-token',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    )
  })

  it('delega YCloud con número y clave pertenecientes al mismo negocio', async () => {
    process.env.YCLOUD_API_KEY = 'ycloud-global-key'
    const sendText = vi.spyOn(ycloud, 'sendText').mockResolvedValue(undefined)
    const showTyping = vi.spyOn(ycloud, 'showTyping').mockResolvedValue(undefined)
    const business = {
      whatsapp_provider: '   ',
      ycloud_api_key: 'ycloud-business-key',
      ycloud_number: '+593990000010',
      whatsapp_number: '+593990000099',
    }

    await whatsapp.sendText(business, '+593990000001', 'Hola')
    await whatsapp.sendTyping(business, 'inbound-a')

    expect(sendText).toHaveBeenCalledWith(
      'ycloud-business-key', '+593990000010', '+593990000001', 'Hola',
    )
    expect(showTyping).toHaveBeenCalledWith('ycloud-business-key', 'inbound-a')
  })

  it('un negocio solo-Telegram falla claro sin llamar a YCloud con credenciales ajenas', async () => {
    process.env.YCLOUD_API_KEY = 'ycloud-global-key'
    const sendText = vi.spyOn(ycloud, 'sendText').mockResolvedValue(undefined)
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} })
    const business = { whatsapp_provider: 'telegram', whatsapp_number: '+593987000111' }

    await expect(whatsapp.sendText(business, '+593987000111', 'Aviso al dueño'))
      .rejects.toThrow('solo por Telegram')
    await expect(whatsapp.sendImage(business, '+593987000111', 'https://cdn.example.com/a.jpg'))
      .rejects.toThrow('solo por Telegram')
    await expect(whatsapp.sendVideo(business, '+593987000111', 'https://cdn.example.com/a.mp4'))
      .rejects.toThrow('solo por Telegram')

    expect(sendText).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('no usa typing para Meta y los fallos no filtran respuestas del proveedor', async () => {
    const showTyping = vi.spyOn(ycloud, 'showTyping').mockResolvedValue(undefined)
    const providerError = Object.assign(new Error('Meta no disponible'), {
      isAxiosError: true,
      response: { data: { echoed_token: 'secret-that-must-not-be-logged' } },
    })
    vi.spyOn(axios, 'post').mockRejectedValue(providerError)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const business = {
      whatsapp_provider: 'meta', meta_phone_id: 'phone-a', meta_token: 'token-a',
    }

    await expect(whatsapp.sendText(business, '593990000001', 'Hola')).rejects.toBe(providerError)
    await whatsapp.sendTyping(business, 'inbound-a')

    expect(showTyping).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('❌ [meta] sendText:', 'Meta no disponible')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-that-must-not-be-logged')
  })

  it('mantiene el transporte WhatsApp aislado y sin secretos', () => {
    const service = fs.readFileSync(new URL('../src/integrations/whatsapp.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).not.toContain('@ts-nocheck')
    expect(service).not.toMatch(/Bearer sk-[A-Za-z0-9_-]+/)
    expect(entry).toContain("require('../integrations/whatsapp')")
  })
})
