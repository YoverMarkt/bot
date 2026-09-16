import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, UtensilsCrossed } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Badge } from '@botpanel/ui/components/badge'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import * as catApi from './api'
import type { OptionGroup, ProductOption } from './api'
import {
  etiquetaDePrecio, grupoDeAcompanantes, grupoDeParte, leerPrecio, opcionDelPlato,
  platoDelProducto, reglaDelPlato, siguienteOrden,
} from './plato-por-partes'

// ═══════════════════════════════════════════════════════════════════════════
// EL PLATO POR PARTES — el editor del dueño, dentro de la ficha del producto
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido del dueño del SaaS (2026-09-14): «que para todo local de menú pequeño
// sea fácil de armar lo que vendo: un almuerzo vale 3 dólares, y al pedirlo que
// me salga qué sopa quiero y qué segundo». Aquí se arma sin saber qué es un
// «grupo de opciones»: partes con su precio por separado, sus platos y lo que
// acompaña. La pestaña Personalización sigue siendo la gestión fina.
//
// ⚠️ Vive DENTRO del formulario del producto, así que todo botón es
// `type="button"` y Enter en un campo no envía el formulario: sin eso, agregar
// una sopa guardaba el producto y cerraba la ficha.
//
// ⚠️ Cada cambio se guarda al momento, como en Personalización. Un «guardar
// todo» al final perdería la lista entera si el dueño cierra la ficha.

const sinId = <T extends { id: string }>(fila: T): Omit<T, 'id'> => {
  const { id: _id, ...resto } = fila
  return resto
}

/** Enter agrega en vez de enviar el formulario del producto. */
const alPulsarEnter = (accion: () => void) => (evento: React.KeyboardEvent<HTMLInputElement>) => {
  if (evento.key !== 'Enter') return
  evento.preventDefault()
  accion()
}

export default function PlatoPorPartes({ productId, productName, precio }: {
  productId: string
  productName: string
  /** El precio del plato completo: el del producto. */
  precio: number
}) {
  const qc = useQueryClient()
  const grupos = useQuery({ queryKey: ['option-groups'], queryFn: catApi.getOptionGroups })
  const opciones = useQuery({ queryKey: ['options'], queryFn: catApi.getOptions })

  const plato = useMemo(
    () => platoDelProducto(grupos.data || [], opciones.data || [], productId),
    [grupos.data, opciones.data, productId],
  )
  const deEsteProducto = (grupos.data || []).filter(grupo => grupo.product_id === productId)

  const refrescar = () => {
    void qc.invalidateQueries({ queryKey: ['option-groups'] })
    void qc.invalidateQueries({ queryKey: ['options'] })
  }
  const alFallar = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : 'No se pudo guardar')
  }

  const crearGrupo = useMutation({
    mutationFn: catApi.createOptionGroup, onSuccess: refrescar, onError: alFallar,
  })
  const actualizarGrupo = useMutation({
    mutationFn: ({ grupo, cambios }: { grupo: OptionGroup; cambios: Partial<OptionGroup> }) =>
      catApi.updateOptionGroup(grupo.id, { ...sinId(grupo), ...cambios }),
    onSuccess: refrescar,
    onError: alFallar,
  })
  const borrarGrupo = useMutation({
    mutationFn: catApi.deleteOptionGroup, onSuccess: refrescar, onError: alFallar,
  })
  const crearOpcion = useMutation({
    mutationFn: catApi.createOption, onSuccess: refrescar, onError: alFallar,
  })
  const actualizarOpcion = useMutation({
    mutationFn: ({ opcion, cambios }: { opcion: ProductOption; cambios: Partial<ProductOption> }) =>
      catApi.updateOption(opcion.id, { ...sinId(opcion), ...cambios }),
    onSuccess: refrescar,
    onError: alFallar,
  })
  const borrarOpcion = useMutation({
    mutationFn: catApi.deleteOption, onSuccess: refrescar, onError: alFallar,
  })

  const ocupado = crearGrupo.isPending || crearOpcion.isPending

  if (grupos.isLoading || opciones.isLoading) {
    return <Skeleton className="mb-4 h-24 w-full" />
  }

  // ── Todavía no se arma por partes: se ofrece, con el ejemplo del oficio ──
  if (!plato.partes.length) {
    return (
      <div className="mb-4 rounded-lg border border-dashed p-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <UtensilsCrossed className="size-4" /> ¿Se arma por partes?
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Como un almuerzo: una sopa + un segundo. Tu cliente elige cuántas quiere de cada cosa, y
          una de cada parte es un plato completo al precio de este producto.
        </p>
        <Button
          type="button" variant="outline" size="sm" className="mt-2.5" disabled={ocupado}
          onClick={async () => {
            const orden = siguienteOrden(deEsteProducto)
            try {
              await crearGrupo.mutateAsync(grupoDeParte(productId, 'Sopa', orden))
              await crearGrupo.mutateAsync(grupoDeParte(productId, 'Segundo', orden + 1))
              toast.success('Listo: agrega tus sopas y tus segundos')
            } catch { /* el error ya se enseñó */ }
          }}
        >
          <Plus className="mr-1.5 size-4" /> Armarlo por partes
        </Button>
      </div>
    )
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg border p-3">
      <div>
        <p className="flex items-center gap-2 text-sm font-medium">
          <UtensilsCrossed className="size-4" /> Plato por partes
        </p>
        {/* La misma frase que lee el cliente arriba de la mesa. */}
        <p className="mt-1 text-xs text-muted-foreground">
          Tu cliente verá: <strong>{reglaDelPlato(plato, precio)}</strong>. Lo que sobre de una
          parte se cobra a su precio por separado.
        </p>
      </div>

      {plato.partes.map(({ grupo, opciones: platos }) => (
        <Parte
          key={grupo.id}
          grupo={grupo}
          platos={platos}
          productName={productName}
          ocupado={ocupado}
          onRenombrar={name => actualizarGrupo.mutate({ grupo, cambios: { name } })}
          onPrecioSuelto={loose_price => actualizarGrupo.mutate({ grupo, cambios: { loose_price } })}
          onAgregar={nombre => crearOpcion.mutate(opcionDelPlato(grupo.id, nombre, 0, siguienteOrden(platos)))}
          onAgotado={(opcion, agotado) => actualizarOpcion.mutate({
            opcion, cambios: { stock: agotado ? 'agotado' : 'disponible' },
          })}
          onQuitar={opcion => borrarOpcion.mutate(opcion.id)}
          onBorrarParte={() => borrarGrupo.mutate(grupo.id)}
        />
      ))}

      <Button
        type="button" variant="ghost" size="sm" disabled={ocupado}
        onClick={() => crearGrupo.mutate(grupoDeParte(productId, 'Postre', siguienteOrden(deEsteProducto)))}
      >
        <Plus className="mr-1.5 size-4" /> Agregar otra parte
      </Button>

      <Acompanantes
        grupo={plato.acompanantes?.grupo || null}
        items={plato.acompanantes?.opciones || []}
        ocupado={ocupado}
        onCrearGrupo={() => crearGrupo.mutate(grupoDeAcompanantes(productId, siguienteOrden(deEsteProducto)))}
        onAgregar={(groupId, nombre, valor) => crearOpcion.mutate(
          opcionDelPlato(groupId, nombre, valor, siguienteOrden(plato.acompanantes?.opciones || [])),
        )}
        onQuitar={opcion => borrarOpcion.mutate(opcion.id)}
      />
    </div>
  )
}

// ── Una parte: su nombre, su precio por separado y sus platos ──────────────

function Parte({
  grupo, platos, productName, ocupado, onRenombrar, onPrecioSuelto, onAgregar, onAgotado, onQuitar,
  onBorrarParte,
}: {
  grupo: OptionGroup
  platos: ProductOption[]
  productName: string
  ocupado: boolean
  onRenombrar: (nombre: string) => void
  onPrecioSuelto: (precio: number | null) => void
  onAgregar: (nombre: string) => void
  onAgotado: (opcion: ProductOption, agotado: boolean) => void
  onQuitar: (opcion: ProductOption) => void
  onBorrarParte: () => void
}) {
  const [nuevo, setNuevo] = useState('')
  const agregar = () => {
    if (!nuevo.trim()) return
    onAgregar(nuevo)
    setNuevo('')
  }

  return (
    <div className="rounded-md bg-muted/40 p-2.5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
        <div>
          <Label htmlFor={`parte-${grupo.id}`} className="text-xs">Parte</Label>
          {/* `key` con el nombre guardado: si el servidor lo corrige, el campo
              vuelve a leerlo en vez de quedarse con lo escrito. */}
          <Input
            key={`${grupo.id}:${grupo.name}`}
            id={`parte-${grupo.id}`}
            defaultValue={grupo.name}
            onKeyDown={alPulsarEnter(() => undefined)}
            onBlur={(evento) => {
              const nombre = evento.target.value.trim()
              if (nombre && nombre !== grupo.name) onRenombrar(nombre)
            }}
          />
        </div>
        <div>
          <Label htmlFor={`suelta-${grupo.id}`} className="text-xs">Por separado ($)</Label>
          <Input
            key={`${grupo.id}:${grupo.loose_price ?? ''}`}
            id={`suelta-${grupo.id}`}
            inputMode="decimal"
            placeholder="Solo en el plato"
            defaultValue={grupo.loose_price == null ? '' : String(grupo.loose_price)}
            onKeyDown={alPulsarEnter(() => undefined)}
            onBlur={(evento) => {
              const valor = leerPrecio(evento.target.value)
              if (valor === undefined || valor === 0) {
                toast.error('El precio por separado tiene que ser mayor que 0, o quedar vacío')
                return
              }
              if (valor !== (grupo.loose_price == null ? null : Number(grupo.loose_price))) {
                onPrecioSuelto(valor)
              }
            }}
          />
        </div>
        <ConfirmAction
          title={`¿Quitar «${grupo.name}» de ${productName}?`}
          description="Se borran también sus platos. Los pedidos ya hechos no cambian."
          destructive
          onConfirm={onBorrarParte}
          trigger={(
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Quitar la parte ${grupo.name}`}>
              <Trash2 className="size-4" />
            </Button>
          )}
        />
      </div>

      <ul className="mt-2 flex flex-wrap gap-1.5">
        {platos.map(opcion => (
          <li
            key={opcion.id}
            className="flex items-center gap-1 rounded-full border bg-background py-0.5 pr-0.5 pl-2.5 text-sm"
          >
            <span className={opcion.stock === 'agotado' ? 'text-muted-foreground line-through' : ''}>
              {opcion.name}
            </span>
            {/* Hoy se acabó el caldo: se marca, no se borra, y mañana vuelve. */}
            <Button
              type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]"
              onClick={() => onAgotado(opcion, opcion.stock !== 'agotado')}
            >
              {opcion.stock === 'agotado' ? 'Volver a ofrecer' : 'Agotado'}
            </Button>
            <Button
              type="button" variant="ghost" size="icon-sm" className="size-6"
              aria-label={`Quitar ${opcion.name}`}
              onClick={() => onQuitar(opcion)}
            >
              <Trash2 className="size-3" />
            </Button>
          </li>
        ))}
        {!platos.length && (
          <li className="text-xs text-muted-foreground">
            Sin platos todavía: sin ninguno, esta parte no se ofrece.
          </li>
        )}
      </ul>

      <div className="mt-2 flex gap-2">
        <Input
          aria-label={`Agregar a ${grupo.name}`}
          placeholder={`Agregar ${grupo.name.toLocaleLowerCase('es')}…`}
          value={nuevo}
          onChange={evento => setNuevo(evento.target.value)}
          onKeyDown={alPulsarEnter(agregar)}
        />
        <Button type="button" variant="outline" size="sm" disabled={ocupado || !nuevo.trim()} onClick={agregar}>
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  )
}

// ── Lo que acompaña: el jugo gratis, la porción de carne con su precio ─────

function Acompanantes({ grupo, items, ocupado, onCrearGrupo, onAgregar, onQuitar }: {
  grupo: OptionGroup | null
  items: ProductOption[]
  ocupado: boolean
  onCrearGrupo: () => void
  onAgregar: (groupId: string, nombre: string, precio: number) => void
  onQuitar: (opcion: ProductOption) => void
}) {
  const [nombre, setNombre] = useState('')
  const [precio, setPrecio] = useState('')

  if (!grupo) {
    return (
      <Button type="button" variant="ghost" size="sm" disabled={ocupado} onClick={onCrearGrupo}>
        <Plus className="mr-1.5 size-4" /> Agregar lo que acompaña (jugo, cocolón…)
      </Button>
    )
  }

  const agregar = () => {
    const valor = leerPrecio(precio)
    if (!nombre.trim()) return
    if (valor === undefined) {
      toast.error('Ese precio no se entiende. Déjalo vacío si va gratis.')
      return
    }
    onAgregar(grupo.id, nombre, valor ?? 0)
    setNombre('')
    setPrecio('')
  }

  return (
    <div className="rounded-md bg-muted/40 p-2.5">
      <p className="text-xs font-medium">{grupo.name}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map(opcion => (
          <li key={opcion.id} className="flex items-center gap-1.5 rounded-full border bg-background py-0.5 pr-0.5 pl-2.5 text-sm">
            {opcion.name}
            <Badge variant={Number(opcion.price_adjustment) > 0 ? 'secondary' : 'outline'}>
              {etiquetaDePrecio(opcion.price_adjustment)}
            </Badge>
            <Button
              type="button" variant="ghost" size="icon-sm" className="size-6"
              aria-label={`Quitar ${opcion.name}`}
              onClick={() => onQuitar(opcion)}
            >
              <Trash2 className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2 grid grid-cols-[1fr_6rem_auto] gap-2">
        <Input
          aria-label="Qué acompaña"
          placeholder="Jugo de mora"
          value={nombre}
          onChange={evento => setNombre(evento.target.value)}
          onKeyDown={alPulsarEnter(agregar)}
        />
        <Input
          aria-label="Precio de lo que acompaña"
          inputMode="decimal"
          placeholder="Gratis"
          value={precio}
          onChange={evento => setPrecio(evento.target.value)}
          onKeyDown={alPulsarEnter(agregar)}
        />
        <Button type="button" variant="outline" size="sm" disabled={ocupado || !nombre.trim()} onClick={agregar}>
          <Plus className="size-4" />
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Sin precio va gratis y no suma. Con precio, se cobra aparte.
      </p>
    </div>
  )
}
