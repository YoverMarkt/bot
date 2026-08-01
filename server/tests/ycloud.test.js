import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import ycloud from '../dist/integrations/ycloud.js'

const require = createRequire(import.meta.url)
const axios = require('axios')

const API_KEY = 'test-api-key'
const FROM = '+593999000001'
const TO = '+593999000002'
const MESSAGE_URL = 'https://api.ycloud.com/v2/whatsapp/messages'
const DIRECT_MESSAGE_URL = `${MESSAGE_URL}/sendDirectly`
const REQUEST_HEADERS = {
  'X-API-Key': API_KEY,
  'Content-Type': 'application/json',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cliente de YCloud', () => {
  it('envía texto con el contrato esperado por YCloud', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.sendText(API_KEY, FROM, TO, 'Hola')

    expect(post).toHaveBeenCalledOnce()
    expect(post).toHaveBeenCalledWith(MESSAGE_URL, {
      from: FROM,
      to: TO,
      type: 'text',
      text: { body: 'Hola' },
    }, { headers: REQUEST_HEADERS, timeout: 15000 })
  })

  it('envía imágenes y conserva el caption vacío por defecto', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.sendImage(API_KEY, FROM, TO, 'https://cdn.example/image.jpg')

    expect(post).toHaveBeenCalledWith(MESSAGE_URL, {
      from: FROM,
      to: TO,
      type: 'image',
      image: { link: 'https://cdn.example/image.jpg', caption: '' },
    }, { headers: REQUEST_HEADERS, timeout: 15000 })
  })

  it('envía videos con su caption', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.sendVideo(API_KEY, FROM, TO, 'https://cdn.example/video.mp4', 'Demostración')

    expect(post).toHaveBeenCalledWith(MESSAGE_URL, {
      from: FROM,
      to: TO,
      type: 'video',
      video: { link: 'https://cdn.example/video.mp4', caption: 'Demostración' },
    }, { headers: REQUEST_HEADERS, timeout: 15000 })
  })

  it('usa el envío síncrono para una secuencia estricta de media y CTA', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.sendImage(
      API_KEY,
      FROM,
      TO,
      'https://cdn.example/image.jpg',
      '',
      true,
    )
    await ycloud.sendVideo(
      API_KEY,
      FROM,
      TO,
      'https://cdn.example/video.mp4',
      '',
      true,
    )
    await ycloud.sendInteractive(
      API_KEY,
      FROM,
      TO,
      '¿Cotizamos tus fechas?',
      [{ id: '1', title: '📅 Cotizar estadía' }],
      undefined,
      true,
    )

    expect(post.mock.calls.map(call => call[0])).toEqual([
      DIRECT_MESSAGE_URL,
      DIRECT_MESSAGE_URL,
      DIRECT_MESSAGE_URL,
    ])
  })

  it('activa el indicador de escritura con timeout acotado', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.showTyping(API_KEY, 'inbound-message-id')

    expect(post).toHaveBeenCalledWith(
      'https://api.ycloud.com/v2/whatsapp/inboundMessages/inbound-message-id/typingIndicator',
      {},
      { headers: REQUEST_HEADERS, timeout: 3000 },
    )
  })

  it('marca explícitamente como leído con el endpoint oficial', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.markAsRead(API_KEY, 'inbound-message-id')

    expect(post).toHaveBeenCalledWith(
      'https://api.ycloud.com/v2/whatsapp/inboundMessages/inbound-message-id/markAsRead',
      {},
      { headers: REQUEST_HEADERS, timeout: 3000 },
    )
  })

  it('codifica un wamid antes de incluirlo en la ruta', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.markAsRead(API_KEY, 'wamid.HBgN/a+b==')

    expect(post).toHaveBeenCalledWith(
      'https://api.ycloud.com/v2/whatsapp/inboundMessages/wamid.HBgN%2Fa%2Bb%3D%3D/markAsRead',
      {},
      { headers: REQUEST_HEADERS, timeout: 3000 },
    )
  })

  it('no llama a YCloud si falta el id del mensaje entrante', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.markAsRead(API_KEY, '   ')
    await ycloud.showTyping(API_KEY, null)

    expect(post).not.toHaveBeenCalled()
  })

  it('propaga errores de YCloud para que el bot aplique su manejo actual', async () => {
    const expected = new Error('YCloud no disponible')
    vi.spyOn(axios, 'post').mockRejectedValue(expected)

    await expect(ycloud.sendText(API_KEY, FROM, TO, 'Hola')).rejects.toBe(expected)
  })
})
