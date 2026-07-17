import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createBotMedia, findTargetProduct, productScore } = require('../dist/services/bot-media')

const business = { id: 'business-a', name: 'Negocio A' }
const floral = {
  name: 'Perfume Floral Intenso',
  brand: 'Aura',
  external_sku: 'SKU-100',
  image_url: 'https://cdn.example/floral.jpg',
  video_url: 'https://cdn.example/floral.mp4',
}
const woody = {
  name: 'Perfume Madera Nocturna',
  brand: 'Bosque',
  external_sku: 'SKU-200',
  image_url: 'https://cdn.example/madera.jpg',
  video_url: 'https://cdn.example/madera.mp4',
}

function setup(overrides = {}) {
  const database = {
    getProducts: vi.fn().mockResolvedValue([floral, woody]),
    ...overrides.database,
  }
  const logger = { log: vi.fn(), error: vi.fn() }
  const media = createBotMedia({ database, logger })
  const send = vi.fn().mockResolvedValue(undefined)
  const sendImage = vi.fn().mockResolvedValue(undefined)
  const sendVideo = vi.fn().mockResolvedValue(undefined)
  return { media, database, logger, send, sendImage, sendVideo }
}

function request(overrides = {}) {
  return {
    business,
    text: 'Muéstrame una foto del Perfume Floral Intenso',
    reply: 'Con gusto.',
    history: [],
    products: [floral, woody],
    preFiltered: false,
    wantsImage: true,
    wantsVideo: false,
    send: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendVideo: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('media de productos del bot', () => {
  it('prioriza nombre completo, SKU y marca sobre coincidencias parciales', () => {
    expect(productScore(floral, 'Quiero el perfume floral intenso')).toBe(100)
    expect(productScore(floral, '¿Tienen SKU-100?')).toBe(90)
    expect(productScore(floral, 'Muéstrame uno de Aura')).toBe(50)
    expect(productScore(floral, 'Solo recuerdo la palabra floral')).toBe(1)
  })

  it('elige primero el mensaje actual, luego respuesta e historial reciente', () => {
    expect(findTargetProduct(
      [floral, woody],
      ['Quiero Perfume Floral Intenso', 'Te muestro Perfume Madera Nocturna'],
    )).toEqual(floral)

    expect(findTargetProduct(
      [floral, woody],
      ['', 'Te muestro Perfume Madera Nocturna', 'Antes vimos Perfume Floral Intenso'],
    )).toEqual(woody)
  })

  it('recarga el catálogo completo usando solo el negocio resuelto tras RAG', async () => {
    const { media, database, sendImage } = setup()

    await media.sendRequestedProductMedia(request({
      products: [],
      preFiltered: true,
      sendImage,
    }))

    expect(database.getProducts).toHaveBeenCalledWith('business-a')
    expect(database.getProducts).not.toHaveBeenCalledWith('business-b')
    expect(sendImage).toHaveBeenCalledWith(
      'https://cdn.example/floral.jpg', 'Perfume Floral Intenso',
    )
  })

  it('no consulta ni envía nada cuando no se pidió media', async () => {
    const { media, database, send, sendImage, sendVideo } = setup()

    await expect(media.sendRequestedProductMedia(request({
      wantsImage: false,
      wantsVideo: false,
      send,
      sendImage,
      sendVideo,
    }))).resolves.toBe(false)

    expect(database.getProducts).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(sendImage).not.toHaveBeenCalled()
    expect(sendVideo).not.toHaveBeenCalled()
  })

  it('no adivina ni envía un producto con una coincidencia débil', async () => {
    const { media, logger, send, sendImage } = setup()

    await expect(media.sendRequestedProductMedia(request({
      text: 'Muéstrame una foto del floral',
      reply: 'Claro.',
      history: [],
      send,
      sendImage,
    }))).resolves.toBe(false)

    expect(send).not.toHaveBeenCalled()
    expect(sendImage).not.toHaveBeenCalled()
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('no identifiqué con certeza el producto'),
    )
  })

  it('envía foto y video del mismo producto cuando ambos existen', async () => {
    const { media, send, sendImage, sendVideo } = setup()

    await media.sendRequestedProductMedia(request({
      wantsVideo: true,
      send,
      sendImage,
      sendVideo,
    }))

    expect(sendImage).toHaveBeenCalledWith(
      floral.image_url, 'Perfume Floral Intenso',
    )
    expect(sendVideo).toHaveBeenCalledWith(
      floral.video_url, 'Perfume Floral Intenso',
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('ofrece video si se pidió foto y el producto solo tiene video', async () => {
    const videoOnly = { ...floral, image_url: null }
    const { media, send, sendImage, sendVideo } = setup()

    await media.sendRequestedProductMedia(request({
      products: [videoOnly],
      send,
      sendImage,
      sendVideo,
    }))

    expect(send).toHaveBeenCalledWith(
      'De ese producto no tengo foto, pero le comparto un video 👇',
    )
    expect(sendVideo).toHaveBeenCalledWith(
      videoOnly.video_url, 'Perfume Floral Intenso',
    )
    expect(sendImage).not.toHaveBeenCalled()
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(
      sendVideo.mock.invocationCallOrder[0],
    )
  })

  it('ofrece foto si se pidió video y el producto solo tiene imagen', async () => {
    const imageOnly = { ...floral, video_url: null }
    const { media, send, sendImage, sendVideo } = setup()

    await media.sendRequestedProductMedia(request({
      products: [imageOnly],
      wantsImage: false,
      wantsVideo: true,
      send,
      sendImage,
      sendVideo,
    }))

    expect(send).toHaveBeenCalledWith(
      'De ese producto no tengo video, pero le comparto una foto 👇',
    )
    expect(sendImage).toHaveBeenCalledWith(
      imageOnly.image_url, 'Perfume Floral Intenso',
    )
    expect(sendVideo).not.toHaveBeenCalled()
  })

  it('avisa sin inventar enlaces cuando el producto no tiene media', async () => {
    const withoutMedia = { ...floral, image_url: null, video_url: null }
    const { media, send, sendImage, sendVideo } = setup()

    await media.sendRequestedProductMedia(request({
      products: [withoutMedia],
      wantsVideo: true,
      send,
      sendImage,
      sendVideo,
    }))

    expect(send).toHaveBeenCalledWith(
      'De ese producto todavía no tengo foto ni video 🙏, pero con gusto le doy todos los detalles.',
    )
    expect(sendImage).not.toHaveBeenCalled()
    expect(sendVideo).not.toHaveBeenCalled()
  })

  it('mantiene la selección de media aislada en TypeScript', () => {
    const service = fs.readFileSync(new URL('../src/services/bot-media.ts', import.meta.url), 'utf8')
    const conversation = fs.readFileSync(new URL('../src/services/bot-conversation.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('database.getProducts(business.id)')
    expect(service).not.toContain('@ts-nocheck')
    expect(conversation).toContain("require('./bot-media')")
    expect(entry).toContain("require('./bot-conversation')")
  })
})
