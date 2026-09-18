import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Film, Plus, Pencil, Trash2, Package, Camera } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as catApi from './api'
import OptionsManager from './OptionsManager'
import PlatoPorPartes from './PlatoPorPartes'
import { useBusinessInfo } from '../../lib/biz'
import { vocabularioDe } from './vocabulario'
import type { Product, ProductPayload, Variant, Category } from './api'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Textarea } from '@botpanel/ui/components/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Badge } from '@botpanel/ui/components/badge'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Label } from '@botpanel/ui/components/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@botpanel/ui/components/tabs'
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
  // El catálogo habla el oficio del local: una almuercería no ve ejemplos de
  // pizza. Es solo vocabulario — ni una capacidad ni un dato cambian.
  const voz = vocabularioDe(useBusinessInfo().data?.type)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  // "+ Agregar producto" del Inicio llega con ?new=1 y abre el modal directo (como el viejo)
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('new') === '1') { setEditing('new'); setParams({}, { replace: true }) }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const { data: products = [], isLoading, isError, refetch } = useQuery({ queryKey: ['products'], queryFn: catApi.getProducts })
  // Las categorías hacen falta aquí porque un grupo de opciones puede colgar
  // de una entera: así 19 sabores sirven para todas las pizzas.
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: catApi.getCategories })

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
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Catálogo</h1>
        <p className="text-sm text-muted-foreground">Lo que el bot ofrece a tus clientes</p>
      </div>

      <Tabs defaultValue="productos">
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="productos">Productos</TabsTrigger>
          <TabsTrigger value="tamanos">{voz.tamanos}</TabsTrigger>
          <TabsTrigger value="personalizacion">Personalización</TabsTrigger>
          <TabsTrigger value="categorias">Categorías</TabsTrigger>
        </TabsList>

        <TabsContent value="tamanos" className="mt-4">
          <VariantsPanel products={products} />
        </TabsContent>

        {/* El motor de opciones: el ÚNICO desde el 2026-09-14.
            Al lado vivía «Sabores / Opciones», el modelo viejo (`menu_modifiers`),
            y se retiró: hacía lo mismo, y un dueño no tenía forma de saber cuál
            de las dos usar. Sus únicos datos —los 19 sabores de Monster Pizza—
            ya estaban duplicados aquí. */}
        <TabsContent value="personalizacion" className="mt-4">
          <OptionsManager productos={products} categorias={categories} />
        </TabsContent>

        <TabsContent value="categorias" className="mt-4">
          <CategoriesPanel />
        </TabsContent>

        <TabsContent value="productos" className="mt-4">
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <p className="text-sm text-muted-foreground">{products.length} producto(s)</p>
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
        </TabsContent>
      </Tabs>

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
// Radix no admite un <SelectItem value="">, así que "sin categoría" necesita
// un valor propio que nunca choque con un uuid real.
/**
 * Los días como los lee la base (0 = domingo) y como los escribe la gente
 * (la semana empieza en lunes).
 */
const DIAS_DE_LA_SEMANA = [
  { valor: 1, letra: 'L', nombre: 'lunes' },
  { valor: 2, letra: 'M', nombre: 'martes' },
  { valor: 3, letra: 'X', nombre: 'miércoles' },
  { valor: 4, letra: 'J', nombre: 'jueves' },
  { valor: 5, letra: 'V', nombre: 'viernes' },
  { valor: 6, letra: 'S', nombre: 'sábado' },
  { valor: 0, letra: 'D', nombre: 'domingo' },
]

const SIN_CATEGORIA = '__ninguna__'

function ProductModal({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: catApi.getCategories })
  const voz = vocabularioDe(useBusinessInfo().data?.type)
  const [f, setF] = useState({
    name: product?.name ?? '',
    brand: product?.brand ?? '',
    price: product?.price != null ? String(product.price) : '',
    price_sale: product?.price_sale != null && Number(product.price_sale) > 0 ? String(product.price_sale) : '',
    stock: product?.stock ?? 'disponible',
    category_id: product?.category_id ?? '',
    product_type: product?.product_type ?? 'simple',
    // La franja en que se pide. Vacía = siempre.
    available_days: (product?.available_days ?? []) as number[],
    available_from: (product?.available_from ?? '').slice(0, 5),
    available_until: (product?.available_until ?? '').slice(0, 5),
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
      // Vacío = sin categoría: en la tienda aparece suelto, no agrupado.
      category_id: f.category_id || null,
      product_type: f.product_type as Product['product_type'],
      // ⚠️ Los días vacíos van como NULL, no como lista vacía: la base exige
      // entre 1 y 7 días y rechazaría el producto entero.
      available_days: f.available_days.length ? [...f.available_days].sort((a, b) => a - b) : null,
      // Y las dos horas van juntas o no van: media franja no significa nada.
      available_from: f.available_from && f.available_until ? f.available_from : null,
      available_until: f.available_from && f.available_until ? f.available_until : null,
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
            <Input id="product-name" value={f.name} onChange={set('name')} placeholder={voz.ejemploProducto} />
          </div>
          <div>
            <Label htmlFor="product-price">Precio * ($)</Label>
            <Input id="product-price" type="number" step="0.01" min="0" value={f.price} onChange={set('price')} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="product-type">Tipo de producto</Label>
            <Select
              value={f.product_type}
              onValueChange={v => setF(prev => ({ ...prev, product_type: v as Product['product_type'] }))}
            >
              <SelectTrigger id="product-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">Normal — se pide tal cual</SelectItem>
                <SelectItem value="configurable">Se personaliza — con grupos de opciones</SelectItem>
                <SelectItem value="combo">Combo — se arma eligiendo otros productos</SelectItem>
                <SelectItem value="daily_menu">Del día — solo ciertos días u horas</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground/80 mt-1">
              {f.product_type === 'combo'
                ? `En la mini app se pinta por pasos numerados: «1 ${voz.ejemploGrupo}», «2 Elige tu bebida». Arma los pasos en la pestaña Personalización.`
                : 'El tipo no cambia lo que vendes: cambia cómo lo elige el cliente.'}
            </p>
          </div>
          {/* ── Cuándo se pide ────────────────────────────────────────────
              El «menú con reloj» de las apps grandes: el local es UNO y su
              carta cambia con la hora. Un restaurante con desayuno, almuerzo y
              cena no son tres locales — son tres franjas. Vacío = siempre,
              que es como vive la mayoría de los productos. */}
          <div className="sm:col-span-2 rounded-lg border border-border/70 p-3">
            <span id="product-franja-titulo" className="text-sm font-medium">Cuándo se pide</span>
            <div role="group" aria-labelledby="product-franja-titulo" className="mt-2 flex flex-wrap gap-1.5">
              {DIAS_DE_LA_SEMANA.map(dia => {
                const elegido = f.available_days.includes(dia.valor)
                return (
                  <button
                    key={dia.valor}
                    type="button"
                    aria-pressed={elegido}
                    aria-label={dia.nombre}
                    onClick={() => setF(prev => ({
                      ...prev,
                      available_days: elegido
                        ? prev.available_days.filter(v => v !== dia.valor)
                        : [...prev.available_days, dia.valor],
                    }))}
                    className={`size-8 rounded-full border text-[11px] font-semibold transition ${
                      elegido
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border/70 text-muted-foreground hover:border-primary/50'
                    }`}
                  >
                    {dia.letra}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="product-desde" className="text-[11px]">Desde</Label>
                <Input id="product-desde" type="time" className="w-32" value={f.available_from}
                  onChange={e => setF(prev => ({ ...prev, available_from: e.target.value }))} />
              </div>
              <div>
                <Label htmlFor="product-hasta" className="text-[11px]">Hasta</Label>
                <Input id="product-hasta" type="time" className="w-32" value={f.available_until}
                  onChange={e => setF(prev => ({ ...prev, available_until: e.target.value }))} />
              </div>
              {(f.available_days.length > 0 || f.available_from || f.available_until) && (
                <Button type="button" variant="ghost" size="sm"
                  onClick={() => setF(prev => ({ ...prev, available_days: [], available_from: '', available_until: '' }))}>
                  Quitar la franja
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground/80 mt-2">
              {f.available_days.length === 0 && !f.available_from
                ? 'Sin franja: se puede pedir siempre que el local esté abierto.'
                : 'Fuera de esta franja el cliente lo ve en la carta, pero no lo puede pedir. Una franja que cruza la medianoche (18:00 a 02:00) cuenta como la noche del día que empieza.'}
            </p>
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="product-category">Categoría en la tienda</Label>
            <Select value={f.category_id || SIN_CATEGORIA} onValueChange={v => setF(prev => ({ ...prev, category_id: v === SIN_CATEGORIA ? '' : v }))}>
              <SelectTrigger id="product-category" className="w-full"><SelectValue placeholder="Sin categoría" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SIN_CATEGORIA}>Sin categoría</SelectItem>
                {categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground/80 mt-1">
              {categories.length === 0
                ? 'Crea categorías en la pestaña Categorías para agrupar tu catálogo.'
                : 'Sin categoría el producto aparece suelto, fuera de los grupos.'}
            </p>
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
        </div>

        {/* ── El plato por partes (un almuerzo: sopa + segundo) ─────────
            Solo al EDITAR: sus partes cuelgan del producto, y un producto que
            aún no existe no tiene id del que colgarlas. */}
        {product
          ? (
              <PlatoPorPartes
                productId={product.id}
                productName={f.name.trim() || product.name}
                precio={Number.parseFloat(f.price) || Number(product.price) || 0}
              />
            )
          : (
              <p className="mb-4 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                ¿Se arma por partes, como un almuerzo de sopa y segundo? Guárdalo y vuelve a abrirlo
                para armarlo.
              </p>
            )}

        {/* ── Lo que casi nadie necesita, plegado ──────────────────────
            ⚠️ El formulario pedía doce campos de golpe, y para un local de diez
            platos eso es un muro. `brand` y `external_sku` ni siquiera llegan
            al cliente: los usa el bot para BUSCAR fotos en catálogos de retail,
            y en producción están vacíos en los 23 productos. No se borran —un
            supermercado los necesita— pero una almuercería no debería tropezar
            con ellos para crear un almuerzo.

            ⚠️ `details` nativo y no un componente nuevo: el sistema compartido
            no trae uno plegable, y esto es accesible con teclado sin añadir una
            dependencia para un acordeón. */}
        <details className="mb-4 rounded-lg border border-border/60">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            Más opciones
            <span className="ml-1 font-normal text-muted-foreground/70">
              — oferta, stock, descripción, marca, etiquetas y video
            </span>
          </summary>
          <div className="grid grid-cols-1 gap-3 border-t border-border/60 p-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="product-brand">Marca</Label>
            <Input id="product-brand" value={f.brand} onChange={set('brand')} />
          </div>
          <div>
            <Label htmlFor="product-sku">SKU</Label>
            <Input id="product-sku" value={f.external_sku} onChange={set('external_sku')} />
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
          <div className="rounded-lg border border-dashed border-input p-3">
            <Label htmlFor="product-video" className="text-xs font-semibold text-foreground/90 mb-1 flex items-center gap-1.5"><Film className="w-3.5 h-3.5" /> Video <span className="font-normal text-muted-foreground/80">(máx 16 MB)</span></Label>
            {f.video_url && <div className="text-[11px] text-primary mb-2">✓ Video cargado</div>}
            <Input id="product-video" type="file" accept="video/*" className="text-xs w-full" onChange={e => upload('video', e.target.files?.[0])} />
            {vidStatus && <div className="text-[11px] mt-1">{vidStatus}</div>}
          </div>
          </div>
        </details>

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

// ── Pestaña de Tamaños / Presentaciones (variantes) ──
//
// La diferencia con un modificador NO es cosmética y es la que confunde a todo
// el mundo: un modificador es una opción que NO cambia el precio (el sabor de
// la pizza), y una variante SÍ lo cambia (mediana $8, familiar $14).
//
// Por eso una variante cuelga de UN producto concreto y no de una categoría:
// el precio de "familiar" no significa lo mismo en una pizza que en una
// gaseosa. El total lo calcula siempre el servidor con estos precios.
function VariantsPanel({ products }: { products: Product[] }) {
  const voz = vocabularioDe(useBusinessInfo().data?.type)
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Variant | { product_id: string } | null>(null)
  const { data: variants = [], isLoading, isError, refetch } =
    useQuery({ queryKey: ['variants'], queryFn: catApi.getVariants })

  const refresh = () => qc.invalidateQueries({ queryKey: ['variants'] })
  const mDelete = useMutation({
    mutationFn: catApi.deleteVariant,
    onSuccess: () => { refresh(); toast.success('Tamaño eliminado') },
    onError: () => toast.error('No se pudo eliminar'),
  })

  // Agrupadas por producto, que es como el dueño las piensa: abre su pizza y
  // ve sus tamaños, no una lista de 40 variantes sueltas.
  const porProducto = useMemo(() => {
    const map = new Map<string, Variant[]>()
    for (const v of variants) {
      if (!map.has(v.product_id)) map.set(v.product_id, [])
      map.get(v.product_id)!.push(v)
    }
    return products
      .map(p => ({ product: p, items: map.get(p.id) ?? [] }))
      .filter(g => g.items.length > 0)
  }, [variants, products])

  const sinVariantes = products.filter(p => !variants.some(v => v.product_id === p.id))

  if (isLoading) return <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-32 w-full" /></div>
  if (isError) return <QueryError onRetry={() => { void refetch() }} />

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {voz.tamanos} que <strong>sí cambian el precio</strong> — {voz.ejemploTamano}. Cuelgan de un producto concreto. Si un producto no los tiene, se vende a su precio normal.
        </p>
        {products.length > 0 && (
          <Button onClick={() => setEditing({ product_id: products[0].id })}>
            <span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Agregar tamaño</span>
          </Button>
        )}
      </div>

      {products.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">
          Primero crea un producto en la pestaña <strong>Productos</strong>: los tamaños cuelgan de él.
        </Card>
      )}

      {porProducto.map(({ product, items }) => (
        <Card key={product.id} className="p-4 gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground">{product.name}</h3>
            <Button variant="outline" size="sm" onClick={() => setEditing({ product_id: product.id })}>
              <Plus className="w-3.5 h-3.5" /> Agregar
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {items.map(v => (
              <div key={v.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="font-medium text-sm text-foreground">{v.name}</span>
                  <span className="text-sm text-muted-foreground">{money(v.price_sale ?? v.price)}</span>
                  {v.price_sale != null && Number(v.price_sale) > 0 && (
                    <span className="text-xs text-muted-foreground line-through">{money(v.price)}</span>
                  )}
                  {v.stock === 'agotado' && <Badge variant="secondary" className="text-[10px] px-1.5 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">agotado</Badge>}
                  {!v.active && <Badge variant="secondary" className="text-[10px] px-1.5">oculto</Badge>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="outline" size="icon-sm" aria-label={`Editar ${v.name}`} onClick={() => setEditing(v)}><Pencil className="w-3.5 h-3.5" /></Button>
                  <ConfirmAction
                    trigger={<Button variant="outline" size="icon-sm" aria-label={`Eliminar ${v.name}`}><Trash2 className="w-3.5 h-3.5" /></Button>}
                    title={`Eliminar "${v.name}"`}
                    description="Los clientes dejarán de poder pedir esta presentación. Los pedidos que ya la incluyen no cambian."
                    confirmLabel="Eliminar"
                    destructive
                    onConfirm={() => mDelete.mutate(v.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {sinVariantes.length > 0 && porProducto.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Sin tamaños (se venden a su precio normal): {sinVariantes.map(p => p.name).join(' · ')}
        </p>
      )}

      {editing && (
        <VariantModal
          variant={editing}
          products={products}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
        />
      )}
    </div>
  )
}

function VariantModal({ variant, products, onClose, onSaved }: {
  variant: Variant | { product_id: string }
  products: Product[]
  onClose: () => void
  onSaved: () => void
}) {
  const esNuevo = !('id' in variant)
  const [form, setForm] = useState({
    product_id: variant.product_id,
    name: 'name' in variant ? variant.name : '',
    price: 'price' in variant ? String(variant.price) : '',
    price_sale: 'price_sale' in variant && variant.price_sale != null ? String(variant.price_sale) : '',
    stock: 'stock' in variant ? variant.stock : 'disponible' as const,
    sort: 'sort' in variant ? String(variant.sort) : '0',
    active: 'active' in variant ? variant.active : true,
  })
  const [guardando, setGuardando] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const price = Number(form.price)
    if (!form.name.trim()) return toast.error('Ponle un nombre al tamaño')
    if (!Number.isFinite(price) || price <= 0) return toast.error('El precio debe ser mayor que cero')
    const priceSale = form.price_sale.trim() ? Number(form.price_sale) : null
    if (priceSale != null && (!Number.isFinite(priceSale) || priceSale > price)) {
      return toast.error('El precio de oferta no puede superar al normal')
    }

    setGuardando(true)
    try {
      const payload = {
        name: form.name.trim(),
        price,
        price_sale: priceSale,
        stock: form.stock,
        sort: Number(form.sort) || 0,
        active: form.active,
      }
      if (esNuevo) await catApi.createVariant({ ...payload, product_id: form.product_id })
      else await catApi.updateVariant((variant as Variant).id, payload)
      toast.success(esNuevo ? 'Tamaño creado' : 'Tamaño actualizado')
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{esNuevo ? 'Nuevo tamaño' : 'Editar tamaño'}</DialogTitle>
            <DialogDescription>
              El precio de la presentación reemplaza al del producto cuando el cliente la elige.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-4">
            {esNuevo && (
              <div className="grid gap-1.5">
                <Label htmlFor="v-producto">Producto</Label>
                <Select value={form.product_id} onValueChange={v => setForm(f => ({ ...f, product_id: v }))}>
                  <SelectTrigger id="v-producto"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {products.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="v-nombre">Nombre</Label>
              <Input id="v-nombre" value={form.name} maxLength={60} placeholder="Mediana"
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="v-precio">Precio</Label>
                <Input id="v-precio" type="number" step="0.01" min="0" value={form.price}
                  onChange={e => setForm(f => ({ ...f, price: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="v-oferta">Precio oferta</Label>
                <Input id="v-oferta" type="number" step="0.01" min="0" value={form.price_sale}
                  placeholder="opcional"
                  onChange={e => setForm(f => ({ ...f, price_sale: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="v-stock">Disponibilidad</Label>
                <Select value={form.stock} onValueChange={v => setForm(f => ({ ...f, stock: v as 'disponible' | 'agotado' }))}>
                  <SelectTrigger id="v-stock"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disponible">Disponible</SelectItem>
                    <SelectItem value="agotado">Agotado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="v-orden">Orden</Label>
                <Input id="v-orden" type="number" min="0" max="999" value={form.sort}
                  onChange={e => setForm(f => ({ ...f, sort: e.target.value }))} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.active} onCheckedChange={v => setForm(f => ({ ...f, active: v === true }))} />
              Visible en la tienda
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Pestaña de Categorías ──
// Agrupan el catálogo en la mini app. Sin ellas el cliente ve una lista plana.
function CategoriesPanel() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Category | 'new' | null>(null)
  const { data: categories = [], isLoading, isError, refetch } =
    useQuery({ queryKey: ['categories'], queryFn: catApi.getCategories })

  const refresh = () => qc.invalidateQueries({ queryKey: ['categories'] })
  const mDelete = useMutation({
    mutationFn: catApi.deleteCategory,
    onSuccess: () => { refresh(); toast.success('Categoría eliminada') },
    onError: () => toast.error('No se pudo eliminar'),
  })

  if (isLoading) return <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-32 w-full" /></div>
  if (isError) return <QueryError onRetry={() => { void refetch() }} />

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Agrupan tu catálogo en la tienda. El <strong>orden</strong> decide cómo aparecen; el mismo número las ordena por nombre.
        </p>
        <Button onClick={() => setEditing('new')}>
          <span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Agregar categoría</span>
        </Button>
      </div>

      {categories.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">
          Aún no hay categorías. Sin ellas la tienda muestra todos los productos en una sola lista.
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {categories.map(c => (
          <Card key={c.id} className="flex-row items-center justify-between gap-2 p-3">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="text-xs text-muted-foreground tabular-nums w-6">{c.sort}</span>
              <span className="font-medium text-sm text-foreground">{c.name}</span>
              {c.description && <span className="text-xs text-muted-foreground truncate max-w-xs">{c.description}</span>}
              {!c.active && <Badge variant="secondary" className="text-[10px] px-1.5">oculta</Badge>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="outline" size="icon-sm" aria-label={`Editar ${c.name}`} onClick={() => setEditing(c)}><Pencil className="w-3.5 h-3.5" /></Button>
              <ConfirmAction
                trigger={<Button variant="outline" size="icon-sm" aria-label={`Eliminar ${c.name}`}><Trash2 className="w-3.5 h-3.5" /></Button>}
                title={`Eliminar "${c.name}"`}
                description="Los productos NO se borran: dejan de estar agrupados y aparecen sueltos en la tienda."
                confirmLabel="Eliminar"
                destructive
                onConfirm={() => mDelete.mutate(c.id)}
              />
            </div>
          </Card>
        ))}
      </div>

      {editing && (
        <CategoryModal
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
        />
      )}
    </div>
  )
}

function CategoryModal({ category, onClose, onSaved }: {
  category: Category | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: category?.name ?? '',
    description: category?.description ?? '',
    sort: String(category?.sort ?? 0),
    active: category?.active ?? true,
  })
  const [guardando, setGuardando] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Ponle un nombre a la categoría')
    setGuardando(true)
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        sort: Number(form.sort) || 0,
        active: form.active,
      }
      if (category) await catApi.updateCategory(category.id, payload)
      else await catApi.createCategory(payload)
      toast.success(category ? 'Categoría actualizada' : 'Categoría creada')
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{category ? 'Editar categoría' : 'Nueva categoría'}</DialogTitle>
            <DialogDescription>Así se agrupa tu catálogo en la tienda.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="c-nombre">Nombre</Label>
              <Input id="c-nombre" value={form.name} maxLength={60} placeholder="Pizzas"
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="c-desc">Descripción</Label>
              <Textarea id="c-desc" value={form.description} maxLength={300} rows={2}
                placeholder="opcional — se muestra bajo el nombre"
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="c-orden">Orden</Label>
              <Input id="c-orden" type="number" min="0" max="999" value={form.sort}
                onChange={e => setForm(f => ({ ...f, sort: e.target.value }))} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.active} onCheckedChange={v => setForm(f => ({ ...f, active: v === true }))} />
              Visible en la tienda
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
