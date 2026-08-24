import { useState } from 'react'
import { Banknote, Bike, Crosshair, Landmark, MapPin, ShoppingBag, Trash2 } from 'lucide-react'
import { Aviso, Boton, Contador, Hoja } from './ui'
import { money } from '../lib/format'
import { cartTotal, detalleDeLinea, lineTotal, needsAddress, orderTotal } from '../lib/cart'
import { MENSAJES, pedirUbicacion } from '../lib/ubicacion'
import type { Ubicacion } from '../lib/ubicacion'
import type { Address, CartLine, Fulfillment, Me, PaymentMethod, StorePaymentMethod } from '../lib/types'

/** Un icono por método. Uno que no esté en la lista cae en el genérico. */
const ICONO_PAGO: Record<string, typeof Landmark> = {
  transferencia: Landmark,
  efectivo: Banknote,
  pago_al_retirar: ShoppingBag,
}

// El carrito y el cierre del pedido, en una sola hoja.
//
// El total que se ve aquí es informativo. Al confirmar se mandan ids y
// cantidades, y el importe real lo devuelve el servidor: si el negocio cambió
// un precio hace un minuto, gana el suyo.

/** Lo que se manda al guardar una dirección. El pin viaja aparte y es opcional. */
export interface NuevaDireccion {
  label: string
  address: string
  reference: string
  buildingType: string
  latitude?: number
  longitude?: number
  accuracy?: number | null
}

/**
 * Los mismos cinco valores que acepta el CHECK de `customer_addresses`. Si
 * alguien añade uno aquí sin añadirlo allí, la base rechaza la dirección
 * entera — por eso los textos se separan de los valores.
 *
 * ⚠️ Estas cápsulas son TAMBIÉN la etiqueta de la dirección. Antes había
 * además un campo de texto libre —«Casa, Oficina…»— justo encima, y preguntaba
 * dos veces lo mismo: el cliente escribía «Casa» arriba y volvía a tocar
 * «Casa» abajo. Peor, podía escribir «Fffffff» y quedarse con una libreta de
 * direcciones que no distingue una de otra. Eligiendo, no hay forma de fallar.
 */
const TIPOS_DE_EDIFICIO = [
  { valor: 'casa', texto: 'Casa' },
  { valor: 'departamento', texto: 'Departamento' },
  { valor: 'oficina', texto: 'Oficina' },
  { valor: 'hotel', texto: 'Hotel' },
  { valor: 'otro', texto: 'Otro' },
] as const

const DIRECCION_EN_BLANCO: NuevaDireccion = {
  label: 'Casa', address: '', reference: '', buildingType: 'casa',
}

/** Con pin es tener los DOS: media coordenada apunta al ecuador, no a medias. */
const tieneUbicacion = (direccion: Address): boolean =>
  direccion.latitude !== null && direccion.latitude !== undefined
  && direccion.longitude !== null && direccion.longitude !== undefined

export default function CartSheet({
  abierta, onCerrar, lines, onCantidad, me, puedePedir, enviando, error, deliveryFee,
  minOrderAmount, entrega, paymentMethods, onEntrega, onConfirmar, onNuevaDireccion,
  onUbicarDireccion, onBorrarDireccion,
}: {
  abierta: boolean
  onCerrar: () => void
  lines: CartLine[]
  onCantidad: (key: string, cantidad: number) => void
  me: Me | null
  puedePedir: boolean
  enviando: boolean
  error: string | null
  deliveryFee: number
  /** Lo mínimo que el local prepara, sin el envío. Cero = sin mínimo. */
  minOrderAmount: number
  /**
   * Cómo lo recibe. Llega de fuera porque también se elige en la portada, y
   * las dos pantallas tienen que reflejar la MISMA decisión: con un estado
   * aquí dentro, elegir «Retiro» arriba y abrir el carrito volvía a «Entrega»
   * y el cliente pagaba un envío que había rechazado.
   */
  entrega: Fulfillment
  /**
   * Los métodos que ESTE local acepta, tal como los manda el servidor.
   *
   * Llega de fuera y no se decide aquí: hasta el 2026-08-16 los tres estaban
   * escritos en este archivo y el dueño no elegía nada.
   */
  paymentMethods: StorePaymentMethod[]
  onEntrega: (entrega: Fulfillment) => void
  onConfirmar: (datos: {
    fulfillment: Fulfillment
    addressId: string | null
    name: string
    paymentMethod: PaymentMethod
    deliveryNotes: string | null
  }) => void
  /** Devuelve el id de la dirección creada: se selecciona sola para ESTE pedido. */
  onNuevaDireccion: (datos: NuevaDireccion) => Promise<string | null>
  /** Le pone el pin a una dirección ya guardada, que es la que no lo tiene. */
  onUbicarDireccion: (addressId: string, ubicacion: Ubicacion) => Promise<void>
  onBorrarDireccion: (addressId: string) => Promise<void>
}) {
  /**
   * En qué paso está el cliente.
   *
   * ⚠️ Son dos pantallas y no una hoja larga a propósito. Mezcladas, el
   * cliente tenía que pasar por encima de la dirección y del método de pago
   * solo para comprobar qué llevaba, y el botón de confirmar quedaba a un
   * scroll de distancia de los productos. Revisar y decidir son dos momentos
   * distintos: el carrito revisa, el checkout decide.
   */
  const [paso, setPaso] = useState<'carrito' | 'checkout'>('carrito')
  const [pago, setPago] = useState<PaymentMethod>('transferencia')
  const [direccionId, setDireccionId] = useState<string | null>(null)
  /**
   * `null` = el cliente no ha tocado el campo; una cadena = lo que escribió,
   * aunque sea vacía.
   *
   * La distinción no es un capricho. Antes era `value={nombre || me?.name}`
   * sobre un estado que empezaba vacío: el campo se veía relleno pero el
   * estado no lo estaba, así que al borrarlo reaparecía el nombre guardado y
   * no había forma de cambiárselo. Y guardar `me.name` en el estado inicial
   * tampoco vale: este panel se monta con la tienda, ANTES de que `me`
   * responda, así que el valor inicial siempre sería vacío.
   */
  const [nombreEscrito, setNombreEscrito] = useState<string | null>(null)
  const nombre = nombreEscrito ?? me?.name ?? ''
  // Lo que cambia de un pedido a otro: «llame al llegar», «timbre roto». La
  // referencia de la dirección es del SITIO y se queda; esto es de HOY.
  const [instrucciones, setInstrucciones] = useState('')
  const [nuevaAbierta, setNuevaAbierta] = useState(false)
  const [nueva, setNueva] = useState<NuevaDireccion>({ ...DIRECCION_EN_BLANCO })
  const [guardando, setGuardando] = useState(false)
  /**
   * El pin del formulario, mientras se escribe la dirección.
   *
   * `null` = no se ha pedido o no se pudo. Es OPCIONAL a propósito: quien niega
   * el permiso —o abre el enlace dentro de WhatsApp, que no siempre lo reenvía—
   * tiene que poder pedir igual. Perder la venta por un dato de ayuda sería
   * peor que repartir con la dirección escrita, que es como se hizo siempre.
   */
  const [pin, setPin] = useState<Ubicacion | null>(null)
  const [avisoPin, setAvisoPin] = useState<string | null>(null)
  /** Qué dirección está pidiendo ubicación: `'nueva'`, un id, o nada. */
  const [ubicando, setUbicando] = useState<string | null>(null)
  /** Qué dirección se está retirando. Evita el doble toque. */
  const [borrando, setBorrando] = useState<string | null>(null)

  const borrarDireccion = async (direccion: Address) => {
    // Confirmar antes: la papelera está a un centímetro de elegir la
    // dirección, y perderla por un dedo grande no se deshace.
    if (!window.confirm(`¿Eliminar «${direccion.label}»?`)) return
    setBorrando(direccion.id)
    try {
      await onBorrarDireccion(direccion.id)
      // Si era la elegida, se suelta: dejar seleccionada una que ya no está
      // mandaría el pedido con un id que el servidor va a rechazar.
      if (direccionId === direccion.id) setDireccionId(null)
    } finally {
      setBorrando(null)
    }
  }

  const capturar = async (destino: string) => {
    setUbicando(destino)
    setAvisoPin(null)
    try {
      const resultado = await pedirUbicacion()
      if (!resultado.ok) {
        setAvisoPin(resultado.mensaje)
        return
      }
      if (destino === 'nueva') setPin(resultado.ubicacion)
      else await onUbicarDireccion(destino, resultado.ubicacion)
    } catch {
      // Ni un fallo inesperado puede dejar al cliente sin poder pedir.
      setAvisoPin(MENSAJES.no_disponible)
    } finally {
      setUbicando(null)
    }
  }

  // Cerrar y volver a abrir empieza por el carrito: si la hoja se reabriera en
  // el checkout, el cliente no vería lo que está a punto de pagar.
  const cerrar = () => {
    setPaso('carrito')
    onCerrar()
  }

  const direcciones: Address[] = me?.addresses || []
  const elegida = direccionId || direcciones.find(item => item.is_default)?.id || direcciones[0]?.id || null
  const nombreFinal = nombre.trim()
  const faltaDireccion = needsAddress(entrega) && !elegida
  // Al pasar de retiro a domicilio, «pago al retirar» deja de tener sentido.
  // Se DERIVA en vez de corregir el estado durante el render: así no hay un
  // repintado extra ni un instante en que el método guardado sea imposible.
  const pagoEfectivo: PaymentMethod =
    needsAddress(entrega) && pago === 'pago_al_retirar' ? 'efectivo' : pago
  const faltaNombre = nombreFinal.length < 2

  const guardarDireccion = async () => {
    if (nueva.address.trim().length < 5) return
    setGuardando(true)
    try {
      const creadaId = await onNuevaDireccion({
        ...nueva,
        latitude: pin?.latitude,
        longitude: pin?.longitude,
        accuracy: pin?.accuracy ?? null,
      })
      // ⚠️ Queda ELEGIDA. Quien escribe una dirección en el checkout la escribe
      // para este pedido; sin esto seguía seleccionada la anterior y el pedido
      // salía a la casa vieja mientras la app decía «guardada».
      if (creadaId) setDireccionId(creadaId)
      setNueva({ ...DIRECCION_EN_BLANCO })
      setPin(null)
      setAvisoPin(null)
      setNuevaAbierta(false)
    } finally {
      setGuardando(false)
    }
  }

  const opcionesEntrega = [
    { id: 'delivery' as const, icono: Bike, texto: 'A domicilio' },
    { id: 'pickup' as const, icono: ShoppingBag, texto: 'Yo lo recojo' },
  ]

  // «Pago al retirar» no es cómo paga, es CUÁNDO: al pasar por el local. Solo
  // se ofrece en retiro — prometérselo a quien pidió a domicilio es ofrecer
  // algo que no se puede cumplir. El servidor lo vuelve a comprobar.
  //
  // ⚠️ La lista sale del NEGOCIO, no de aquí. Hasta el 2026-08-16 estaban los
  // tres escritos a mano, así que el dueño creía que elegía cómo le pagan y no
  // elegía nada. Ahora se pinta lo que el servidor dice que acepta, y el
  // servidor lo vuelve a exigir al crear el pedido.
  const opcionesPago = paymentMethods
    .filter((m: StorePaymentMethod) => m.code !== 'pago_al_retirar' || !needsAddress(entrega))
    .map((m: StorePaymentMethod) => ({
      id: m.code as PaymentMethod,
      icono: ICONO_PAGO[m.code] || Landmark,
      // El texto del catálogo manda; el matiz de entrega/retiro solo aplica
      // al efectivo, que es el único que cambia de significado según cómo se
      // reciba el pedido.
      texto: m.code === 'efectivo' && !needsAddress(entrega) ? 'Efectivo' : m.label,
      detalle: m.code === 'efectivo' && !needsAddress(entrega)
        ? 'Pagas en efectivo en el local.'
        : m.help_text || '',
    }))

  // Vista previa del envío. El importe que manda es el que calcula el servidor
  // al crear el pedido: aquí solo se anticipa para que nadie se lleve sorpresas.
  const subtotal = cartTotal(lines)
  // ⚠️ Sobre el SUBTOTAL, sin el envío: el local decide cuánto vale la pena
  // cocinar, no cuánto gasta el cliente. Quien quiera un agua y pagar el
  // reparto está en su derecho. Es la misma cuenta que hace la base en
  // `orders_enforce_min_amount`, y tienen que coincidir o el botón dejaría
  // pasar un pedido que se rechaza al confirmar.
  const faltaParaElMinimo = minOrderAmount > 0
    ? Math.max(0, Math.round((minOrderAmount - subtotal) * 100) / 100)
    : 0
  const envio = needsAddress(entrega) ? deliveryFee : 0
  const total = orderTotal(lines, entrega, deliveryFee)

  const enCarrito = paso === 'carrito'

  return (
    <Hoja
      abierta={abierta}
      onCerrar={cerrar}
      onAtras={enCarrito ? undefined : () => setPaso('carrito')}
      titulo={enCarrito ? 'Tu carrito' : 'Finalizar pedido'}
    >
      <div className="space-y-6 p-4">
        {/* ── PASO 1: solo lo que lleva ─────────────────────────────────── */}
        {enCarrito && !lines.length && (
          <div className="py-10 text-center">
            <p className="text-[15px] font-semibold">Tu carrito está vacío</p>
            <p className="mt-1 text-[13px] texto-tenue">
              Vuelve a la carta y agrega lo que quieras pedir.
            </p>
          </div>
        )}

        {enCarrito && (
        <section className="space-y-3">
          {lines.map(linea => (
            <div key={linea.key} className="flex gap-3 border-b borde-tema pb-3 last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] leading-snug font-semibold">{linea.product.name}</p>
                {linea.variant && (
                  <p className="text-[13px] texto-tenue">{linea.variant.name}</p>
                )}
                {/* ⚠️ Lo que eligió, una línea por grupo. Faltaba: el carrito
                    pintaba solo `extras` —el sistema viejo— así que una pizza
                    con masa, sabor y borde salía como «Pizza · Familiar» y el
                    cliente confirmaba sin ver lo que había armado. Es la
                    pantalla donde más importa: es la última antes de pagar. */}
                {detalleDeLinea(linea).map(texto => (
                  <p key={texto} className="line-clamp-2 text-[12px] leading-snug texto-tenue">
                    {texto}
                  </p>
                ))}
                {linea.note && (
                  <p className="mt-0.5 text-[12px] italic texto-tenue">“{linea.note}”</p>
                )}
                <div className="mt-2 flex items-center gap-3">
                  <Contador
                    valor={linea.quantity}
                    minimo={0}
                    onCambiar={cantidad => onCantidad(linea.key, cantidad)}
                  />
                  <button
                    onClick={() => onCantidad(linea.key, 0)}
                    aria-label={`Quitar ${linea.product.name}`}
                    className="texto-tenue"
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              <span className="shrink-0 text-[15px] font-bold tabular-nums">
                {money(lineTotal(linea))}
              </span>
            </div>
          ))}
        </section>
        )}

        {/* ── PASO 2: cómo lo recibe, a dónde, cómo paga y quién ────────── */}
        {!enCarrito && (
        <>
        <section>
          <h3 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            ¿Cómo lo quieres?
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {opcionesEntrega.map(({ id, icono: Icono, texto }) => (
              <button
                key={id}
                onClick={() => onEntrega(id)}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-[14px] font-semibold transition ${
                  entrega === id ? 'border-marca bg-marca-suave text-marca' : 'borde-tema'
                }`}
              >
                <Icono size={17} />
                {texto}
              </button>
            ))}
          </div>
        </section>

        {/* ── A dónde ── */}
        {needsAddress(entrega) && (
          <section>
            <h3 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
              Dirección
            </h3>
            <div className="space-y-2">
              {direcciones.map(direccion => (
                <div
                  key={direccion.id}
                  className={`flex w-full items-start gap-2 rounded-xl border px-4 py-3 transition ${
                    elegida === direccion.id ? 'border-marca bg-marca-suave' : 'borde-tema'
                  }`}
                >
                <button
                  onClick={() => setDireccionId(direccion.id)}
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                >
                  <MapPin size={17} className="mt-0.5 shrink-0 texto-tenue" />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold">{direccion.label}</span>
                    <span className="block text-[13px] texto-tenue">{direccion.address}</span>
                    {direccion.reference && (
                      <span className="block text-[12px] texto-tenue">{direccion.reference}</span>
                    )}
                    {/* Las direcciones de siempre no tienen pin. Se ofrece
                        añadirlo aquí porque el cliente que ya tiene la suya
                        guardada es justo el que más pide. */}
                    {tieneUbicacion(direccion)
                      ? (
                          <span className="mt-1 flex items-center gap-1 text-[12px] font-semibold text-verde">
                            <Crosshair size={12} /> Ubicación guardada
                          </span>
                        )
                      : (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(event) => { event.stopPropagation(); void capturar(direccion.id) }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              event.stopPropagation()
                              void capturar(direccion.id)
                            }}
                            className="mt-1 flex items-center gap-1 text-[12px] font-semibold text-marca"
                          >
                            <Crosshair size={12} />
                            {ubicando === direccion.id ? 'Buscando…' : 'Agregar ubicación'}
                          </span>
                        )}
                  </span>
                </button>
                {/* Borrar pide confirmación: está a un centímetro de elegir, y
                    perder una dirección por un dedo grande es una molestia que
                    no se deshace. */}
                <button
                  onClick={() => void borrarDireccion(direccion)}
                  disabled={borrando === direccion.id}
                  aria-label={`Eliminar ${direccion.label}`}
                  className="-mr-1 shrink-0 rounded-full p-1.5 texto-tenue transition active:scale-90"
                >
                  <Trash2 size={16} />
                </button>
                </div>
              ))}

              {nuevaAbierta
                ? (
                    <div className="space-y-2 rounded-xl border borde-tema p-3">
                      {/* ⚠️ Un `select` NATIVO, no cápsulas. Abre la rueda del
                          teléfono, ocupa una línea en vez de dos filas y pesa
                          cero. Pone el tipo Y la etiqueta a la vez: son lo
                          mismo, y así no pueden contradecirse. */}
                      <select
                        value={nueva.buildingType}
                        onChange={(event) => {
                          const tipo = TIPOS_DE_EDIFICIO
                            .find(item => item.valor === event.target.value)
                          if (tipo) setNueva({ ...nueva, buildingType: tipo.valor, label: tipo.texto })
                        }}
                        className="w-full rounded-lg border borde-tema bg-transparent px-3 py-2.5 text-[14px] outline-none focus:border-marca"
                      >
                        {TIPOS_DE_EDIFICIO.map(tipo => (
                          <option key={tipo.valor} value={tipo.valor}>{tipo.texto}</option>
                        ))}
                      </select>
                      <textarea
                        value={nueva.address}
                        onChange={event => setNueva({ ...nueva, address: event.target.value.slice(0, 300) })}
                        rows={2}
                        placeholder="Calle, número, sector…"
                        className="w-full resize-none rounded-lg border borde-tema bg-transparent px-3 py-2.5 text-[14px] outline-none focus:border-marca"
                      />
                      <input
                        value={nueva.reference}
                        onChange={event => setNueva({ ...nueva, reference: event.target.value.slice(0, 300) })}
                        placeholder="Referencia (casa azul, portón negro…)"
                        className="w-full rounded-lg border borde-tema bg-transparent px-3 py-2.5 text-[14px] outline-none focus:border-marca"
                      />

                      {/* ── El pin ──
                          Va con un BOTÓN y nunca solo: quien pide desde la
                          oficina para su casa mandaría al repartidor a la
                          oficina sin enterarse. */}
                      <button
                        onClick={() => void capturar('nueva')}
                        disabled={ubicando === 'nueva'}
                        className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[14px] font-semibold transition ${
                          pin ? 'border-verde text-verde' : 'borde-tema text-marca'
                        }`}
                      >
                        <Crosshair size={16} />
                        {ubicando === 'nueva'
                          ? 'Buscando tu ubicación…'
                          : pin
                            ? `Ubicación lista${pin.accuracy ? ` · ±${Math.round(pin.accuracy)} m` : ''}`
                            // Tras un fallo el botón dice «Reintentar»: dejarlo
                            // igual, con un aviso debajo, parece que no hizo
                            // nada y el cliente no sabe que puede volver.
                            : avisoPin ? 'Reintentar' : 'Usar mi ubicación actual'}
                      </button>
                      {avisoPin && (
                        <p className="text-[12px] leading-snug texto-tenue">{avisoPin}</p>
                      )}

                      {/* ⚠️ Aquí había un segundo campo de instrucciones, el
                          PERMANENTE de esta casa. Se retiró: preguntaba casi lo
                          mismo que «Instrucciones» de más abajo —a dos dedos de
                          distancia— y el cliente no sabía cuál llenar. Queda el
                          del PEDIDO, que es el que el dueño lee en su comanda.
                          `customer_addresses.courier_notes` sigue en la base y
                          el panel la pinta si tiene algo; simplemente ya no se
                          pide aquí. */}

                      <Boton
                        variante="suave"
                        onClick={guardarDireccion}
                        disabled={guardando || nueva.address.trim().length < 5}
                      >
                        {guardando ? 'Guardando…' : 'Guardar dirección'}
                      </Boton>
                      {/* Sin esto el formulario se abría y no se cerraba: quien
                          toca «Agregar dirección» teniendo ya una guardada se
                          quedaba con el cuadro abierto y sin salida. */}
                      <button
                        onClick={() => {
                          setNuevaAbierta(false)
                          setNueva({ ...DIRECCION_EN_BLANCO })
                          setPin(null)
                          setAvisoPin(null)
                        }}
                        className="w-full py-1.5 text-[13px] font-semibold texto-tenue transition active:scale-[0.98]"
                      >
                        Cancelar
                      </button>
                    </div>
                  )
                : (
                    <button
                      onClick={() => setNuevaAbierta(true)}
                      className="w-full rounded-xl border border-dashed borde-tema px-4 py-3 text-[14px] font-semibold texto-tenue"
                    >
                      + Agregar dirección
                    </button>
                  )}
            </div>
          </section>
        )}

        {/* ── Instrucciones ──
            Va tras la dirección y antes del pago, como la pantalla 9. Solo a
            domicilio: a quien retira no hay nada que indicarle. */}
        {needsAddress(entrega) && (
          <section>
            <h3 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
              Instrucciones <span className="normal-case">(opcional)</span>
            </h3>
            <input
              value={instrucciones}
              onChange={event => setInstrucciones(event.target.value.slice(0, 300))}
              placeholder="Ej: llame al llegar, timbre roto…"
              className="w-full rounded-xl border borde-tema bg-transparent px-3.5 py-3 text-[14px] outline-none focus:border-marca"
            />
          </section>
        )}

        {/* ── Cómo paga ── */}
        {/* La tarjeta NO está y no es un olvido: la plataforma no procesa
            cobros (regla inviolable #6). El negocio cobra por fuera. */}
        <section>
          <h3 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            ¿Cómo vas a pagar?
          </h3>
          <div className="space-y-2">
            {opcionesPago.map(({ id, icono: Icono, texto, detalle }) => (
              <button
                key={id}
                onClick={() => setPago(id)}
                className={`flex w-full items-start gap-3 rounded-2xl border-2 px-4 py-3.5 text-left transition ${
                  pagoEfectivo === id ? 'border-(--acento) bg-(--acento-suave)' : 'borde-tema'
                }`}
              >
                <Icono size={18} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-bold">{texto}</span>
                  <span className="block text-[12.5px] texto-tenue">{detalle}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* ── Quién ── */}
        <section>
          <h3 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            A nombre de
          </h3>
          <input
            value={nombre}
            onChange={event => setNombreEscrito(event.target.value.slice(0, 120))}
            placeholder="Tu nombre"
            className="w-full rounded-xl border borde-tema bg-transparent px-3.5 py-3 text-[14px] outline-none focus:border-marca"
          />
          {me?.phone && (
            <p className="mt-2 text-[12px] texto-tenue">
              Te contactamos al {me.phone} — el mismo de WhatsApp.
            </p>
          )}
        </section>
        </>
        )}

        {error && <Aviso tono="alerta">{error}</Aviso>}
      </div>

      <div className="superficie sticky bottom-0 border-t borde-tema px-4 pt-3 pb-seguro">
        <div className="mb-3 space-y-1.5">
          <div className="flex items-baseline justify-between text-[13.5px] texto-tenue">
            <span>Subtotal</span>
            <span className="tabular-nums">{money(subtotal)}</span>
          </div>
          {minOrderAmount > 0 && (
            <div className="flex items-baseline justify-between text-[13.5px] texto-tenue">
              <span>Pedido mínimo</span>
              <span className="tabular-nums">{money(minOrderAmount)}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between text-[13.5px] texto-tenue">
            <span>Envío</span>
            <span className="tabular-nums">
              {entrega === 'pickup' ? 'Retiras en el local' : envio > 0 ? money(envio) : 'Gratis'}
            </span>
          </div>
          <div className="flex items-baseline justify-between border-t borde-tema pt-2">
            <span className="text-[14px] font-bold">Total</span>
            <span className="text-[24px] font-extrabold tracking-tight tabular-nums">{money(total)}</span>
          </div>
        </div>
        {/* ⚠️ El botón dice QUÉ FALTA, no «completa los datos». Con seis
            bloques encima, «faltan datos» deja al cliente buscando cuál. */}
        {enCarrito
          ? (
              <Boton
                onClick={() => setPaso('checkout')}
                disabled={!puedePedir || !lines.length || faltaParaElMinimo > 0}
              >
                {!lines.length
                  ? 'Tu carrito está vacío'
                  : !puedePedir
                    ? 'El local está cerrado'
                    : faltaParaElMinimo > 0
                      // Dice CUÁNTO falta, no «no llegas al mínimo»: con el
                      // número exacto el cliente sabe qué añadir.
                      ? `Te faltan ${money(faltaParaElMinimo)} para el mínimo`
                      : `Continuar · ${money(total)}`}
              </Boton>
            )
          : (
              <Boton
                onClick={() => onConfirmar({
                  fulfillment: entrega, addressId: elegida, name: nombreFinal,
                  paymentMethod: pagoEfectivo, deliveryNotes: instrucciones.trim() || null,
                })}
                disabled={!puedePedir || enviando || faltaDireccion || faltaNombre || !lines.length || faltaParaElMinimo > 0}
              >
                {enviando
                  ? 'Enviando…'
                  : faltaNombre
                    ? 'Escribe tu nombre'
                    : faltaDireccion
                      ? 'Elige una dirección'
                      : `Confirmar pedido · ${money(total)}`}
              </Boton>
            )}
        <p className="mt-2.5 text-center text-[11.5px] texto-tenue">
          El negocio confirma tu pedido por WhatsApp y coordina el pago.
        </p>
      </div>
    </Hoja>
  )
}
