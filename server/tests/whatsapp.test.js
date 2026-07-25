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
    const markAsRead = vi.spyOn(ycloud, 'markAsRead').mockResolvedValue(undefined)
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
    expect(markAsRead).toHaveBeenCalledWith('ycloud-business-key', 'inbound-a')
    expect(showTyping).toHaveBeenCalledWith('ycloud-business-key', 'inbound-a')
  })

  it('propaga el modo directo para mantener media y CTA en secuencia', async () => {
    const sendImage = vi.spyOn(ycloud, 'sendImage').mockResolvedValue(undefined)
    const sendVideo = vi.spyOn(ycloud, 'sendVideo').mockResolvedValue(undefined)
    const sendInteractive = vi.spyOn(ycloud, 'sendInteractive').mockResolvedValue(true)
    const business = {
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'ycloud-business-key',
      ycloud_number: '+593990000010',
    }

    await whatsapp.sendImage(
      business,
      '+593990000001',
      'https://cdn.example.com/a.jpg',
      '',
      'direct',
    )
    await whatsapp.sendVideo(
      business,
      '+593990000001',
      'https://cdn.example.com/a.mp4',
      '',
      'direct',
    )
    await whatsapp.sendInteractive(
      business,
      '+593990000001',
      '¿Cotizamos tus fechas?',
      [{ id: '1', title: '📅 Cotizar estadía' }],
      undefined,
      'direct',
    )

    expect(sendImage).toHaveBeenCalledWith(
      'ycloud-business-key',
      '+593990000010',
      '+593990000001',
      'https://cdn.example.com/a.jpg',
      '',
      true,
    )
    expect(sendVideo).toHaveBeenCalledWith(
      'ycloud-business-key',
      '+593990000010',
      '+593990000001',
      'https://cdn.example.com/a.mp4',
      '',
      true,
    )
    expect(sendInteractive).toHaveBeenCalledWith(
      'ycloud-business-key',
      '+593990000010',
      '+593990000001',
      '¿Cotizamos tus fechas?',
      [{ id: '1', title: '📅 Cotizar estadía' }],
      undefined,
      true,
    )
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
    const markAsRead = vi.spyOn(ycloud, 'markAsRead').mockResolvedValue(undefined)
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

    expect(markAsRead).not.toHaveBeenCalled()
    expect(showTyping).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('❌ [meta] sendText:', 'Meta no disponible')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-that-must-not-be-logged')
  })

  it('intenta el respaldo de typing y registra fallos de lectura sin filtrar secretos', async () => {
    const providerError = Object.assign(new Error('Request failed with status code 404'), {
      isAxiosError: true,
      response: { data: { apiKey: 'secret-that-must-not-be-logged' } },
    })
    const markAsRead = vi.spyOn(ycloud, 'markAsRead').mockRejectedValue(providerError)
    const showTyping = vi.spyOn(ycloud, 'showTyping').mockResolvedValue(undefined)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const business = {
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'ycloud-business-key',
      ycloud_number: '+593990000010',
    }

    await expect(whatsapp.sendTyping(business, 'inbound-a')).resolves.toBeUndefined()

    expect(markAsRead).toHaveBeenCalledWith('ycloud-business-key', 'inbound-a')
    expect(showTyping).toHaveBeenCalledWith('ycloud-business-key', 'inbound-a')
    expect(warning).toHaveBeenCalledWith(
      '⚠️  [ycloud] markAsRead:',
      'Request failed with status code 404',
    )
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-that-must-not-be-logged')
    expect(JSON.stringify(warning.mock.calls)).not.toContain('ycloud-business-key')
    expect(JSON.stringify(warning.mock.calls)).not.toContain('inbound-a')
  })

  it('conserva la lectura si falla únicamente el indicador de escritura', async () => {
    const markAsRead = vi.spyOn(ycloud, 'markAsRead').mockResolvedValue(undefined)
    const showTyping = vi.spyOn(ycloud, 'showTyping')
      .mockRejectedValue(new Error('typing no disponible'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const business = {
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'ycloud-business-key',
      ycloud_number: '+593990000010',
    }

    await expect(whatsapp.sendTyping(business, 'inbound-a')).resolves.toBeUndefined()

    expect(markAsRead).toHaveBeenCalledOnce()
    expect(showTyping).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(
      '⚠️  [ycloud] typingIndicator:',
      'typing no disponible',
    )
  })

  it('neutraliza rechazos desconocidos antes de escribirlos en logs', async () => {
    vi.spyOn(ycloud, 'markAsRead').mockRejectedValue({
      apiKey: 'secret-that-must-not-be-logged',
    })
    vi.spyOn(ycloud, 'showTyping').mockResolvedValue(undefined)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await whatsapp.sendTyping({
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'ycloud-business-key',
    }, 'inbound-a')

    expect(warning).toHaveBeenCalledWith(
      '⚠️  [ycloud] markAsRead:',
      'Error no identificado',
    )
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-that-must-not-be-logged')
  })

  it('mantiene el transporte WhatsApp aislado y sin secretos', () => {
    const service = fs.readFileSync(new URL('../src/integrations/whatsapp.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).not.toContain('@ts-nocheck')
    expect(service).not.toMatch(/Bearer sk-[A-Za-z0-9_-]+/)
    expect(entry).toContain("require('../integrations/whatsapp')")
  })
})
