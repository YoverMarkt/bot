import axios from 'axios'
import { MEDIA_LIMITS } from '../lib/media'

export interface ProductMedia {
  image_url?: string | null
}

// Evita que una URL configurable convierta al servidor en un proxy hacia la
// red local. Cloudinary es el almacenamiento administrado por BotPanel; para
// otros hosts Telegram/WhatsApp reciben la URL y la descargan ellos mismos.
function isTrustedMediaDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'res.cloudinary.com'
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

async function getImageBuffer(product: ProductMedia | null | undefined): Promise<Buffer | null> {
  if (!product?.image_url) return null
  if (product.image_url.startsWith('data:')) {
    const base64 = product.image_url.split(',')[1]
    return Buffer.from(base64, 'base64')
  }
  if (isTrustedMediaDownloadUrl(product.image_url)) {
    const response = await axios.get<ArrayBuffer>(product.image_url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      maxContentLength: MEDIA_LIMITS.image,
      maxBodyLength: MEDIA_LIMITS.image,
    })
    return Buffer.from(response.data)
  }
  return null
}

export { getImageBuffer, isTrustedMediaDownloadUrl }
