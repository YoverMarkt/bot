import { useRef, useState } from 'react'
import { AlertTriangle, Camera, Loader2, Plus, Trash2 } from 'lucide-react'
import * as adm from './api'
import {
  contarProductos, desdePropuesta, nuevaClave, preciosQueFaltan, leerPrecio,
  type CartaEnRevision, type CategoriaEnRevision, type ProductoEnRevision,
} from './carta'
import { Alert, AlertDescription, AlertTitle } from '@botpanel/ui/components/alert'
import { Button } from '@botpanel/ui/components/button'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Textarea } from '@botpanel/ui/components/textarea'

// ═══════════════════════════════════════════════════════════════════════════
// LA CARTA DEL LOCAL, AL DARLO DE ALTA
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño de Umbani sube la foto de la carta, la IA propone y él la revisa
// aquí antes de crear el local. Lo revisado ocupa el lugar de los productos de
// ejemplo del tipo: «lo mejor, al momento de dar de alta un local».
//
// ⚠️ La IA lee lo IMPRESO. Las reglas que la carta no dice —qué parte del
// plato se vende suelta, qué va gratis— se ponen después en el panel del
// local. Por eso aquí solo se revisa lo que se ve en la foto.

const MAXIMO_DE_FOTOS = 4

export default function CartaDelLocal({
  carta,
  onCambio,
}: {
  carta: CartaEnRevision | null
  onCambio: (carta: CartaEnRevision | null) => void
}) {
  const selector = useRef<HTMLInputElement>(null)
  const [leyendo, setLeyendo] = useState(false)
  const [error, setError] = useState('')

  const leer = async (lista: FileList | null) => {
    const fotos = Array.from(lista || [])
    if (selector.current) selector.current.value = ''
    if (!fotos.length) return
    if (fotos.length > MAXIMO_DE_FOTOS) {
      setError(`Como mucho ${MAXIMO_DE_FOTOS} fotos por carta`)
      return
    }
    setError('')
    setLeyendo(true)
    try {
      onCambio(desdePropuesta(await adm.leerCarta(fotos)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo leer la carta')
    } finally {
      setLeyendo(false)
    }
  }

  // ── Cambios sobre el borrador (siempre copias: es estado de React) ──────
  const enCategoria = (id: string, cambio: (c: CategoriaEnRevision) => CategoriaEnRevision | null) => {
    if (!carta) return
    onCambio({
      ...carta,
      categorias: carta.categorias.flatMap((categoria) => {
        if (categoria.id !== id) return [categoria]
        const nueva = cambio(categoria)
        return nueva ? [nueva] : []
      }),
    })
  }
  const enProducto = (
    categoriaId: string,
    productoId: string,
    cambio: (p: ProductoEnRevision) => ProductoEnRevision | null,
  ) => enCategoria(categoriaId, categoria => ({
    ...categoria,
    productos: categoria.productos.flatMap((producto) => {
      if (producto.id !== productoId) return [producto]
      const nuevo = cambio(producto)
      return nuevo ? [nuevo] : []
    }),
  }))

  const faltan = carta ? preciosQueFaltan(carta) : []
  const productos = carta ? contarProductos(carta) : 0

  return (
    <div className="mb-4 rounded-lg border border-border/70 p-3">
      <h3 className="text-sm font-semibold">Carta del local (opcional)</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Sube la foto de la carta y la IA propone los productos. Revísalos antes de
        crear el negocio: se guardan tal cual y ocupan el lugar de los productos de
        ejemplo. Lo que la carta no dice (qué va gratis, qué se vende suelto) se
        ajusta después en el panel del local.
      </p>

      <input
        ref={selector}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={e => void leer(e.target.files)}
      />

      {!carta && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            disabled={leyendo}
            onClick={() => selector.current?.click()}
          >
            {leyendo
              ? <><Loader2 className="animate-spin" /> Leyendo la carta…</>
              : <><Camera /> Subir fotos de la carta</>}
          </Button>
          <p className="text-xs text-muted-foreground">
            Hasta {MAXIMO_DE_FOTOS} fotos (JPG, PNG o WEBP). Si la carta tiene varias
            páginas, súbelas juntas.
          </p>
          {leyendo && (
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-4/5" />
              <Skeleton className="h-9 w-3/5" />
            </div>
          )}
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="mt-2">
          <AlertTriangle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {carta && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              <strong>{productos}</strong> producto{productos === 1 ? '' : 's'} en{' '}
              {carta.categorias.length} categoría{carta.categorias.length === 1 ? '' : 's'}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => onCambio(null)}>
              <Trash2 /> Quitar la carta
            </Button>
          </div>

          {carta.otrosPrecios.length > 0 && (
            <Alert>
              <AlertTriangle className="text-amber-600 dark:text-amber-400" />
              <AlertTitle>La carta trae otros precios</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {carta.otrosPrecios.map((otro, i) => (
                    <li key={i}>«{otro.texto}»{otro.producto ? ` (${otro.producto})` : ''}</li>
                  ))}
                </ul>
                No se usan: el precio de cada producto es el que pongas abajo.
              </AlertDescription>
            </Alert>
          )}

          {faltan.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>
                Falta{faltan.length === 1 ? '' : 'n'} {faltan.length} precio{faltan.length === 1 ? '' : 's'}
              </AlertTitle>
              <AlertDescription>
                La IA no los leyó con claridad. Escríbelos antes de crear el negocio:{' '}
                {faltan.slice(0, 4).join(' · ')}{faltan.length > 4 ? '…' : ''}
              </AlertDescription>
            </Alert>
          )}

          {carta.categorias.map(categoria => (
            <div key={categoria.id} className="space-y-2 rounded-md border border-border/70 p-2">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Nombre de la categoría"
                  className="font-semibold"
                  value={categoria.nombre}
                  onChange={e => enCategoria(categoria.id, c => ({ ...c, nombre: e.target.value }))}
                />
                <Button
                  type="button" variant="ghost" size="icon-sm"
                  aria-label={`Quitar la categoría ${categoria.nombre}`}
                  onClick={() => enCategoria(categoria.id, () => null)}
                >
                  <Trash2 />
                </Button>
              </div>

              {categoria.productos.map(producto => (
                <ProductoEnLaCarta
                  key={producto.id}
                  producto={producto}
                  onCambio={cambio => enProducto(categoria.id, producto.id, cambio)}
                />
              ))}

              <Button
                type="button" variant="ghost" size="sm"
                onClick={() => enCategoria(categoria.id, c => ({
                  ...c,
                  productos: [...c.productos, {
                    id: nuevaClave(), nombre: '', precio: '', descripcion: '', variantes: [], listas: [],
                  }],
                }))}
              >
                <Plus /> Añadir producto
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProductoEnLaCarta({
  producto,
  onCambio,
}: {
  producto: ProductoEnRevision
  onCambio: (cambio: (p: ProductoEnRevision) => ProductoEnRevision | null) => void
}) {
  const conTamanos = producto.variantes.length > 0
  const precioVacio = !conTamanos && leerPrecio(producto.precio) === null

  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Nombre del producto"
          placeholder="Nombre del producto"
          value={producto.nombre}
          onChange={e => onCambio(p => ({ ...p, nombre: e.target.value }))}
        />
        {conTamanos ? (
          <span className="w-28 shrink-0 text-xs text-muted-foreground">Precio por tamaño</span>
        ) : (
          <Input
            aria-label={`Precio de ${producto.nombre || 'este producto'}`}
            aria-invalid={precioVacio || undefined}
            inputMode="decimal"
            placeholder="0,00"
            className="w-28 shrink-0"
            value={producto.precio}
            onChange={e => onCambio(p => ({ ...p, precio: e.target.value }))}
          />
        )}
        <Button
          type="button" variant="ghost" size="icon-sm"
          aria-label={`Quitar ${producto.nombre || 'este producto'}`}
          onClick={() => onCambio(() => null)}
        >
          <Trash2 />
        </Button>
      </div>

      {conTamanos && (
        <div className="space-y-1.5 pl-3">
          {producto.variantes.map(variante => (
            <div key={variante.id} className="flex items-center gap-2">
              <Input
                aria-label="Nombre del tamaño"
                value={variante.nombre}
                onChange={e => onCambio(p => ({
                  ...p,
                  variantes: p.variantes.map(v => v.id === variante.id ? { ...v, nombre: e.target.value } : v),
                }))}
              />
              <Input
                aria-label={`Precio del tamaño ${variante.nombre}`}
                aria-invalid={leerPrecio(variante.precio) === null || undefined}
                inputMode="decimal"
                placeholder="0,00"
                className="w-28 shrink-0"
                value={variante.precio}
                onChange={e => onCambio(p => ({
                  ...p,
                  variantes: p.variantes.map(v => v.id === variante.id ? { ...v, precio: e.target.value } : v),
                }))}
              />
              <Button
                type="button" variant="ghost" size="icon-sm"
                aria-label={`Quitar el tamaño ${variante.nombre}`}
                onClick={() => onCambio(p => ({ ...p, variantes: p.variantes.filter(v => v.id !== variante.id) }))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}

      {producto.listas.map(lista => (
        <div key={lista.id} className="space-y-1.5 rounded-md border border-border/60 bg-background p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Título de la lista"
              className="min-w-0 flex-1"
              value={lista.titulo}
              onChange={e => onCambio(p => ({
                ...p,
                listas: p.listas.map(l => l.id === lista.id ? { ...l, titulo: e.target.value } : l),
              }))}
            />
            <Label htmlFor={`${lista.id}-obligatoria`} className="mb-0 flex items-center gap-1.5 text-xs">
              <Checkbox
                id={`${lista.id}-obligatoria`}
                checked={lista.obligatoria}
                onCheckedChange={marcado => onCambio(p => ({
                  ...p,
                  listas: p.listas.map(l => l.id === lista.id ? { ...l, obligatoria: marcado === true } : l),
                }))}
              />
              Obligatoria
            </Label>
            <Button
              type="button" variant="ghost" size="icon-sm"
              aria-label={`Quitar la lista ${lista.titulo}`}
              onClick={() => onCambio(p => ({ ...p, listas: p.listas.filter(l => l.id !== lista.id) }))}
            >
              <Trash2 />
            </Button>
          </div>
          <Textarea
            aria-label={`Opciones de ${lista.titulo || 'la lista'}, una por línea`}
            rows={Math.min(8, Math.max(2, lista.opciones.split('\n').length))}
            value={lista.opciones}
            onChange={e => onCambio(p => ({
              ...p,
              listas: p.listas.map(l => l.id === lista.id ? { ...l, opciones: e.target.value } : l),
            }))}
          />
          <p className="text-[11px] text-muted-foreground">
            Una opción por línea. El cliente elige una{lista.obligatoria ? '' : ' si quiere'}.
          </p>
        </div>
      ))}
    </div>
  )
}
