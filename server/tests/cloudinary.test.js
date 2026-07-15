import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import cloud from '../dist/integrations/cloudinary.js'

const require = createRequire(import.meta.url)
const cloudinary = require('cloudinary').v2
const settings = require('../dist/services/settings')

afterEach(() => {
  vi.restoreAllMocks()
})

function configuredSettings() {
  return vi.spyOn(settings, 'get').mockImplementation(async key => ({
    cloudinary_cloud_name: 'cloud-test',
    cloudinary_api_key: 'api-key-test',
    cloudinary_api_secret: 'api-secret-test',
  })[key])
}

describe('integración Cloudinary', () => {
  it('solo se configura cuando existen las tres credenciales', async () => {
    vi.spyOn(settings, 'get').mockResolvedValue(null)
    const config = vi.spyOn(cloudinary, 'config')

    expect(await cloud.isConfigured()).toBe(false)
    expect(config).not.toHaveBeenCalled()

    vi.restoreAllMocks()
    configuredSettings()
    const configured = vi.spyOn(cloudinary, 'config')
    expect(await cloud.isConfigured()).toBe(true)
    expect(configured).toHaveBeenCalledWith({
      cloud_name: 'cloud-test',
      api_key: 'api-key-test',
      api_secret: 'api-secret-test',
      secure: true,
    })
  })

  it('verifica credenciales proporcionadas sin exponer el secreto', async () => {
    vi.spyOn(cloudinary, 'config')
    vi.spyOn(cloudinary.api, 'ping').mockResolvedValue({ status: 'ok' })

    const result = await cloud.verify({
      cloud_name: 'override-cloud',
      api_key: 'override-key',
      api_secret: 'override-secret',
    })

    expect(result).toEqual({
      ok: true,
      info: '✅ Cloudinary conectado — cloud "override-cloud"',
    })
    expect(result.info).not.toContain('override-secret')
  })

  it('sube el buffer a la carpeta aislada del negocio', async () => {
    configuredSettings()
    vi.spyOn(cloudinary, 'config')
    const uploadStream = vi.spyOn(cloudinary.uploader, 'upload_stream')
      .mockImplementation((options, callback) => ({
        end(buffer) {
          expect(buffer).toEqual(Buffer.from('media'))
          callback(undefined, {
            secure_url: 'https://cdn.example/media.jpg',
            public_id: 'botpanel/business-a/media',
            resource_type: 'image',
          })
        },
      }))

    const result = await cloud.uploadMedia(Buffer.from('media'), 'business-a')

    expect(uploadStream).toHaveBeenCalledWith(
      { folder: 'botpanel/business-a', resource_type: 'auto' },
      expect.any(Function),
    )
    expect(result).toEqual({
      url: 'https://cdn.example/media.jpg',
      public_id: 'botpanel/business-a/media',
      resource_type: 'image',
    })
  })

  it('no intenta borrar si falta publicId o configuración', async () => {
    const get = vi.spyOn(settings, 'get').mockResolvedValue(null)
    const destroy = vi.spyOn(cloudinary.uploader, 'destroy')

    await cloud.deleteMedia('')
    expect(get).not.toHaveBeenCalled()

    await cloud.deleteMedia('media-id')
    expect(destroy).not.toHaveBeenCalled()
  })
})
