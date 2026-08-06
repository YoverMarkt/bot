import { useMemo, useState } from 'react'
import { Boton, Contador, Foto, Hoja } from './ui'
import { money } from '../lib/format'
import {
  chosenCount,
  groupExtras,
  lineKey,
  missingRequirement,
  unitPrice,
} from '../lib/cart'
import type {
  CartLine,
  ChosenOption,
  Extra,
  OptionGroup,
  Product,
  Variant,
} from '../lib/types'

// Detalle del producto: variantes, grupos de opciones, extras, nota y cantidad.
//
// Los límites y los obligatorios se aplican AQUÍ y también en el servidor. Aquí
// para que se entienda —el grupo se bloquea al llegar al máximo y el botón dice
// qué falta—, y allá porque es lo único que de verdad manda.

/** Opciones que vienen marcadas de fábrica al abrir el producto. */
const opcionesPorDefecto = (groups: OptionGroup[]): ChosenOption[] => groups.flatMap(
  group => group.options
    .filter(opcion => opcion.defaultSelected)
    .slice(0, group.selectionType === 'single' ? 1 : group.maxSelectable)
    .map(opcion => ({
      groupId: group.id,
      groupName: group.name,
      optionId: opcion.id,
      name: opcion.name,
      price: opcion.price,
      quantity: 1,
    })),
)

export default function ProductSheet({ product, abierto, onCerrar, onAgregar, puedePedir }: {
  product: Product | null
  abierto: boolean
  onCerrar: () => void
  onAgregar: (linea: CartLine) => void
  puedePedir: boolean
}) {
  const [variante, setVariante] = useState<Variant | null>(null)
  const [extras, setExtras] = useState<Extra[]>([])
  const [opciones, setOpciones] = useState<ChosenOption[]>([])
  const [nota, setNota] = useState('')
  const [cantidad, setCantidad] = useState(1)

  // Al cambiar de producto se descarta lo elegido del anterior.
  const idActual = product?.id || ''
  const [ultimoId, setUltimoId] = useState(idActual)
  if (idActual !== ultimoId) {
    setUltimoId(idActual)
    setVariante(product?.variants[0] || null)
    setExtras([])
    setOpciones(opcionesPorDefecto(product?.optionGroups || []))
    setNota('')
    setCantidad(1)
  }

  const grupos = useMemo(() => groupExtras(product?.extras || []), [product])
  const gruposOpciones = product?.optionGroups || []
  // Un combo se arma eligiendo otros productos, así que sus grupos se pintan
  // como pasos. No se mira el tipo de comida: se mira si el producto se compone.
  const esCombo = product?.productType === 'combo' && gruposOpciones.length > 1
  const precio = product ? unitPrice(product, variante, extras, opciones) : 0
  const falta = missingRequirement(gruposOpciones, opciones)

  if (!product) return null

  // ── Los tres selectores ───────────────────────────────────────────────────

  /** `single`: un radio. Elegir sustituye lo que hubiera en el grupo. */
  const elegirUnica = (group: OptionGroup, opcion: ChosenOption) => {
    setOpciones([...opciones.filter(item => item.groupId !== group.id), opcion])
  }

  /** `multiple`: casillas. Se bloquea al llegar al tope del grupo. */
  const alternarOpcion = (group: OptionGroup, opcion: ChosenOption) => {
    const yaEsta = opciones.some(item => item.optionId === opcion.optionId)
    if (yaEsta) {
      return setOpciones(opciones.filter(item => item.optionId !== opcion.optionId))
    }
    if (chosenCount(group, opciones) >= group.maxSelectable) return
    setOpciones([...opciones, opcion])
  }

  /**
   * `quantity`: un contador por opción. El tope es del GRUPO y se cuenta en
   * porciones: en una parrillada de 4, subir el chorizo a 3 solo deja 1 para
   * repartir entre el resto.
   */
  const cambiarCantidadOpcion = (
    group: OptionGroup,
    opcion: ChosenOption,
    siguiente: number,
  ) => {
    const resto = opciones.filter(item => item.optionId !== opcion.optionId)
    if (siguiente <= 0) return setOpciones(resto)

    const usadoPorOtras = resto
      .filter(item => item.groupId === group.id)
      .reduce((suma, item) => suma + item.quantity, 0)
    const permitido = Math.max(0, group.maxSelectable - usadoPorOtras)
    if (permitido <= 0) return

    setOpciones([...resto, { ...opcion, quantity: Math.min(siguiente, permitido) }])
  }

  const alternarExtra = (extra: Extra) => {
    const elegido = extras.some(item => item.id === extra.id)
    if (elegido) return setExtras(extras.filter(item => item.id !== extra.id))
    // El máximo se cuenta por grupo, que es como lo entiende el cliente:
    // "hasta 2 salsas", no "hasta 2 cosas en total".
    const delGrupo = extras.filter(item => (item.group || 'Extras') === (extra.group || 'Extras'))
    const maximo = extra.maxSelectable
    if (maximo && delGrupo.length >= maximo) return
    setExtras([...extras, extra])
  }

  const agregar = () => {
    // Cinturón además del botón deshabilitado: si un obligatorio quedara sin
    // cumplir, el servidor rechazaría el pedido entero al confirmarlo, y el
    // cliente lo descubriría al final en vez de aquí.
    if (falta) return
    onAgregar({
      key: lineKey(product, variante, extras, nota, opciones),
      product,
      variant: variante,
      extras,
      options: opciones,
      quantity: cantidad,
      note: nota.trim(),
      unitPrice: precio,
    })
    onCerrar()
  }

  const faltaVariante = product.hasVariants && !variante

  const textoDelBoton = () => {
    if (!product.available) return 'Agotado'
    if (faltaVariante) return 'Elige una opción'
    if (falta) return falta.message
    return `Agregar · ${money(precio * cantidad)}`
  }

  return (
    <Hoja abierta={abierto} onCerrar={onCerrar} titulo={product.name}>
      <Foto url={product.imageUrl} alto="h-52" nombre={product.name} />

      <div className="space-y-6 p-4 pb-3">
        {product.description && (
          <p className="text-[14px] leading-relaxed texto-tenue">{product.description}</p>
        )}

        {product.variants.length > 0 && (
          <section>
            <h3 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
              Elige una opción
            </h3>
            <div className="space-y-2">
              {product.variants.map((opcion) => {
                const activa = variante?.id === opcion.id
                const oferta = opcion.priceSale != null && opcion.priceSale < opcion.price
                return (
                  <button
                    key={opcion.id}
                    onClick={() => setVariante(opcion)}
                    className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition ${
                      activa ? 'border-marca bg-marca-suave' : 'borde-tema'
                    }`}
                  >
                    <span className="text-[15px] font-semibold">{opcion.name}</span>
                    <span className="flex items-center gap-2 text-[15px] font-bold">
                      {oferta && (
                        <span className="text-[13px] font-medium line-through texto-tenue">
                          {money(opcion.price)}
                        </span>
                      )}
                      {money(opcion.priceSale ?? opcion.price)}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {gruposOpciones.map((group, indice) => {
          const elegidas = opciones.filter(item => item.groupId === group.id)
          const usado = chosenCount(group, opciones)
          const minimo = Math.max(group.required ? 1 : 0, group.minSelectable)
          const cumplido = usado >= minimo
          const lleno = usado >= group.maxSelectable

          return (
            <section key={group.id}>
              <h3 className="mb-2.5 flex items-baseline justify-between gap-3 text-[13px] font-bold tracking-wide uppercase texto-tenue">
                <span className="flex min-w-0 items-center gap-2">
                  {/* En un combo cada grupo es un PASO: «1 Elige tu primera
                      pizza», «2 Elige tu bebida». Sin el número, cinco bloques
                      seguidos parecen la misma lista repetida. */}
                  {esCombo && (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-marca text-[11px] leading-none font-black text-white">
                      {indice + 1}
                    </span>
                  )}
                  <span className="min-w-0 truncate">{group.name}</span>
                </span>
                {minimo > 0
                  ? (
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold normal-case ${
                        cumplido ? 'bg-marca-suave text-marca' : 'bg-marca text-white'
                      }`}
                      >
                        {cumplido ? '✓ Listo' : minimo > 1 ? `Elige ${minimo}` : 'Obligatorio'}
                      </span>
                    )
                  : group.maxSelectable > 1 && (
                    <span className="shrink-0 text-[11px] normal-case">
                      Hasta {group.maxSelectable}
                    </span>
                  )}
              </h3>
              {group.description && (
                <p className="mb-2 text-[12px] texto-tenue">{group.description}</p>
              )}

              <div className="space-y-2">
                {group.options.map((opcion) => {
                  const elegida = elegidas.find(item => item.optionId === opcion.id)
                  const seleccion: ChosenOption = {
                    groupId: group.id,
                    groupName: group.name,
                    optionId: opcion.id,
                    name: opcion.name,
                    price: opcion.price,
                    quantity: 1,
                  }
                  const activa = Boolean(elegida)
                  const bloqueada = !activa && lleno && group.selectionType !== 'single'

                  return (
                    <div
                      key={opcion.id}
                      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                        activa ? 'border-marca bg-marca-suave' : 'borde-tema'
                      } ${bloqueada ? 'opacity-40' : ''}`}
                    >
                      {group.selectionType === 'quantity'
                        ? (
                            <>
                              {opcion.imageUrl && (
                                <img
                                  src={opcion.imageUrl}
                                  alt=""
                                  loading="lazy"
                                  className="size-11 shrink-0 rounded-lg object-cover"
                                />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[14px] font-semibold">
                                  {opcion.name}
                                </span>
                                {opcion.description && (
                                  <span className="block truncate text-[12px] texto-tenue">
                                    {opcion.description}
                                  </span>
                                )}
                              </span>
                              {opcion.price !== 0 && (
                                <span className="shrink-0 text-[13px] font-bold">
                                  {opcion.price > 0 ? '+' : '−'}
                                  {money(Math.abs(opcion.price))}
                                </span>
                              )}
                              <Contador
                                valor={elegida?.quantity || 0}
                                onCambiar={valor => cambiarCantidadOpcion(group, seleccion, valor)}
                              />
                            </>
                          )
                        : (
                            <button
                              type="button"
                              onClick={() => (group.selectionType === 'single'
                                ? elegirUnica(group, seleccion)
                                : alternarOpcion(group, seleccion))}
                              disabled={bloqueada}
                              className="flex min-w-0 flex-1 items-center gap-3 text-left"
                            >
                              <span className={`flex size-5 shrink-0 items-center justify-center border-2 ${
                                // El radio se distingue del checkbox por la forma,
                                // que es como se entiende «uno solo» sin leer nada.
                                group.selectionType === 'single' ? 'rounded-full' : 'rounded-md'
                              } ${activa ? 'border-marca bg-marca text-white' : 'borde-tema'}`}
                              >
                                {activa && (
                                  <span className="text-[11px] leading-none font-black">✓</span>
                                )}
                              </span>
                              {/* Una opción que ES un producto trae su foto:
                                  eligiendo entre tres pizzas, el nombre solo no
                                  basta para decidir. */}
                              {opcion.imageUrl && (
                                <img
                                  src={opcion.imageUrl}
                                  alt=""
                                  loading="lazy"
                                  className="size-11 shrink-0 rounded-lg object-cover"
                                />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[14px] font-semibold">
                                  {opcion.name}
                                </span>
                                {opcion.description && (
                                  <span className="block truncate text-[12px] texto-tenue">
                                    {opcion.description}
                                  </span>
                                )}
                              </span>
                              {opcion.price !== 0 && (
                                <span className="shrink-0 text-[14px] font-bold">
                                  {opcion.price > 0 ? '+' : '−'}
                                  {money(Math.abs(opcion.price))}
                                </span>
                              )}
                            </button>
                          )}
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}

        {grupos.map(({ group, items }) => {
          const maximo = items[0]?.maxSelectable || null
          const elegidos = extras.filter(item => (item.group || 'Extras') === group).length
          return (
            <section key={group}>
              <h3 className="mb-2.5 flex items-baseline justify-between text-[13px] font-bold tracking-wide uppercase texto-tenue">
                {group}
                {maximo && <span className="text-[11px] normal-case">Hasta {maximo}</span>}
              </h3>
              <div className="space-y-2">
                {items.map((extra) => {
                  const activo = extras.some(item => item.id === extra.id)
                  const bloqueado = !activo && Boolean(maximo) && elegidos >= maximo!
                  return (
                    <button
                      key={extra.id}
                      onClick={() => alternarExtra(extra)}
                      disabled={bloqueado}
                      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                        activo ? 'border-marca bg-marca-suave' : 'borde-tema'
                      } ${bloqueado ? 'opacity-40' : ''}`}
                    >
                      <span className={`flex size-5 shrink-0 items-center justify-center rounded-md border-2 ${
                        activo ? 'border-marca bg-marca text-white' : 'borde-tema'
                      }`}
                      >
                        {activo && <span className="text-[11px] leading-none font-black">✓</span>}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-semibold">{extra.name}</span>
                        {extra.description && (
                          <span className="block truncate text-[12px] texto-tenue">{extra.description}</span>
                        )}
                      </span>
                      {extra.price > 0 && (
                        <span className="shrink-0 text-[14px] font-bold">+{money(extra.price)}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}

        <section>
          <h3 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            Nota para el negocio
          </h3>
          <textarea
            value={nota}
            onChange={event => setNota(event.target.value.slice(0, 200))}
            rows={2}
            placeholder="Ej: sin cebolla, bien cocido…"
            className="w-full resize-none rounded-xl border borde-tema bg-transparent px-3.5 py-3 text-[14px] outline-none focus:border-marca"
          />
        </section>
      </div>

      <div className="superficie sticky bottom-0 flex items-center gap-3 border-t borde-tema px-4 pt-3 pb-seguro">
        <Contador valor={cantidad} onCambiar={setCantidad} />
        <div className="flex-1">
          <Boton
            onClick={agregar}
            disabled={!puedePedir || faltaVariante || !product.available || Boolean(falta)}
          >
            {textoDelBoton()}
          </Boton>
        </div>
      </div>
    </Hoja>
  )
}
