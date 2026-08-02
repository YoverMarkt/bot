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
  // Agrupa el producto en la mini app. Nulo = aparece suelto.
  category_id: string | null
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

// ── Modificadores de menú (sabores de pizza, salsas, extras) ──
// Una opción que el cliente elige además del producto, agrupada por categoría.
export type MenuModifier = {
  id: string
  category_tag: string
  group_label: string
  name: string
  description: string | null
  sort: number
  active: boolean
}

export type MenuModifierPayload = {
  category_tag: string
  group_label: string
  name: string
  description?: string | null
  sort?: number
  active?: boolean
}

export const getMenuModifiers = () =>
  api<MenuModifier[]>('/api/client/menu-modifiers')

export const createMenuModifier = (p: MenuModifierPayload) =>
  api<MenuModifier>('/api/client/menu-modifiers', { method: 'POST', body: JSON.stringify(p) })

export const updateMenuModifier = (id: string, p: MenuModifierPayload) =>
  api<MenuModifier>(`/api/client/menu-modifiers/${id}`, { method: 'PUT', body: JSON.stringify(p) })

export const deleteMenuModifier = (id: string) =>
  api(`/api/client/menu-modifiers/${id}`, { method: 'DELETE' })

// ── Variantes (tamaños, presentaciones) ──────────────────────
// A diferencia de un modificador, una variante SÍ cambia el precio: es la
// pizza mediana frente a la familiar. Cuelga de un producto concreto.
export type Variant = {
  id: string
  product_id: string
  name: string
  price: string | number
  price_sale: string | number | null
  stock: 'disponible' | 'agotado'
  sort: number
  active: boolean
}

export type VariantPayload = {
  product_id: string
  name: string
  price: number
  price_sale?: number | null
  stock?: 'disponible' | 'agotado'
  sort?: number
  active?: boolean
}

export const getVariants = () => api<Variant[]>('/api/client/variants')

export const createVariant = (p: VariantPayload) =>
  api<Variant>('/api/client/variants', { method: 'POST', body: JSON.stringify(p) })

export const updateVariant = (id: string, p: Omit<VariantPayload, 'product_id'>) =>
  api<Variant>(`/api/client/variants/${id}`, { method: 'PUT', body: JSON.stringify(p) })

export const deleteVariant = (id: string) =>
  api(`/api/client/variants/${id}`, { method: 'DELETE' })

// ── Categorías de la tienda ──────────────────────────────────
// Agrupan el catálogo en la mini app (entradas / pizzas / bebidas). Sin ellas
// el cliente ve una lista plana.
export type Category = {
  id: string
  name: string
  description: string | null
  image_url: string | null
  sort: number
  active: boolean
}

export type CategoryPayload = {
  name: string
  description?: string | null
  sort?: number
  active?: boolean
}

export const getCategories = () => api<Category[]>('/api/client/categories')

export const createCategory = (p: CategoryPayload) =>
  api<Category>('/api/client/categories', { method: 'POST', body: JSON.stringify(p) })

export const updateCategory = (id: string, p: CategoryPayload) =>
  api<Category>(`/api/client/categories/${id}`, { method: 'PUT', body: JSON.stringify(p) })

export const deleteCategory = (id: string) =>
  api(`/api/client/categories/${id}`, { method: 'DELETE' })

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
