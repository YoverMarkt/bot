import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Textarea } from '@botpanel/ui/components/textarea'
import { Label } from '@botpanel/ui/components/label'
import { Badge } from '@botpanel/ui/components/badge'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@botpanel/ui/components/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@botpanel/ui/components/dialog'
import * as catApi from './api'
import type {
  Category, OptionGroup, OptionGroupPayload, OptionTemplate, PricingStrategy,
  Product, ProductOption, RecommendationPayload, SelectionType,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════
// EL CONSTRUCTOR DE OPCIONES
// ═══════════════════════════════════════════════════════════════════════════
//
// Aquí el dueño arma cómo se personaliza cada plato: el término de la carne,
// los ingredientes que se quitan, los cortes de una parrillada, la bebida
// incluida de un combo.
//
// Todo lo que se configure aquí sale EN LA MINI APP sin tocar código. Esa es
// la promesa entera del motor: la diferencia entre una pizzería y una
// heladería es la configuración, no un componente distinto.
//
// Hasta ahora esto solo se podía cargar con una plantilla al crear el negocio
// o escribiendo SQL a mano.

const TIPOS: { value: SelectionType; label: string; ayuda: string }[] = [
  { value: 'single', label: 'Elegir uno', ayuda: 'Un círculo. Tamaño, término, masa.' },
  { value: 'multiple', label: 'Elegir varios', ayuda: 'Casillas con tope. Salsas, ingredientes.' },
  { value: 'quantity', label: 'Por cantidad', ayuda: 'Un contador por opción. Cortes, bolas de helado.' },
]

const ESTRATEGIAS: { value: PricingStrategy; label: string; ayuda: string }[] = [
  { value: 'sum', label: 'Suma cada opción', ayuda: 'Lo normal: cada extra suma su recargo.' },
  { value: 'highest_selected', label: 'Cobra la más cara', ayuda: 'Mitad y mitad: media Suprema y media Hawaiana cuestan lo que la Suprema.' },
  { value: 'lowest_selected', label: 'Cobra la más barata', ayuda: 'Lo contrario: manda la opción de menor precio.' },
  { value: 'average', label: 'Cobra el promedio', ayuda: 'El promedio de lo elegido.' },
  { value: 'included', label: 'Todo incluido', ayuda: 'No suma nada aunque las opciones tengan precio.' },
  { value: 'included_up_to_limit', label: 'Las primeras van incluidas', ayuda: 'Las primeras N sin recargo; a partir de ahí, suman.' },
  { value: 'extra_after_limit', label: 'Cobra a partir del límite', ayuda: 'Igual, con el límite que definas abajo.' },
  { value: 'fixed', label: 'No altera el precio', ayuda: 'El grupo es informativo.' },
]

const grupoNuevo = (): OptionGroupPayload => ({
  product_id: null,
  category_id: null,
  name: '',
  description: null,
  selection_type: 'single',
  required: false,
  min_selectable: 0,
  max_selectable: 1,
  max_total_quantity: null,
  pricing_strategy: 'sum',
  free_selections: 0,
  option_template_id: null,
  sort: 0,
  active: true,
})

const adicionalVacio = (): RecommendationPayload => ({
  source_product_id: null,
  source_category_id: null,
  recommended_product_id: '',
  section: 'Agrega algo más',
  sort: 0,
  active: true,
})

const opcionNueva = (groupId: string): Omit<ProductOption, 'id'> => ({
  option_group_id: groupId,
  name: '',
  description: null,
  image_url: null,
  image_public_id: null,
  price_adjustment: 0,
  references_product_id: null,
  default_selected: false,
  stock: 'disponible',
  sort: 0,
  active: true,
})

/** El resumen que el dueño lee de un vistazo, en las mismas palabras que verá el cliente. */
function resumen(grupo: OptionGroup): string {
  const minimo = Math.max(grupo.required ? 1 : 0, grupo.min_selectable)
  if (grupo.selection_type === 'quantity') {
    return minimo > 0
      ? `Reparte ${minimo === grupo.max_selectable ? minimo : `de ${minimo} a ${grupo.max_selectable}`} porciones`
      : `Hasta ${grupo.max_selectable} porciones`
  }
  if (grupo.selection_type === 'single') return minimo > 0 ? 'Elige 1' : 'Puede elegir 1'
  if (minimo > 0 && minimo === grupo.max_selectable) return `Elige exactamente ${minimo}`
  if (minimo > 0) return `Elige entre ${minimo} y ${grupo.max_selectable}`
  return `Hasta ${grupo.max_selectable}`
}

const money = (valor: string | number) => {
  const n = Number(valor) || 0
  if (n === 0) return 'sin recargo'
  return `${n > 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`
}

export default function OptionsManager({
  productos, categorias,
}: {
  productos: Product[]
  categorias: Category[]
}) {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState<Record<string, boolean>>({})
  const [editandoGrupo, setEditandoGrupo] = useState<
    { grupo: OptionGroupPayload; id: string | null } | null
  >(null)
  const [editandoOpcion, setEditandoOpcion] = useState<
    { opcion: Omit<ProductOption, 'id'>; id: string | null } | null
  >(null)
  const [plantillaNueva, setPlantillaNueva] = useState<{ name: string } | null>(null)
  const [adicionalNuevo, setAdicionalNuevo] = useState<RecommendationPayload | null>(null)

  const grupos = useQuery({ queryKey: ['option-groups'], queryFn: catApi.getOptionGroups })
  const opciones = useQuery({ queryKey: ['options'], queryFn: catApi.getOptions })
  const plantillas = useQuery({ queryKey: ['option-templates'], queryFn: catApi.getOptionTemplates })
  const adicionales = useQuery({ queryKey: ['recommendations'], queryFn: catApi.getRecommendations })

  const refrescar = () => {
    void qc.invalidateQueries({ queryKey: ['option-groups'] })
    void qc.invalidateQueries({ queryKey: ['options'] })
    void qc.invalidateQueries({ queryKey: ['option-templates'] })
    void qc.invalidateQueries({ queryKey: ['recommendations'] })
  }

  const alFallar = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : 'No se pudo guardar')
  }

  const guardarGrupo = useMutation({
    mutationFn: ({ grupo, id }: { grupo: OptionGroupPayload; id: string | null }) => (
      id ? catApi.updateOptionGroup(id, grupo) : catApi.createOptionGroup(grupo)
    ),
    onSuccess: () => {
      toast.success('Grupo guardado')
      setEditandoGrupo(null)
      refrescar()
    },
    onError: alFallar,
  })

  const borrarGrupo = useMutation({
    mutationFn: catApi.deleteOptionGroup,
    onSuccess: () => { toast.success('Grupo eliminado'); refrescar() },
    onError: alFallar,
  })

  const guardarOpcion = useMutation({
    mutationFn: ({ opcion, id }: { opcion: Omit<ProductOption, 'id'>; id: string | null }) => (
      id ? catApi.updateOption(id, opcion) : catApi.createOption(opcion)
    ),
    onSuccess: () => {
      toast.success('Opción guardada')
      setEditandoOpcion(null)
      refrescar()
    },
    onError: alFallar,
  })

  const borrarOpcion = useMutation({
    mutationFn: catApi.deleteOption,
    onSuccess: () => { toast.success('Opción eliminada'); refrescar() },
    onError: alFallar,
  })

  const crearPlantilla = useMutation({
    mutationFn: (nombre: string) => catApi.createOptionTemplate({ name: nombre, description: null }),
    onSuccess: () => { toast.success('Plantilla creada'); setPlantillaNueva(null); refrescar() },
    onError: alFallar,
  })

  const borrarPlantilla = useMutation({
    mutationFn: catApi.deleteOptionTemplate,
    onSuccess: () => { toast.success('Plantilla eliminada'); refrescar() },
    onError: alFallar,
  })

  const crearAdicional = useMutation({
    mutationFn: catApi.createRecommendation,
    onSuccess: () => { toast.success('Adicional guardado'); setAdicionalNuevo(null); refrescar() },
    onError: alFallar,
  })

  const borrarAdicional = useMutation({
    mutationFn: catApi.deleteRecommendation,
    onSuccess: () => { toast.success('Adicional eliminado'); refrescar() },
    onError: alFallar,
  })

  const opcionesPorGrupo = useMemo(() => {
    const mapa = new Map<string, ProductOption[]>()
    for (const opcion of opciones.data || []) {
      mapa.set(opcion.option_group_id, [...mapa.get(opcion.option_group_id) || [], opcion])
    }
    return mapa
  }, [opciones.data])

  /** Dónde cuelga cada grupo, dicho como lo entiende el dueño. */
  const dondeCuelga = (grupo: OptionGroup): string => {
    if (grupo.product_id) {
      return productos.find(p => p.id === grupo.product_id)?.name || 'Producto eliminado'
    }
    if (grupo.category_id) {
      const nombre = categorias.find(c => c.id === grupo.category_id)?.name
      return nombre ? `Toda la categoría ${nombre}` : 'Categoría eliminada'
    }
    return 'Sin asignar'
  }

  if (grupos.isLoading || opciones.isLoading) {
    return <div className="space-y-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full" />)}</div>
  }
  if (grupos.error) return <QueryError onRetry={() => void grupos.refetch()} />

  const lista = grupos.data || []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Grupos de opciones</h3>
          <p className="text-sm text-muted-foreground">
            Cómo se personaliza cada plato. Todo lo que configures aquí aparece en tu mini app.
          </p>
        </div>
        <Button onClick={() => setEditandoGrupo({ grupo: grupoNuevo(), id: null })}>
          <Plus className="mr-1.5 size-4" /> Nuevo grupo
        </Button>
      </div>

      {!lista.length && (
        <Card className="p-8 text-center">
          <Layers className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">Todavía no hay grupos de opciones</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Un grupo es «elige el tamaño», «agrega extras» o «retira ingredientes».
            Cuélgalo de un producto concreto o de una categoría entera.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {lista.map((grupo) => {
          const suyas = opcionesPorGrupo.get(grupo.id) || []
          const desplegado = abierto[grupo.id]
          return (
            <Card key={grupo.id} className="overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                <button
                  type="button"
                  onClick={() => setAbierto({ ...abierto, [grupo.id]: !desplegado })}
                  className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                >
                  {desplegado
                    ? <ChevronDown className="mt-0.5 size-4 shrink-0" />
                    : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{grupo.name}</span>
                      {grupo.required && <Badge variant="default">Obligatorio</Badge>}
                      {!grupo.active && <Badge variant="outline">Inactivo</Badge>}
                      {grupo.pricing_strategy === 'highest_selected' && (
                        <Badge variant="secondary">Cobra la más cara</Badge>
                      )}
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {dondeCuelga(grupo)} · {resumen(grupo)} · {suyas.length} opciones
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setEditandoGrupo({ grupo: { ...grupo }, id: grupo.id })}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <ConfirmAction
                    title="¿Eliminar este grupo?"
                    description="Se borran también todas sus opciones. Los pedidos ya hechos no cambian."
                    destructive
                    onConfirm={() => borrarGrupo.mutate(grupo.id)}
                    trigger={
                      <Button variant="ghost" size="sm"><Trash2 className="size-4" /></Button>
                    }
                  />
                </div>
              </div>

              {desplegado && (
                <div className="border-t bg-muted/30 p-4">
                  <div className="space-y-2">
                    {suyas.map(opcion => (
                      <div
                        key={opcion.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{opcion.name}</span>
                          {opcion.default_selected && (
                            <Badge variant="outline" className="ml-2">Por defecto</Badge>
                          )}
                          {opcion.stock === 'agotado' && (
                            <Badge variant="outline" className="ml-2">Agotado</Badge>
                          )}
                        </span>
                        <span className="text-sm font-semibold">
                          {money(opcion.price_adjustment)}
                        </span>
                        <span className="flex gap-1">
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => setEditandoOpcion({
                              opcion: { ...opcion }, id: opcion.id,
                            })}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <ConfirmAction
                            title="¿Eliminar esta opción?"
                            description="Desaparece de la mini app. Los pedidos ya hechos no cambian."
                            destructive
                            onConfirm={() => borrarOpcion.mutate(opcion.id)}
                            trigger={
                              <Button variant="ghost" size="sm"><Trash2 className="size-3.5" /></Button>
                            }
                          />
                        </span>
                      </div>
                    ))}
                    {!suyas.length && (
                      <p className="py-2 text-sm text-muted-foreground">
                        Este grupo aún no tiene opciones.
                        {grupo.required && ' Es obligatorio, así que sin opciones el producto no se podrá pedir.'}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline" size="sm" className="mt-3"
                    onClick={() => setEditandoOpcion({ opcion: opcionNueva(grupo.id), id: null })}
                  >
                    <Plus className="mr-1.5 size-3.5" /> Agregar opción
                  </Button>
                </div>
              )}
            </Card>
          )
        })}
      </div>

      {/* ── Plantillas ───────────────────────────────────────────────── */}
      <div className="border-t pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Plantillas reutilizables</h3>
            <p className="text-sm text-muted-foreground">
              Una lista que se usa en varios sitios. Defines «Sabores» una vez y sirve para la
              primera pizza, la segunda y las dos mitades: al añadir un sabor, aparece en todas.
            </p>
          </div>
          <Button variant="outline" onClick={() => setPlantillaNueva({ name: '' })}>
            <Plus className="mr-1.5 size-4" /> Nueva plantilla
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {(plantillas.data || []).map(plantilla => (
            <Card key={plantilla.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <span>
                <span className="font-medium">{plantilla.name}</span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {plantilla.used_by_groups
                    ? `usada en ${plantilla.used_by_groups} grupo${plantilla.used_by_groups > 1 ? 's' : ''}`
                    : 'sin usar todavía'}
                </span>
              </span>
              <ConfirmAction
                title="¿Eliminar esta plantilla?"
                description={plantilla.used_by_groups
                  ? `La usan ${plantilla.used_by_groups} grupos. Se quedarán sin ella, pero seguirán funcionando con sus propias opciones.`
                  : 'No la usa ningún grupo.'}
                destructive
                onConfirm={() => borrarPlantilla.mutate(plantilla.id)}
                trigger={
                  <Button variant="ghost" size="sm"><Trash2 className="size-4" /></Button>
                }
              />
            </Card>
          ))}
          {!(plantillas.data || []).length && (
            <p className="text-sm text-muted-foreground">Todavía no hay plantillas.</p>
          )}
        </div>
      </div>

      {/* ── Adicionales ──────────────────────────────────────────────── */}
      <div className="border-t pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Agrega algo más</h3>
            <p className="text-sm text-muted-foreground">
              Otros productos que se ofrecen junto a este. <strong>No</strong> son opciones del
              plato: entran al carrito por su cuenta, como algo más que preparar.
            </p>
          </div>
          <Button variant="outline" onClick={() => setAdicionalNuevo(adicionalVacio())}>
            <Plus className="mr-1.5 size-4" /> Nuevo adicional
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {(adicionales.data || []).map((reco) => {
            const ofrecido = productos.find(p => p.id === reco.recommended_product_id)
            const desde = reco.source_product_id
              ? productos.find(p => p.id === reco.source_product_id)?.name
              : reco.source_category_id
                ? `la categoría ${categorias.find(c => c.id === reco.source_category_id)?.name || '—'}`
                : 'todo el catálogo'
            return (
              <Card key={reco.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="min-w-0">
                  <span className="font-medium">{ofrecido?.name || 'Producto eliminado'}</span>
                  <span className="ml-2 text-sm text-muted-foreground">
                    en «{reco.section}», desde {desde}
                  </span>
                </span>
                <ConfirmAction
                  title="¿Quitar este adicional?"
                  description="Deja de ofrecerse. El producto sigue en tu catálogo."
                  destructive
                  onConfirm={() => borrarAdicional.mutate(reco.id)}
                  trigger={<Button variant="ghost" size="sm"><Trash2 className="size-4" /></Button>}
                />
              </Card>
            )
          })}
          {!(adicionales.data || []).length && (
            <p className="text-sm text-muted-foreground">Todavía no ofreces nada además.</p>
          )}
        </div>
      </div>

      <Dialog
        open={Boolean(adicionalNuevo)}
        onOpenChange={abierta => !abierta && setAdicionalNuevo(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nuevo adicional</DialogTitle>
            <DialogDescription>
              Aparece en la ficha del producto con un «+». Al tocarlo, entra al carrito
              como una línea aparte.
            </DialogDescription>
          </DialogHeader>

          {adicionalNuevo && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>¿Qué se ofrece?</Label>
                <Select
                  value={adicionalNuevo.recommended_product_id}
                  onValueChange={v => setAdicionalNuevo({
                    ...adicionalNuevo, recommended_product_id: v,
                  })}
                >
                  <SelectTrigger><SelectValue placeholder="Elige un producto" /></SelectTrigger>
                  <SelectContent>
                    {productos.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>¿Dónde se ofrece?</Label>
                <Select
                  value={adicionalNuevo.source_product_id
                    ? `p:${adicionalNuevo.source_product_id}`
                    : adicionalNuevo.source_category_id
                      ? `c:${adicionalNuevo.source_category_id}`
                      : 'todo'}
                  onValueChange={(valor) => {
                    const [tipo, id] = valor.split(':')
                    setAdicionalNuevo({
                      ...adicionalNuevo,
                      source_product_id: tipo === 'p' ? id : null,
                      source_category_id: tipo === 'c' ? id : null,
                    })
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">En todo el catálogo</SelectItem>
                    {categorias.map(c => (
                      <SelectItem key={`c:${c.id}`} value={`c:${c.id}`}>
                        En la categoría {c.name}
                      </SelectItem>
                    ))}
                    {productos.map(p => (
                      <SelectItem key={`p:${p.id}`} value={`p:${p.id}`}>Solo con {p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reco-seccion">Título de la sección</Label>
                <Input
                  id="reco-seccion"
                  value={adicionalNuevo.section}
                  onChange={e => setAdicionalNuevo({ ...adicionalNuevo, section: e.target.value })}
                  placeholder="Agrega bebidas"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAdicionalNuevo(null)}>Cancelar</Button>
            <Button
              disabled={!adicionalNuevo?.recommended_product_id || crearAdicional.isPending}
              onClick={() => adicionalNuevo && crearAdicional.mutate(adicionalNuevo)}
            >
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GrupoDialog
        estado={editandoGrupo}
        productos={productos}
        categorias={categorias}
        plantillas={plantillas.data || []}
        onCerrar={() => setEditandoGrupo(null)}
        onGuardar={valor => guardarGrupo.mutate(valor)}
        guardando={guardarGrupo.isPending}
      />

      <OpcionDialog
        estado={editandoOpcion}
        productos={productos}
        onCerrar={() => setEditandoOpcion(null)}
        onGuardar={valor => guardarOpcion.mutate(valor)}
        guardando={guardarOpcion.isPending}
      />

      <Dialog open={Boolean(plantillaNueva)} onOpenChange={abierta => !abierta && setPlantillaNueva(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nueva plantilla</DialogTitle>
            <DialogDescription>
              Por ejemplo «Sabores de pizza». Después le agregas sus opciones y la usas
              en todos los grupos que quieras.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="plantilla-nombre">Nombre</Label>
            <Input
              id="plantilla-nombre"
              value={plantillaNueva?.name || ''}
              onChange={e => setPlantillaNueva({ name: e.target.value })}
              placeholder="Sabores de pizza"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlantillaNueva(null)}>Cancelar</Button>
            <Button
              disabled={!plantillaNueva?.name.trim() || crearPlantilla.isPending}
              onClick={() => crearPlantilla.mutate(plantillaNueva!.name.trim())}
            >
              Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── El formulario del grupo ────────────────────────────────────────────────
//
// Las reglas se explican EN el formulario, no en un error después de guardar:
// «obligatorio» pone el mínimo en 1 solo, y «elegir uno» fija el máximo en 1.
// El servidor las vuelve a comprobar, pero aquí el dueño entiende por qué.

function GrupoDialog({
  estado, productos, categorias, plantillas, onCerrar, onGuardar, guardando,
}: {
  estado: { grupo: OptionGroupPayload; id: string | null } | null
  productos: Product[]
  categorias: Category[]
  plantillas: OptionTemplate[]
  onCerrar: () => void
  onGuardar: (valor: { grupo: OptionGroupPayload; id: string | null }) => void
  guardando: boolean
}) {
  const [borrador, setBorrador] = useState<OptionGroupPayload>(grupoNuevo())
  const [ultimo, setUltimo] = useState<string | null>(null)

  const clave = estado ? `${estado.id || 'nuevo'}` : null
  if (clave !== ultimo) {
    setUltimo(clave)
    if (estado) setBorrador({ ...estado.grupo })
  }

  if (!estado) return null

  const cambiar = (parcial: Partial<OptionGroupPayload>) => setBorrador({ ...borrador, ...parcial })

  const cambiarTipo = (tipo: SelectionType) => {
    // Un radio con máximo 5 obligaría a la app a decidir a quién cree.
    cambiar({ selection_type: tipo, max_selectable: tipo === 'single' ? 1 : borrador.max_selectable })
  }

  const cambiarObligatorio = (valor: boolean) => {
    // Un «obligatorio» con mínimo 0 no obliga a nada.
    cambiar({ required: valor, min_selectable: valor ? Math.max(1, borrador.min_selectable) : borrador.min_selectable })
  }

  const conLimite = borrador.pricing_strategy === 'included_up_to_limit'
    || borrador.pricing_strategy === 'extra_after_limit'
  const destino = borrador.product_id ? 'producto' : borrador.category_id ? 'categoria' : ''
  const listo = Boolean(borrador.name.trim()) && Boolean(destino)

  return (
    <Dialog open onOpenChange={abierta => !abierta && onCerrar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{estado.id ? 'Editar grupo' : 'Nuevo grupo de opciones'}</DialogTitle>
          <DialogDescription>
            Así se personaliza el plato en tu mini app.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="grupo-nombre">Nombre del grupo</Label>
            <Input
              id="grupo-nombre"
              value={borrador.name}
              onChange={e => cambiar({ name: e.target.value })}
              placeholder="Término de la carne"
            />
          </div>

          <div className="space-y-2">
            <Label>¿A qué se le aplica?</Label>
            <Select
              value={destino === 'producto' ? `p:${borrador.product_id}`
                : destino === 'categoria' ? `c:${borrador.category_id}` : ''}
              onValueChange={(valor) => {
                const [tipo, id] = valor.split(':')
                cambiar(tipo === 'p'
                  ? { product_id: id, category_id: null }
                  : { product_id: null, category_id: id })
              }}
            >
              <SelectTrigger><SelectValue placeholder="Elige un producto o una categoría" /></SelectTrigger>
              <SelectContent>
                {categorias.map(c => (
                  <SelectItem key={`c:${c.id}`} value={`c:${c.id}`}>
                    Toda la categoría {c.name}
                  </SelectItem>
                ))}
                {productos.map(p => (
                  <SelectItem key={`p:${p.id}`} value={`p:${p.id}`}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Por categoría lo heredan todos sus productos: así 19 sabores sirven para todas las
              pizzas sin repetirlos en cada una.
            </p>
          </div>

          <div className="space-y-2">
            <Label>¿Cómo elige el cliente?</Label>
            <Select value={borrador.selection_type} onValueChange={v => cambiarTipo(v as SelectionType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIPOS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {TIPOS.find(t => t.value === borrador.selection_type)?.ayuda}
            </p>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border p-3">
            <Checkbox
              id="grupo-obligatorio"
              checked={borrador.required}
              onCheckedChange={v => cambiarObligatorio(v === true)}
            />
            <div>
              <Label htmlFor="grupo-obligatorio">Es obligatorio</Label>
              <p className="text-xs text-muted-foreground">
                El cliente no podrá agregar el producto al carrito sin elegir aquí.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="grupo-min">Mínimo</Label>
              <Input
                id="grupo-min" type="number" min={borrador.required ? 1 : 0} max={100}
                value={borrador.min_selectable}
                onChange={e => cambiar({ min_selectable: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="grupo-max">Máximo</Label>
              <Input
                id="grupo-max" type="number" min={1} max={100}
                disabled={borrador.selection_type === 'single'}
                value={borrador.max_selectable}
                onChange={e => cambiar({ max_selectable: Number(e.target.value) })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            El cliente verá: <strong>{resumen({ ...borrador, id: '' } as OptionGroup)}</strong>
          </p>

          <div className="space-y-2">
            <Label>¿Cómo se cobra?</Label>
            <Select
              value={borrador.pricing_strategy}
              onValueChange={(v) => {
                const estrategia = v as PricingStrategy
                const necesitaLimite = estrategia === 'included_up_to_limit'
                  || estrategia === 'extra_after_limit'
                cambiar({
                  pricing_strategy: estrategia,
                  free_selections: necesitaLimite ? Math.max(1, borrador.free_selections) : 0,
                })
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ESTRATEGIAS.map(e => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {ESTRATEGIAS.find(e => e.value === borrador.pricing_strategy)?.ayuda}
            </p>
          </div>

          {conLimite && (
            <div className="space-y-2">
              <Label htmlFor="grupo-gratis">¿Cuántas van sin recargo?</Label>
              <Input
                id="grupo-gratis" type="number" min={1} max={100}
                value={borrador.free_selections}
                onChange={e => cambiar({ free_selections: Number(e.target.value) })}
              />
            </div>
          )}

          {plantillas.length > 0 && (
            <div className="space-y-2">
              <Label>Usar una plantilla (opcional)</Label>
              <Select
                value={borrador.option_template_id || 'ninguna'}
                onValueChange={v => cambiar({ option_template_id: v === 'ninguna' ? null : v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ninguna">Sin plantilla — opciones propias</SelectItem>
                  {plantillas.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="grupo-desc">Aclaración para el cliente (opcional)</Label>
            <Textarea
              id="grupo-desc" rows={2}
              value={borrador.description || ''}
              onChange={e => cambiar({ description: e.target.value || null })}
              placeholder="Elige cómo quieres tu carne"
            />
          </div>

          <div className="flex items-center gap-2.5">
            <Checkbox
              id="grupo-activo"
              checked={borrador.active}
              onCheckedChange={v => cambiar({ active: v === true })}
            />
            <Label htmlFor="grupo-activo">Visible en la mini app</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCerrar}>Cancelar</Button>
          <Button
            disabled={!listo || guardando}
            onClick={() => onGuardar({ grupo: borrador, id: estado.id })}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── El formulario de la opción ─────────────────────────────────────────────

function OpcionDialog({
  estado, productos, onCerrar, onGuardar, guardando,
}: {
  estado: { opcion: Omit<ProductOption, 'id'>; id: string | null } | null
  productos: Product[]
  onCerrar: () => void
  onGuardar: (valor: { opcion: Omit<ProductOption, 'id'>; id: string | null }) => void
  guardando: boolean
}) {
  const [borrador, setBorrador] = useState<Omit<ProductOption, 'id'> | null>(null)
  const [ultimo, setUltimo] = useState<string | null>(null)

  const clave = estado ? `${estado.id || 'nueva'}:${estado.opcion.option_group_id}` : null
  if (clave !== ultimo) {
    setUltimo(clave)
    if (estado) setBorrador({ ...estado.opcion })
  }

  if (!estado || !borrador) return null

  const cambiar = (parcial: Partial<ProductOption>) => setBorrador({ ...borrador, ...parcial })

  return (
    <Dialog open onOpenChange={abierta => !abierta && onCerrar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{estado.id ? 'Editar opción' : 'Nueva opción'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="opcion-nombre">Nombre</Label>
            <Input
              id="opcion-nombre"
              value={borrador.name}
              onChange={e => cambiar({ name: e.target.value })}
              placeholder="Bien cocida"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="opcion-precio">Recargo</Label>
            <Input
              id="opcion-precio" type="number" step="0.01"
              value={String(borrador.price_adjustment)}
              onChange={e => cambiar({ price_adjustment: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Cero si va incluida. Puede ser <strong>negativo</strong>: «sin sopa −0.50» descuenta
              del precio del plato.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Es este producto del catálogo (opcional)</Label>
            <Select
              value={borrador.references_product_id || 'ninguno'}
              onValueChange={v => cambiar({ references_product_id: v === 'ninguno' ? null : v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ninguno">No, es una opción suelta</SelectItem>
                {productos.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Así se arman los combos: «elige tu primera pizza» son opciones que apuntan a
              pizzas reales de tu catálogo.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="opcion-desc">Descripción (opcional)</Label>
            <Input
              id="opcion-desc"
              value={borrador.description || ''}
              onChange={e => cambiar({ description: e.target.value || null })}
            />
          </div>

          <div className="flex flex-wrap gap-5">
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="opcion-defecto"
                checked={borrador.default_selected}
                onCheckedChange={v => cambiar({ default_selected: v === true })}
              />
              <Label htmlFor="opcion-defecto">Viene marcada</Label>
            </div>
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="opcion-agotada"
                checked={borrador.stock === 'agotado'}
                onCheckedChange={v => cambiar({ stock: v === true ? 'agotado' : 'disponible' })}
              />
              <Label htmlFor="opcion-agotada">Agotada</Label>
            </div>
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="opcion-activa"
                checked={borrador.active}
                onCheckedChange={v => cambiar({ active: v === true })}
              />
              <Label htmlFor="opcion-activa">Visible</Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCerrar}>Cancelar</Button>
          <Button
            disabled={!borrador.name.trim() || guardando}
            onClick={() => onGuardar({ opcion: borrador, id: estado.id })}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
