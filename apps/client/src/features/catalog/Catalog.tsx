import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Film, Plus, Pencil, Trash2, Package, Camera } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as catApi from './api'
import type { Product, ProductPayload } from './api'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Textarea } from '@botpanel/ui/components/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Badge } from '@botpanel/ui/components/badge'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Label } from '@botpanel/ui/components/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const money = (n: string | number | null) => {
  const v = Number(n)
  return v > 0 ? `$${v.toFixed(2)}` : 'a consultar'
}

const STOCK_STYLE: Record<Product['stock'], string> = {
  'disponible': 'bg-green-500/10 text-green-700 dark:text-green-300',
  'últimas unidades': 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  'agotado': 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
}

export default function Catalog() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  // "+ Agregar producto" del Inicio llega con ?new=1 y abre el modal directo (como el viejo)
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('new') === '1') { setEditing('new'); setParams({}, { replace: true }) }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const { data: products = [], isLoading, isError, refetch } = useQuery({ queryKey: ['products'], queryFn: catApi.getProducts })

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return products
    return products.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.brand ?? '').toLowerCase().includes(q) ||
      (p.external_sku ?? '').toLowerCase().includes(q))
  }, [products, search])

  const refresh = () => qc.invalidateQueries({ queryKey: ['products'] })

  const mDelete = useMutation({
    mutationFn: catApi.deleteProduct,
    onSuccess: () => { refresh(); toast.success('Producto eliminado') },
  })

  async function handleReindex() {
    toast.info('Indexando catálogo…')
    try { const r = await catApi.reindex(); toast.success(r.message || 'Indexación iniciada') }
    catch { toast.error('Error al reindexar') }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Catálogo</h1>
          <p className="text-sm text-muted-foreground">{products.length} producto(s) — lo que el bot ofrece a tus clientes</p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Input
            id="catalog-search"
            aria-label="Buscar productos"
            value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, marca o SKU…" className="w-full sm:w-64"
          />
          <Button variant="outline" onClick={handleReindex} title="Regenera la búsqueda inteligente del bot">
            <span className="inline-flex items-center gap-1.5"><Search className="w-4 h-4" /> Reindexar</span>
          </Button>
          <Button onClick={() => setEditing('new')}>
            <span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Agregar producto</span>
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <QueryError onRetry={() => { void refetch() }} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(p => (
            <Card key={p.id} className="py-0 gap-0 overflow-hidden">
              <div className="h-36 bg-muted flex items-center justify-center overflow-hidden relative">
                {p.image_url
                  ? <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
                  : <Package className="w-9 h-9 text-muted-foreground/40" />}
                {p.video_url && <span className="absolute top-2 right-2 text-[10px] bg-black/70 text-white rounded px-1.5 py-0.5"><Film className="w-3 h-3 inline mr-0.5" />video</span>}
              </div>
              <div className="p-3 flex-1 flex flex-col">
                <div className="font-medium text-sm text-foreground leading-snug">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.brand || ''}{p.external_sku ? ` · SKU ${p.external_sku}` : ''}</div>
                <div className="mt-auto pt-2 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-foreground">{money(p.price_sale && Number(p.price_sale) > 0 ? p.price_sale : p.price)}</span>
                    {p.price_sale && Number(p.price_sale) > 0 && Number(p.price) > 0 &&
                      <span className="text-xs text-muted-foreground/80 line-through ml-1.5">{money(p.price)}</span>}
                  </div>
                  <Badge variant="secondary" className={`text-[10px] px-1.5 ${STOCK_STYLE[p.stock] ?? ''}`}>{p.stock}</Badge>
                </div>
                <div className="flex gap-2 mt-3">
                  <Button variant="outline" size="sm" onClick={() => setEditing(p)} className="flex-1"><Pencil /> Editar</Button>
                  <ConfirmAction
                    trigger={<Button variant="outline" size="icon-sm" aria-label={`Eliminar ${p.name}`}><Trash2 className="w-3.5 h-3.5" /></Button>}
                    title={`Eliminar “${p.name}”`}
                    description="El producto dejará de aparecer en el catálogo y en las respuestas del bot."
                    confirmLabel="Eliminar"
                    destructive
                    onConfirm={() => mDelete.mutate(p.id)}
                  />
                </div>
              </div>
            </Card>
          ))}
          {filtered.length === 0 && <p className="text-sm text-muted-foreground col-span-full">No hay productos{search ? ' que coincidan con la búsqueda' : ' aún — agrega el primero'}.</p>}
        </div>
      )}

      {editing && (
        <ProductModal
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); toast.success('Producto guardado') }}
        />
      )}
    </div>
  )
}

// ── Modal crear/editar producto (con subida de foto y video a Cloudinary) ──
function ProductModal({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: product?.name ?? '',
    brand: product?.brand ?? '',
    price: product?.price != null ? String(product.price) : '',
    price_sale: product?.price_sale != null && Number(product.price_sale) > 0 ? String(product.price_sale) : '',
    stock: product?.stock ?? 'disponible',
    description: product?.description ?? '',
    tags: (product?.tags ?? []).join(', '),
    external_sku: product?.external_sku ?? '',
    image_url: product?.image_url ?? '',
    image_public_id: product?.image_public_id ?? '',
    video_url: product?.video_url ?? '',
    video_public_id: product?.video_public_id ?? '',
  })
  const [imgStatus, setImgStatus] = useState('')
  const [vidStatus, setVidStatus] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF(prev => ({ ...prev, [k]: e.target.value }))

  async function upload(kind: 'image' | 'video', file: File | undefined) {
    if (!file) return
    const limit = catApi.MEDIA_LIMITS[kind]
    const setStatus = kind === 'image' ? setImgStatus : setVidStatus
    if (file.size > limit) {
      setStatus(`✗ Supera el límite de WhatsApp: máximo ${kind === 'image' ? '5 MB' : '16 MB'}, tu archivo pesa ${catApi.fmtMB(file.size)}.`)
      return
    }
    setStatus('Subiendo…'); setUploading(true)
    try {
      const out = await catApi.uploadMedia(file)
      if (kind === 'image') setF(prev => ({ ...prev, image_url: out.url, image_public_id: out.public_id }))
      else setF(prev => ({ ...prev, video_url: out.url, video_public_id: out.public_id }))
      setStatus('✓ Subido')
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : 'Error al subir'}`)
    } finally { setUploading(false) }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const price = parseFloat(f.price)
    if (!f.name.trim() || isNaN(price)) { setError('Nombre y precio son obligatorios'); return }
    const payload: ProductPayload = {
      name: f.name.trim(),
      price,
      brand: f.brand.trim() || null,
      price_sale: parseFloat(f.price_sale) > 0 ? parseFloat(f.price_sale) : null,
      stock: f.stock as Product['stock'],
      description: f.description.trim() || null,
      tags: f.tags.split(',').map(t => t.trim()).filter(Boolean),
      external_sku: f.external_sku.trim() || null,
      image_url: f.image_url.trim() || null,
      image_public_id: f.image_public_id || null,
      video_url: f.video_url.trim() || null,
      video_public_id: f.video_public_id || null,
    }
    setSaving(true)
    try {
      if (product) await catApi.updateProduct(product.id, payload)
      else await catApi.createProduct(payload)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    } finally { setSaving(false) }
  }


  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={save}>
        <DialogHeader className="mb-4">
          <DialogTitle>{product ? 'Editar producto' : 'Nuevo producto'}</DialogTitle>
          <DialogDescription>Completa la información que el bot usará para ofrecer este producto.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 mb-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="product-name">Nombre *</Label>
            <Input id="product-name" value={f.name} onChange={set('name')} placeholder="Ej: Pizza Familiar Pepperoni" />
          </div>
          <div>
            <Label htmlFor="product-brand">Marca</Label>
            <Input id="product-brand" value={f.brand} onChange={set('brand')} />
          </div>
          <div>
            <Label htmlFor="product-sku">SKU</Label>
            <Input id="product-sku" value={f.external_sku} onChange={set('external_sku')} />
          </div>
          <div>
            <Label htmlFor="product-price">Precio * ($)</Label>
            <Input id="product-price" type="number" step="0.01" min="0" value={f.price} onChange={set('price')} />
          </div>
          <div>
            <Label htmlFor="product-sale-price">Precio oferta ($)</Label>
            <Input id="product-sale-price" type="number" step="0.01" min="0" value={f.price_sale} onChange={set('price_sale')} placeholder="opcional" />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="product-stock">Stock</Label>
            <Select value={f.stock} onValueChange={v => setF(prev => ({ ...prev, stock: v as Product['stock'] }))}>
              <SelectTrigger id="product-stock" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="disponible">Disponible</SelectItem>
                <SelectItem value="últimas unidades">Últimas unidades</SelectItem>
                <SelectItem value="agotado">Agotado</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="product-description">Descripción</Label>
            <Textarea id="product-description" rows={3} value={f.description} onChange={set('description')} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="product-tags">Etiquetas (separadas por coma)</Label>
            <Input id="product-tags" value={f.tags} onChange={set('tags')} placeholder="nuevo, oferta, popular" />
          </div>
        </div>

        {/* Media: imagen + video → Cloudinary */}
        <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
          <div className="rounded-lg border border-dashed border-input p-3">
            <Label htmlFor="product-image" className="text-xs font-semibold text-foreground/90 mb-1 flex items-center gap-1.5"><Camera className="w-3.5 h-3.5" /> Imagen <span className="font-normal text-muted-foreground/80">(máx 5 MB)</span></Label>
            {f.image_url && <img src={f.image_url} alt="" className="h-16 rounded object-cover mb-2" />}
            <Input id="product-image" type="file" accept="image/*" className="text-xs w-full" onChange={e => upload('image', e.target.files?.[0])} />
            {imgStatus && <div className="text-[11px] mt-1">{imgStatus}</div>}
          </div>
          <div className="rounded-lg border border-dashed border-input p-3">
            <Label htmlFor="product-video" className="text-xs font-semibold text-foreground/90 mb-1 flex items-center gap-1.5"><Film className="w-3.5 h-3.5" /> Video <span className="font-normal text-muted-foreground/80">(máx 16 MB)</span></Label>
            {f.video_url && <div className="text-[11px] text-primary mb-2">✓ Video cargado</div>}
            <Input id="product-video" type="file" accept="video/*" className="text-xs w-full" onChange={e => upload('video', e.target.files?.[0])} />
            {vidStatus && <div className="text-[11px] mt-1">{vidStatus}</div>}
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-destructive mb-3">✗ {error}</p>}

        <DialogFooter className="mx-0 mb-0 px-0 pb-0">
          <Button variant="outline" type="button" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving || uploading}>
            {saving ? 'Guardando…' : uploading ? 'Espera la subida…' : 'Guardar producto'}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
