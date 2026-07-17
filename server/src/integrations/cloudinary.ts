import {
  v2 as cloudinary,
  type UploadApiErrorResponse,
  type UploadApiResponse,
} from 'cloudinary'

interface CloudinaryCredentials {
  cloud_name?: string
  api_key?: string
  api_secret?: string
}

export interface MediaUploadResult {
  url: string
  public_id: string
  resource_type: string
}

const settings = require('../services/settings') as {
  get(key: string): Promise<string | null | undefined>
}

async function configure(): Promise<boolean> {
  const cloudName = await settings.get('cloudinary_cloud_name')
  const apiKey = await settings.get('cloudinary_api_key')
  const apiSecret = await settings.get('cloudinary_api_secret')
  if (!cloudName || !apiKey || !apiSecret) return false

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  })
  return true
}

export async function isConfigured(): Promise<boolean> {
  return configure()
}

export async function verify(override: CloudinaryCredentials = {}) {
  const cloudName = override.cloud_name || await settings.get('cloudinary_cloud_name')
  const apiKey = override.api_key || await settings.get('cloudinary_api_key')
  const apiSecret = override.api_secret || await settings.get('cloudinary_api_secret')
  if (!cloudName || !apiKey || !apiSecret) {
    return {
      ok: false,
      info: 'Faltan datos de Cloudinary (cloud name, API key o secret)',
    }
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  })
  const response = await cloudinary.api.ping()
  const connected = response?.status === 'ok'
  return {
    ok: connected,
    info: connected
      ? `✅ Cloudinary conectado — cloud "${cloudName}"`
      : 'Respuesta inesperada',
  }
}

export async function uploadMedia(
  buffer: Buffer,
  businessId: string,
): Promise<MediaUploadResult> {
  if (!(await configure())) throw new Error('Cloudinary no está configurado')

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `botpanel/${businessId}`, resource_type: 'auto' },
      (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        if (error) return reject(error)
        const uploaded = result as UploadApiResponse
        resolve({
          url: uploaded.secure_url,
          public_id: uploaded.public_id,
          resource_type: uploaded.resource_type,
        })
      },
    )
    stream.end(buffer)
  })
}

export async function deleteMedia(
  publicId: string,
  resourceType: 'image' | 'video' = 'image',
): Promise<void> {
  if (!publicId) return
  if (!(await configure())) return

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
    console.log(`🗑️  Cloudinary: borrado ${publicId}`)
  } catch (error) {
    console.error('❌ Cloudinary destroy:', (error as Error).message)
  }
}
