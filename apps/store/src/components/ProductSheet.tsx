import { useMemo, useState } from 'react'
import { RiAddLine, RiCloseLine } from '@remixicon/react'
import { Boton, Contador, Foto, Hoja, LISTA, Marca, ROTULO } from './ui'
import { money } from '../lib/format'
import { foto } from '../lib/imagen'
import {
  chosenCount,
  groupExtras,
  lineKey,
  missingRequirement,
  optionPriceLabel,
  pillLayout,
  singleChoice,
  unitPrice,
} from '../lib/cart'
import type {
  CartLine,
  ChosenOption,
  Extra,
  OptionGroup,
  Product,
  Recommendation,
  Variant,
} from '../lib/types'

// Detalle del producto: variantes, grupos de opciones, extras, nota y cantidad.
//
// Los límites y los obligatorios se aplican AQUÍ y también en el servidor. Aquí
// para que se entienda —el grupo se bloquea al llegar al máximo y el botón dice
// qué falta—, y allá porque es lo único que de verdad manda.
//
// ── El acabado, rehecho el 2026-08-27 ─────────────────────────────────────
//
// La estructura de esta pantalla es de la pasada anterior a la referencia que
// el dueño aprobó para la portada. Se lleva al mismo lenguaje:
//
//  · **La foto manda y va A SANGRE**, como pide el apartado 3 del diseño. Con
//    la barra de título encima, la foto arrancaba a 57 px del borde y esto se
//    leía como un formulario con una imagen dentro. Ahora es el mismo héroe de
//    la portada, con el cerrar flotando encima.
//  · **PROPORCIÓN, no alto fijo.** Estaba en `h-52`: el mismo plato se
//    recortaba distinto en cada teléfono. Es el fallo que ya se corrigió en la
//    portada, aquí por la puerta de al lado.
//  · **Cada grupo es una TARJETA con sus filas divididas**, no una pila de
//    recuadros con marco. Es lo que hace que se lea como una app y no como un
//    formulario largo.
//  · **El relleno de los selectores va en `acento`**, no en `bg-marca` con el
//    icono forzado a blanco: sobre el lima de la plataforma un ✓ blanco
//    desaparece. Es la misma cara del fallo del color de letra —y la que NO
//    aparece buscando `text-marca`.

/** Opciones que vienen marcadas de fábrica al abrir el producto. */
const opcionesPorDefecto = (groups: OptionGroup[]): ChosenOption[] => groups.flatMap(
  group => group.options
    .filter(opcion => opcion.defaultSelected)
    .slice(0, singleChoice(group) ? 1 : group.maxSelectable)
    .map(opcion => ({
      groupId: group.id,
      groupName: group.name,
      optionId: opcion.id,
      name: opcion.name,
      price: opcion.price,
      quantity: 1,
    })),
)

export default function ProductSheet({
  product, abierto, onCerrar, onAgregar, onAgregarSuelto, puedePedir,
}: {
  product: Product | null
  abierto: boolean
  onCerrar: () => void
  onAgregar: (linea: CartLine) => void
  /**
   * Un adicional entra al carrito como LÍNEA PROPIA, no dentro de este plato.
   * Por eso va por otro camino que `onAgregar`: si acabara dentro, el dueño
   * vería «Pizza (con pan de ajo)» en vez de dos cosas que preparar.
   */
  onAgregarSuelto: (productId: string) => void
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

  // Los adicionales, por la sección que les puso el dueño y en su orden.
  const agrupadas = useMemo(() => {
    const mapa = new Map<string, Recommendation[]>()
    for (const reco of product?.recommendations || []) {
      mapa.set(reco.section, [...mapa.get(reco.section) || [], reco])
    }
    return [...mapa.entries()].map(([section, items]) => ({ section, items }))
  }, [product])

  if (!product) return null

  // ── Los tres selectores ───────────────────────────────────────────────────

  /**
   * `single`: un radio. Elegir sustituye lo que hubiera en el grupo.
   *
   * ⚠️ En un grupo OPCIONAL, volver a tocar lo ya elegido lo quita. Sin esto,
   * un «Borde mozzarella +$4.99» opcional no se podía deshacer: antes era una
   * casilla que se desmarcaba, y al pasar a radio el recargo se quedaba puesto
   * para siempre. En uno obligatorio no se permite —quedaría sin cumplir y el
   * botón volvería a decir qué falta—, así que ahí el toque no hace nada.
   */
  const elegirUnica = (group: OptionGroup, opcion: ChosenOption) => {
    const resto = opciones.filter(item => item.groupId !== group.id)
    const yaEstaba = opciones.some(item => item.optionId === opcion.optionId)
    const obligatorio = group.required || group.minSelectable > 0
    if (yaEstaba && !obligatorio) return setOpciones(resto)
    setOpciones([...resto, opcion])
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

  /** El precio de una opción: «Incluida», «+$1.50» o nada. */
  const precioDeOpcion = (group: OptionGroup, valor: number) => {
    // «Incluida» en vez de «$0.00» cuando el grupo viene con el plato: un cero
    // ahí se lee como un error de precio, no como algo ya pagado.
    const etiqueta = optionPriceLabel(group, valor)
    if (!etiqueta) return null
    return etiqueta.incluida
      ? <span className="shrink-0 text-[12.5px] font-semibold texto-tenue">Incluida</span>
      : (
          <span className="shrink-0 text-[14px] font-bold tabular-nums">
            {etiqueta.amount > 0 ? '+' : '−'}
            {money(Math.abs(etiqueta.amount))}
          </span>
        )
  }

  return (
    // ⚠️ SIN título: así no se pinta la barra de la hoja y la foto llega al
    // borde. Ver el encabezado de `Hoja`. El cerrar se pone aquí abajo,
    // flotando sobre la foto, que es el patrón del héroe de la portada.
    <Hoja abierta={abierto} onCerrar={onCerrar}>
      {/* ══ EL HÉROE DEL PRODUCTO ═══════════════════════════════════════
          A sangre y en PROPORCIÓN 4:3, que es la forma en la que llega ya
          recortada de Cloudinary (`RECORTE` en `lib/imagen.ts`): la foto
          entra con la forma exacta del hueco y `object-cover` no tiene nada
          que recortar por su cuenta.

          Sin foto —que hoy es el estado normal, 2 de 17 productos— queda el
          marcador con la inicial sobre el tinte de la marca, reservando el
          mismo sitio para que la hoja no salte al cargar. */}
      <div className="relative">
        {/* ⚠️ SIN FOTO, la banda es MÁS CORTA, y esto no es un detalle: hoy 15
            de los 17 productos de Monster Pizza no tienen imagen, así que el
            marcador es el estado normal y no la excepción. En 4:3 era un
            rectángulo de color vacío de 295 px —el 40 % de la pantalla— que no
            dice nada y que empujaba fuera de la vista justo lo que el botón
            pide elegir: se abría la ficha con «Elige tipo de masa» abajo y
            ningún tipo de masa a la vista. Con foto el alto se gana, porque
            ahí sí hay algo que mirar; sin ella, el sitio es de las opciones.
            Se decide por `imageUrl` porque es lo mismo que mira `Foto` para
            elegir entre la imagen y el marcador. */}
        <Foto
          url={product.imageUrl}
          alto={product.imageUrl ? 'aspect-[4/3]' : 'aspect-[5/2]'}
          uso="ficha"
          nombre={product.name}
        />

        {/* El velo, solo abajo y suave: sostiene el degradado hacia la
            superficie blanca para que la foto no corte en seco. Arriba no hace
            falta —el botón de cerrar lleva su propio fondo—. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-black/10" />

        {/* ⚠️ Etiqueta PROPIA, no un «Cerrar» más: el velo de la hoja ya es un
            botón con ese nombre, y dos controles que se llaman igual en la
            misma pantalla no se distinguen —ni con lector, ni al probarlo—.
            Además dice a dónde vuelve, que es la duda real de quien abrió una
            ficha sin querer. */}
        <button
          onClick={onCerrar}
          aria-label="Volver a la carta"
          className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition active:scale-95"
        >
          <RiCloseLine size={20} />
        </button>

        {!product.available && (
          <span className="absolute bottom-3 left-4 rounded-full bg-black/75 px-3 py-1 text-[11.5px] font-bold text-white">
            Agotado
          </span>
        )}
      </div>

      {/* ── Quién es y cuánto cuesta ──────────────────────────────────────
          El diseño pide «Nombre, precio, descripción» bajo la foto. El nombre
          estaba solo en la barra que se retiró, y el precio NO estaba en
          ninguna parte para un producto simple: vivía dentro del texto del
          botón. Es el mismo número que el cliente acaba de ver en la tarjeta
          de la carta, así que abrir la ficha ya no lo esconde. */}
      <div className="px-5 pt-4">
        <h2 className="titulo-xl">{product.name}</h2>
        <p className="mt-2 text-[22px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">
          {product.hasVariants && (
            <span className="text-[12px] font-semibold texto-tenue">desde </span>
          )}
          {money(product.priceFrom)}
        </p>
        {product.description && (
          <p className="mt-2.5 text-[14px] leading-relaxed texto-cuerpo">{product.description}</p>
        )}
      </div>

      {/* ⚠️ El cuerpo va sobre el OFF-WHITE, no sobre el blanco de la hoja.
          Con las tarjetas blancas sobre fondo blanco, lo único que las
          separaba era la sombra: se leía como un formulario con recuadros. Es
          el mismo fondo de la carta, así que la ficha se siente parte de la
          misma app y no de un diálogo aparte. */}
      <div className="fondo-app space-y-6 px-4 pt-6 pb-3">
        {product.variants.length > 0 && (
          <section>
            <h3 className={ROTULO}>Elige una opción</h3>
            <div className={LISTA}>
              {product.variants.map((opcion) => {
                const activa = variante?.id === opcion.id
                const oferta = opcion.priceSale != null && opcion.priceSale < opcion.price
                return (
                  <button
                    key={opcion.id}
                    onClick={() => setVariante(opcion)}
                    className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition ${
                      activa ? 'bg-marca-suave' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 text-[15px] font-bold tracking-tight">
                      {opcion.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[15px] font-bold tabular-nums">
                      {oferta && (
                        <span className="text-[13px] font-medium line-through texto-tenue">
                          {money(opcion.price)}
                        </span>
                      )}
                      {money(opcion.priceSale ?? opcion.price)}
                    </span>
                    {/* Las variantes son siempre una sola: círculo. */}
                    <Marca activa={activa} unica />
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
              <h3 className={ROTULO}>
                <span className="flex min-w-0 items-center gap-2">
                  {/* En un combo cada grupo es un PASO: «1 Elige tu primera
                      pizza», «2 Elige tu bebida». Sin el número, cinco bloques
                      seguidos parecen la misma lista repetida. */}
                  {esCombo && (
                    // `acento`, no `bg-marca text-white`: sobre el lima de la
                    // plataforma el número blanco desaparece. La utilidad trae
                    // su color de texto calculado por luminancia.
                    <span className="acento flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] leading-none font-black">
                      {indice + 1}
                    </span>
                  )}
                  <span className="min-w-0 truncate">{group.name}</span>
                </span>
                {minimo > 0
                  ? (
                      // ⚠️ Las DOS ramas fallaban el contraste, y esta es la
                      // insignia que dice si el cliente puede seguir: en falta
                      // era `bg-marca text-white` (lima con letra blanca) y
                      // cumplida `text-marca` sobre su propio tinte (1,19:1,
                      // donde AA exige 4,5). El diseño pide «Obligatorio en el
                      // color de marca, ✓ Listo en tono suave» y eso se
                      // conserva entero: lo que cambia es que el color de marca
                      // va de FONDO —con su letra calculada por luminancia— en
                      // vez de ir en la letra.
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-normal normal-case ${
                        cumplido ? 'bg-marca-suave texto-cuerpo' : 'acento shadow-acento'
                      }`}
                      >
                        {cumplido ? '✓ Listo' : minimo > 1 ? `Elige ${minimo}` : 'Obligatorio'}
                      </span>
                    )
                  : group.maxSelectable > 1 && (
                    <span className="shrink-0 text-[11px] font-semibold tracking-normal normal-case texto-tenue">
                      Hasta {group.maxSelectable}
                    </span>
                  )}
              </h3>
              {group.description && (
                <p className="mb-2 px-1 text-[12.5px] texto-cuerpo">{group.description}</p>
              )}

              {/* Contador de avance: «3 de 7 seleccionados».
                  Solo donde se puede elegir más de una, que es donde el cliente
                  pierde la cuenta. Con un tope de 1 sobra: el radio ya lo dice. */}
              {group.maxSelectable > 1 && (
                <p className="mb-2 px-1 text-[12px] texto-tenue tabular-nums">
                  {usado} de {group.maxSelectable} seleccionados
                </p>
              )}

              {/* Grupo corto de elección única: píldoras en fila. Ocupa una
                  línea en vez de tres y se lee de un vistazo. Los topes de
                  `pillLayout` evitan que 19 sabores acaben aquí. */}
              {pillLayout(group)
                ? (
                    <div className="flex flex-wrap gap-2">
                      {group.options.map((opcion) => {
                        const activa = elegidas.some(item => item.optionId === opcion.id)
                        const etiqueta = optionPriceLabel(group, opcion.price)
                        return (
                          <button
                            key={opcion.id}
                            type="button"
                            onClick={() => elegirUnica(group, {
                              groupId: group.id,
                              groupName: group.name,
                              optionId: opcion.id,
                              name: opcion.name,
                              price: opcion.price,
                              quantity: 1,
                            })}
                            // ⚠️ La opción activa va en acento SÓLIDO, no con el
                            // acento de letra sobre su propio tinte: «un lima
                            // sobre blanco no se lee al sol», que es la regla
                            // escrita en `index.css`, y aquí se estaba
                            // incumpliendo. `acento` trae su texto calculado por
                            // luminancia, así que cualquier color del negocio
                            // mantiene el contraste.
                            className={`rounded-full px-4 py-2.5 text-[14px] font-bold transition active:scale-95 ${
                              activa
                                ? 'acento shadow-acento'
                                : 'superficie borde-tema border-2 texto-cuerpo shadow-tarjeta'
                            }`}
                          >
                            {opcion.name}
                            {etiqueta && !etiqueta.incluida && (
                              <span className="ml-1.5 text-[12px] font-semibold opacity-70 tabular-nums">
                                {etiqueta.amount > 0 ? '+' : '−'}
                                {money(Math.abs(etiqueta.amount))}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                : (
              <div className={LISTA}>
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
                  const bloqueada = !activa && lleno && !singleChoice(group)

                  return (
                    /* ⚠️ El relleno vertical va DENTRO del botón, no en esta
                       fila. Con `py-3.5` aquí, el botón interno medía 24 px de
                       alto —medido en un iPhone— mientras la fila aparentaba
                       56: tocar el borde de arriba o de abajo no hacía nada, y
                       el cliente creía que la opción no respondía. El diseño
                       pide dianas de 44×44 REALES, y «real» es justo esto.
                       En `quantity` el relleno se queda aquí: ahí lo tocable
                       no es la fila, es el contador, que trae el suyo. */
                    <div
                      key={opcion.id}
                      className={`flex w-full items-center gap-3 px-4 text-left transition ${
                        group.selectionType === 'quantity' ? 'py-3' : ''
                      } ${activa ? 'bg-marca-suave' : ''} ${bloqueada ? 'opacity-40' : ''}`}
                    >
                      {group.selectionType === 'quantity'
                        ? (
                            <>
                              {opcion.imageUrl && (
                                <img
                                  src={foto(opcion.imageUrl, 'miniatura') || undefined}
                                  alt=""
                                  loading="lazy"
                                  className="size-12 shrink-0 rounded-xl object-cover"
                                />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[14.5px] font-bold tracking-tight">
                                  {opcion.name}
                                </span>
                                {opcion.description && (
                                  <span className="block truncate text-[12.5px] texto-cuerpo">
                                    {opcion.description}
                                  </span>
                                )}
                              </span>
                              {precioDeOpcion(group, opcion.price)}
                              <Contador
                                valor={elegida?.quantity || 0}
                                onCambiar={valor => cambiarCantidadOpcion(group, seleccion, valor)}
                              />
                            </>
                          )
                        : (
                            <button
                              type="button"
                              onClick={() => (singleChoice(group)
                                ? elegirUnica(group, seleccion)
                                : alternarOpcion(group, seleccion))}
                              disabled={bloqueada}
                              className="flex min-w-0 flex-1 items-center gap-3 py-3.5 text-left"
                            >
                              {/* Una opción que ES un producto trae su foto:
                                  eligiendo entre tres pizzas, el nombre solo no
                                  basta para decidir. */}
                              {opcion.imageUrl && (
                                <img
                                  src={foto(opcion.imageUrl, 'miniatura') || undefined}
                                  alt=""
                                  loading="lazy"
                                  className="size-12 shrink-0 rounded-xl object-cover"
                                />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[14.5px] font-bold tracking-tight">
                                  {opcion.name}
                                </span>
                                {opcion.description && (
                                  <span className="block truncate text-[12.5px] texto-cuerpo">
                                    {opcion.description}
                                  </span>
                                )}
                              </span>
                              {precioDeOpcion(group, opcion.price)}
                              <Marca activa={activa} unica={singleChoice(group)} />
                            </button>
                          )}
                    </div>
                  )
                })}
              </div>
                  )}
            </section>
          )
        })}

        {grupos.map(({ group, items }) => {
          const maximo = items[0]?.maxSelectable || null
          const elegidos = extras.filter(item => (item.group || 'Extras') === group).length
          return (
            <section key={group}>
              <h3 className={ROTULO}>
                <span className="min-w-0 truncate">{group}</span>
                {maximo && (
                  <span className="shrink-0 text-[11px] font-semibold tracking-normal normal-case texto-tenue">
                    Hasta {maximo}
                  </span>
                )}
              </h3>
              <div className={LISTA}>
                {items.map((extra) => {
                  const activo = extras.some(item => item.id === extra.id)
                  const bloqueado = !activo && Boolean(maximo) && elegidos >= maximo!
                  return (
                    <button
                      key={extra.id}
                      onClick={() => alternarExtra(extra)}
                      disabled={bloqueado}
                      className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition ${
                        activo ? 'bg-marca-suave' : ''
                      } ${bloqueado ? 'opacity-40' : ''}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] font-bold tracking-tight">
                          {extra.name}
                        </span>
                        {extra.description && (
                          <span className="block truncate text-[12.5px] texto-cuerpo">
                            {extra.description}
                          </span>
                        )}
                      </span>
                      {extra.price > 0 && (
                        <span className="shrink-0 text-[14px] font-bold tabular-nums">
                          +{money(extra.price)}
                        </span>
                      )}
                      {/* Los extras admiten varios: cuadrado. */}
                      <Marca activa={activo} unica={false} />
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}

        {/* ── Agrega algo más ──────────────────────────────────────────
            Los adicionales van agrupados por la sección que puso el dueño
            («Agrega bebidas», «También te puede gustar»). Cada uno entra al
            carrito por su cuenta: no forman parte de este plato. */}
        {agrupadas.map(({ section, items }) => (
          <section key={section}>
            <h3 className={ROTULO}>
              <span className="min-w-0 truncate">{section}</span>
            </h3>
            <div className={LISTA}>
              {items.map(reco => (
                <div
                  key={reco.productId}
                  className="flex items-center gap-3 px-4 py-3.5"
                >
                  {reco.imageUrl && (
                    <img
                      src={foto(reco.imageUrl, 'miniatura') || undefined}
                      alt=""
                      loading="lazy"
                      className="size-12 shrink-0 rounded-xl object-cover"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-bold tracking-tight">
                      {reco.name}
                    </span>
                    {reco.description && (
                      <span className="block truncate text-[12.5px] texto-cuerpo">
                        {reco.description}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[14px] font-bold tabular-nums">
                    {money(reco.price)}
                  </span>
                  {/* ⚠️ El mismo `+` de la carta: acento con su glow y el icono
                      `RiAddLine`, no `bg-marca text-white` con el CARÁCTER «+».
                      Con el carácter, lo que el flex centra es la caja de
                      línea y la cruz queda alta dentro del círculo; y con el
                      blanco forzado, sobre el lima no se ve. Las dos cosas ya
                      se corrigieron en la rejilla de la portada. */}
                  <button
                    type="button"
                    onClick={() => onAgregarSuelto(reco.productId)}
                    disabled={!puedePedir}
                    aria-label={`Agregar ${reco.name}`}
                    className="acento flex size-11 shrink-0 items-center justify-center rounded-full shadow-acento transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
                  >
                    <RiAddLine size={20} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section>
          <h3 className={ROTULO}>
            <span>Nota para el negocio</span>
            <span className="shrink-0 text-[11px] font-semibold tracking-normal normal-case texto-tenue">
              Opcional
            </span>
          </h3>
          {/* ⚠️ El foco en `--tinta`, no en `focus:border-marca`: un borde lima
              sobre blanco da 1,19:1, así que el campo activo no se distinguía
              del inactivo. Es el mismo tratamiento del buscador de la portada. */}
          <textarea
            value={nota}
            onChange={event => setNota(event.target.value.slice(0, 200))}
            rows={2}
            placeholder="Ej: sin cebolla, bien cocido…"
            className="superficie w-full resize-none rounded-(--radius-tarjeta) border-2 borde-tema px-4 py-3 text-[14px] shadow-tarjeta outline-none focus:border-(--tinta) placeholder:texto-tenue"
          />
        </section>
      </div>

      <div className="superficie sticky bottom-0 border-t borde-tema px-4 pt-3 pb-seguro">
        {/* Precio actual: cómo va quedando según lo que elige.
            Solo en productos que se arman —donde el número CAMBIA mientras
            eliges—; en uno simple repetiría lo que ya dice el botón. */}
        {gruposOpciones.length > 0 && (
          <div className="mb-2.5 flex items-baseline justify-between">
            <span className="text-[13px] font-semibold texto-cuerpo">Precio actual</span>
            <span className="text-[19px] font-extrabold tracking-tight tabular-nums">
              {money(precio * cantidad)}
            </span>
          </div>
        )}
        <div className="flex items-center gap-3">
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
      </div>
    </Hoja>
  )
}
