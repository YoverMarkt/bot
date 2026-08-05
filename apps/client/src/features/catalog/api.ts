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

// ── Motor de opciones ────────────────────────────────────────────────
// Lo que convierte el catálogo en configuración: grupos obligatorios,
// mínimos y máximos, contadores y estrategias de precio. Sustituye a los
// modificadores de arriba, que quedan para el modo menú del bot.

export type SelectionType = 'single' | 'multiple' | 'quantity'

export type PricingStrategy =
  | 'sum' | 'fixed' | 'highest_selected' | 'lowest_selected'
  | 'average' | 'included' | 'included_up_to_limit' | 'extra_after_limit'

export type OptionGroup = {
  id: string
  /** Cuelga de un producto O de una categoría, nunca de ambos. */
  product_id: string | null
  category_id: string | null
  name: string
  description: string | null
  selection_type: SelectionType
  required: boolean
  min_selectable: number
  max_selectable: number
  max_total_quantity: number | null
  pricing_strategy: PricingStrategy
  free_selections: number
  option_template_id: string | null
  sort: number
  active: boolean
}

export type OptionGroupPayload = Omit<OptionGroup, 'id'>

export type ProductOption = {
  id: string
  option_group_id: string
  name: string
  description: string | null
  image_url: string | null
  image_public_id: string | null
  /** Admite NEGATIVOS: «sin sopa −0.50». */
  price_adjustment: string | number
  references_product_id: string | null
  default_selected: boolean
  stock: 'disponible' | 'agotado'
  sort: number
  active: boolean
}

export type ProductOptionPayload = Omit<ProductOption, 'id'>

export type OptionTemplate = {
  id: string
  name: string
  description: string | null
  active: boolean
  /** Cuántos grupos se sirven de ella. El panel avisa antes de borrar. */
  used_by_groups: number
}

export type OptionTemplateItem = Omit<ProductOption, 'option_group_id'> & {
  option_template_id: string
}

export const getOptionGroups = () => api<OptionGroup[]>('/api/client/option-groups')

export const createOptionGroup = (g: OptionGroupPayload) =>
  api<OptionGroup>('/api/client/option-groups', { method: 'POST', body: JSON.stringify(g) })

export const updateOptionGroup = (id: string, g: OptionGroupPayload) =>
  api(`/api/client/option-groups/${id}`, { method: 'PUT', body: JSON.stringify(g) })

export const deleteOptionGroup = (id: string) =>
  api(`/api/client/option-groups/${id}`, { method: 'DELETE' })

export const getOptions = () => api<ProductOption[]>('/api/client/options')

export const createOption = (o: ProductOptionPayload) =>
  api<ProductOption>('/api/client/options', { method: 'POST', body: JSON.stringify(o) })

export const updateOption = (id: string, o: ProductOptionPayload) =>
  api(`/api/client/options/${id}`, { method: 'PUT', body: JSON.stringify(o) })

export const deleteOption = (id: string) =>
  api(`/api/client/options/${id}`, { method: 'DELETE' })

export const getOptionTemplates = () => api<OptionTemplate[]>('/api/client/option-templates')

export const createOptionTemplate = (t: { name: string; description: string | null }) =>
  api<OptionTemplate>('/api/client/option-templates', { method: 'POST', body: JSON.stringify(t) })

export const updateOptionTemplate = (id: string, t: { name: string; description: string | null }) =>
  api(`/api/client/option-templates/${id}`, { method: 'PUT', body: JSON.stringify(t) })

export const deleteOptionTemplate = (id: string) =>
  api(`/api/client/option-templates/${id}`, { method: 'DELETE' })

export const getOptionTemplateItems = () =>
  api<OptionTemplateItem[]>('/api/client/option-template-items')

export const createOptionTemplateItem = (i: Omit<OptionTemplateItem, 'id'>) =>
  api<OptionTemplateItem>('/api/client/option-template-items', {
    method: 'POST', body: JSON.stringify(i),
  })

export const updateOptionTemplateItem = (id: string, i: Omit<OptionTemplateItem, 'id'>) =>
  api(`/api/client/option-template-items/${id}`, { method: 'PUT', body: JSON.stringify(i) })

export const deleteOptionTemplateItem = (id: string) =>
  api(`/api/client/option-template-items/${id}`, { method: 'DELETE' })
