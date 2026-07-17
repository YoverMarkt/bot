import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const axios = require('axios')
const media = require('../dist/services/media')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('carga de imágenes del bot', () => {
  it('decodifica una imagen data URL sin hacer solicitudes externas', async () => {
    const get = vi.spyOn(axios, 'get')
    const encoded = Buffer.from('contenido-imagen').toString('base64')

    const result = await media.getImageBuffer({
      image_url: `data:image/jpeg;base64,${encoded}`,
    })

    expect(result.toString()).toBe('contenido-imagen')
    expect(get).not.toHaveBeenCalled()
  })

  it('descarga una URL con respuesta binaria y timeout acotado', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: Uint8Array.from([1, 2, 3]).buffer,
    })

    const url = 'https://res.cloudinary.com/demo/image/upload/image.jpg'
    const result = await media.getImageBuffer({ image_url: url })

    expect(get).toHaveBeenCalledWith(url, {
      responseType: 'arraybuffer', timeout: 8000,
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024,
    })
    expect([...result]).toEqual([1, 2, 3])
  })

  it('ignora productos sin imagen o formatos no soportados', async () => {
    await expect(media.getImageBuffer(null)).resolves.toBeNull()
    await expect(media.getImageBuffer({})).resolves.toBeNull()
    await expect(media.getImageBuffer({ image_url: 'ftp://example/image.jpg' })).resolves.toBeNull()
  })

  it('no descarga URLs configurables de Internet o redes internas', async () => {
    const get = vi.spyOn(axios, 'get')

    await expect(media.getImageBuffer({
      image_url: 'https://cdn.example/image.jpg',
    })).resolves.toBeNull()
    await expect(media.getImageBuffer({
      image_url: 'https://127.0.0.1/internal.jpg',
    })).resolves.toBeNull()
    await expect(media.getImageBuffer({
      image_url: 'https://169.254.169.254/metadata',
    })).resolves.toBeNull()

    expect(get).not.toHaveBeenCalled()
  })

  it('mantiene la implementación de media tipada y conectada a la entrada', () => {
    const service = fs.readFileSync(new URL('../src/services/media.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).not.toContain('@ts-nocheck')
    expect(entry).toContain("require('./media')")
  })
})
