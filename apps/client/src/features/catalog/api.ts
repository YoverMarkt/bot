// ── API de Catálogo (tipada) ─────────────────────────────────────────
// Mismos endpoints que el panel viejo (routes/products.routes.js).
import { api, session, ApiError } from '../../api/client'

export type Product = {
  id: string
  name: string
  brand: string | null
  price: string | number
  price_sale: string | number | null
  stock: 'disponible' | 'últimas unidades' | 'agotado'
  description: string | null
  image_url: string | null
  video_url: string | null
  image_public_id: string | null
  video_public_id: string | null
  tags: string[] | null
  external_sku: string | null
  duration_minutes: number | null
}

export type ProductPayload = Partial<Omit<Product, 'id'>> & { name: string; price: number }

export const getProducts = () => api<Product[]>('/api/client/products')

export const createProduct = (p: ProductPayload) =>
  api<Product>('/api/client/products', { method: 'POST', body: JSON.stringify(p) })

export const updateProduct = (id: string, p: ProductPayload) =>
  api(`/api/client/products/${id}`, { method: 'PUT', body: JSON.stringify(p) })

export const deleteProduct = (id: string) =>
  api(`/api/client/products/${id}`, { method: 'DELETE' })

export const reindex = () =>
  api<{ message?: string }>('/api/client/reindex', { method: 'POST' })

// Subida de media a Cloudinary vía backend (multipart — no usa el wrapper JSON).
// Límites estándar de WhatsApp: imagen 5 MB · video 16 MB (el server también los valida).
export const MEDIA_LIMITS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024 }
export const fmtMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export async function uploadMedia(file: File): Promise<{ url: string; public_id: string; resource_type: string }> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/client/media', {
    method: 'POST',
    headers: session.token ? { Authorization: `Bearer ${session.token}` } : {},
    body: fd,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || 'No se pudo subir el archivo')
  return data as { url: string; public_id: string; resource_type: string }
}
