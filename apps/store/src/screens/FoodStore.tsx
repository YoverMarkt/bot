import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bike, ChevronDown, ChevronLeft, ClipboardList, Clock, Home, MapPin, Search, ShoppingBag,
  ShoppingCart, X,
} from 'lucide-react'
import {
  createAddress, createOrder, deleteAddress, getCatalog, getMe, getOrder, setAddressLocation,
} from '../lib/api'
import {
  ENTREGA_POR_DEFECTO, addLine, cartCount, cartTotal, lineKey, lineTotal, needsAddress,
  orderTotal, setQuantity, unitPrice,
} from '../lib/cart'
import { Aviso, Foto } from '../components/ui'
import { resumenDesdeCarrito, resumenDesdePedido } from '../lib/resumen'
import { money, rangoDeEspera } from '../lib/format'
import { foto } from '../lib/imagen'
import { randomId } from '../lib/session'
import ProductSheet from '../components/ProductSheet'
import CartSheet from '../components/CartSheet'
import OrderPlaced from './OrderPlaced'
import type { PedidoRecibido } from './OrderPlaced'
import type { NuevaDireccion } from '../components/CartSheet'
import type { Ubicacion } from '../lib/ubicacion'
const Account = lazy(() => import('./Account'))
import type {
  Business, CartLine, Catalog, Fulfillment, Me, PaymentMethod, Product, StoreStatus,
  TrackedOrder,
} from '../lib/types'

// Flujo de comida, bebidas y retail: portada → categorías → producto → carrito.
// Es el patrón que la gente ya tiene aprendido de las apps de delivery, y por
// eso no se inventa nada nuevo aquí.

/** Para buscar «jamon» y que salga «jamón». Nadie escribe tildes con una mano. */
const normalizar = (texto: string) =>
  texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

export default function FoodStore({ slug, business, status, onVolver, onFalloEnlace }: {
  slug: string
  business: Business
  status: StoreStatus
  onVolver?: () => void
  onFalloEnlace: (error: unknown) => Promise<boolean>
}) {
  const [catalogo, setCatalogo] = useState<Catalog | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [lineas, setLineas] = useState<CartLine[]>([])
  const [elegido, setElegido] = useState<Product | null>(null)
  const [carritoAbierto, setCarritoAbierto] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categoriaActiva, setCategoriaActiva] = useState<string | null>(null)
  const [busqueda, setBusqueda] = useState('')
  /**
   * El pedido que se acaba de enviar. Vive aquí y no en el seguimiento porque
   * el resumen sale del CARRITO —que se vacía al confirmar— y del total
   * oficial que devolvió el servidor.
   */
  const [recienHecho, setRecienHecho] = useState<
    { pedido: PedidoRecibido; nombre: string; transferencia: boolean } | null
  >(null)
  /** El pedido que se dejó a medio pagar. Alimenta el aviso de la portada. */
  const [pagoPendiente, setPagoPendiente] = useState<TrackedOrder | null>(null)
  /** Si el cliente tocó ese aviso y está en la pantalla de pago. */
  const [abrirPago, setAbrirPago] = useState(false)
  const [enCuenta, setEnCuenta] = useState(false)
  // Una portada que no carga se descarta: mejor la cabecera de siempre que el
  // icono de imagen rota como primera impresión de la tienda.
  const [portadaRota, setPortadaRota] = useState(false)
  // Cómo lo recibe. Vive AQUÍ y no en el carrito porque ahora se elige en la
  // portada: los dos sitios tienen que enseñar y cambiar lo mismo.
  const [entrega, setEntrega] = useState<Fulfillment>(ENTREGA_POR_DEFECTO)

  const secciones = useRef<Record<string, HTMLElement | null>>({})
  const pestanas = useRef<Record<string, HTMLElement | null>>({})
  const buscador = useRef<HTMLInputElement>(null)
  // Durante un salto programático el scroll atraviesa secciones intermedias y
  // la pestaña activa iría saltando por el camino. Se ignora hasta que llega.
  const saltando = useRef(false)
  // La clave del pedido en curso. Vive en un ref porque no pinta nada: si
  // estuviera en el estado, cambiarla repintaría la tienda entera.
  const claveDelPedido = useRef<string | null>(null)

  useEffect(() => {
    let guardado: string | null = null
    try { guardado = localStorage.getItem(`pedido:${slug}`) } catch { /* modo privado */ }
    if (!guardado) return

    /**
     * ⚠️ Quien todavía DEBE dinero aterriza en la pantalla de pago, no en el
     * seguimiento.
     *
     * Los datos para transferir viven en la pantalla posterior a confirmar. Si
     * el cliente cierra la app antes de pagar —que es lo normal: va a su banco,
     * transfiere, y vuelve con la captura— al regresar caía en el seguimiento y
     * ahí ya no tenía dónde subirla. Se quedaba con el pedido en el aire y sin
     * más salida que escribir por WhatsApp.
     *
     * Si falla la consulta no se hace nada: la tienda abre como siempre. Un
     * pedido viejo no puede impedir que alguien mire la carta.
     */
    getOrder(slug, guardado)
      .then((pedido) => {
        if (pedido.status !== 'esperando_pago' || pedido.payment_confirmed_at) return
        setPagoPendiente(pedido)
      })
      .catch(() => { /* sin conexión o pedido borrado: la tienda abre igual */ })
  }, [slug])

  useEffect(() => {
    Promise.all([getCatalog(slug), getMe(slug).catch(() => null)])
      .then(([datos, quien]) => {
        setCatalogo(datos)
        setMe(quien)
      })
      .catch(error => void onFalloEnlace(error))
  }, [slug, onFalloEnlace])

  const puedePedir = catalogo?.canOrder ?? (status === 'abierta')

  // Productos por categoría, respetando el orden del negocio y dejando al
  // final los que no tienen categoría asignada.
  const grupos = useMemo(() => {
    if (!catalogo) return []
    const porCategoria = catalogo.categories.map(categoria => ({
      id: categoria.id,
      nombre: categoria.name,
      imagen: categoria.imageUrl,
      productos: catalogo.products.filter(producto => producto.categoryId === categoria.id),
    }))
    const sueltos = catalogo.products.filter(producto => !producto.categoryId)
    return (sueltos.length
      ? [...porCategoria, { id: 'otros', nombre: 'Más productos', imagen: null, productos: sueltos }]
      : porCategoria
    ).filter(grupo => grupo.productos.length > 0)
  }, [catalogo])

  // Buscar deja de lado las secciones: quien escribe «pepperoni» quiere una
  // lista de resultados, no recorrer cuatro categorías para encontrarlos.
  const resultados = useMemo(() => {
    const texto = normalizar(busqueda.trim())
    if (!texto || !catalogo) return null
    return catalogo.products.filter(producto =>
      normalizar(`${producto.name} ${producto.description || ''}`).includes(texto))
  }, [busqueda, catalogo])

  /**
   * La pestaña activa la decide el SCROLL, no solo el toque. Sin esto, quien
   * recorre la carta con el pulgar ve «Pizzas» subrayado mientras mira las
   * bebidas, y la barra deja de explicar dónde está.
   *
   * La línea de lectura es una franja justo debajo de las pestañas: lo que la
   * cruza es lo que el cliente tiene delante.
   */
  useEffect(() => {
    if (!grupos.length || resultados) return
    // Qué secciones cruzan la línea de lectura. Vive dentro del efecto porque
    // no sobrevive a él: al cambiar la carta se empieza a contar de cero.
    const visibles = new Set<string>()
    const observador = new IntersectionObserver(
      entradas => {
        for (const entrada of entradas) {
          const id = entrada.target.getAttribute('data-categoria')
          if (!id) continue
          if (entrada.isIntersecting) visibles.add(id)
          else visibles.delete(id)
        }
        // El conjunto se mantiene al día siempre; lo que se congela durante un
        // salto es solo el subrayado, para que no parpadee por el camino.
        if (saltando.current) return
        const primera = grupos.find(grupo => visibles.has(grupo.id))
        if (primera) setCategoriaActiva(primera.id)
      },
      { rootMargin: '-132px 0px -66% 0px' },
    )
    for (const grupo of grupos) {
      const nodo = secciones.current[grupo.id]
      if (nodo) observador.observe(nodo)
    }
    return () => observador.disconnect()
  }, [grupos, resultados])

  // La pestaña activa se trae a la vista sola: con seis categorías, la que
  // manda puede haber quedado fuera de la pantalla por la derecha.
  useEffect(() => {
    if (!categoriaActiva) return
    pestanas.current[categoriaActiva]?.scrollIntoView({
      behavior: 'smooth', inline: 'center', block: 'nearest',
    })
  }, [categoriaActiva])

  /**
   * Un adicional entra al carrito como LÍNEA PROPIA. Se resuelve contra el
   * catálogo —no contra lo que venga en la recomendación— porque el precio y
   * la disponibilidad mandan desde el producto, igual que si se pidiera solo.
   *
   * Si el producto trae obligatorios no se puede agregar de un toque: se abre
   * su ficha para completarlos, que es lo que la base va a exigir igual.
   */
  const agregarAdicional = useCallback((productId: string) => {
    const producto = catalogo?.products.find(item => item.id === productId)
    if (!producto || !producto.available) return

    const obligatorios = producto.optionGroups.some(
      grupo => grupo.required || grupo.minSelectable > 0,
    )
    if (obligatorios || producto.hasVariants) return setElegido(producto)

    setLineas(actuales => addLine(actuales, {
      key: lineKey(producto, null, [], '', []),
      product: producto,
      variant: null,
      extras: [],
      options: [],
      quantity: 1,
      note: '',
      unitPrice: unitPrice(producto, null, [], []),
    }))
  }, [catalogo])

  const irACategoria = (id: string) => {
    saltando.current = true
    setCategoriaActiva(id)
    setBusqueda('')
    secciones.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // Lo que tarda el desplazamiento suave en llegar. Al soltarlo, el
    // observador retoma el mando desde donde quedó el scroll.
    window.setTimeout(() => { saltando.current = false }, 700)
  }

  const confirmar = useCallback(async (datos: {
    fulfillment: Fulfillment
    addressId: string | null
    name: string
    paymentMethod: PaymentMethod
    deliveryNotes: string | null
  }) => {
    setEnviando(true)
    setError(null)
    try {
      // Una clave POR CARRITO, no por intento: si el envío falla y se reintenta
      // —o el cliente toca «Confirmar» dos veces— el servidor devuelve el mismo
      // pedido en vez de crear dos comandas. Se renueva al vaciar el carrito,
      // porque ese ya es otro pedido.
      // ⚠️ `randomId` y NO `crypto.randomUUID`: esa función no existe en los
      // WebView viejos de Android —justo los que abre WhatsApp en teléfonos
      // modestos— y aquí no degradaba, REVENTABA: la excepción salta antes de
      // llamar al servidor, así que el cliente no podía pedir. El respaldo ya
      // estaba escrito en `lib/session.ts` para el id de dispositivo; esto
      // solo lo usa.
      if (!claveDelPedido.current) claveDelPedido.current = randomId()
      const pedido = await createOrder(slug, {
        lines: lineas, ...datos, idempotencyKey: claveDelPedido.current,
      })
      // El total oficial llega en la respuesta (incluye el envío que calculó
      // la base); el del carrito solo sirve de respaldo si no viniera.
      // El id se guarda en el navegador para detectar al abrir si quedó un
      // pago pendiente. Ya no alimenta ninguna pestaña: la lista de pedidos la
      // trae el servidor en la pantalla de Cuenta.
      if (pedido.id) {
        try { localStorage.setItem(`pedido:${slug}`, String(pedido.id)) } catch { /* modo privado */ }
      }
      // El resumen se arma ANTES de vaciar: después ya no hay carrito del que
      // sacarlo, y volver a pedírselo al servidor sería un viaje por algo que
      // se acaba de tener en la mano.
      const resumen: PedidoRecibido = {
        id: String(pedido.id || ''),
        order_number: pedido.order_number ?? null,
        total: pedido.total ?? null,
        subtotal: cartTotal(lineas),
        envio: needsAddress(datos.fulfillment) ? (business.deliveryFee || 0) : 0,
        // El detalle sale de `lib/resumen.ts`, el mismo sitio que lo arma
        // cuando el cliente VUELVE a un pedido guardado: dos caminos, una
        // sola forma. El importe se pone aquí porque el dinero no se calcula
        // en ese módulo, ni siquiera para pintar.
        lineas: resumenDesdeCarrito(lineas).map((resumen, indice) => ({
          ...resumen,
          importe: lineTotal(lineas[indice]),
        })),
      }
      setLineas([])
      claveDelPedido.current = null
      setCarritoAbierto(false)
      // ⚠️ Pasa por «recibido» y no directo al seguimiento. La pantalla que se
      // retiró el 2026-08-08 mentía —decía «confirmado» cuando el negocio ni lo
      // había mirado— y era estática. Esta dice «recibido», que es verdad
      // siempre, y no promete nada que pueda cambiar: lo que cambia está en el
      // seguimiento, a un toque.
      if (pedido.id) {
        setRecienHecho({
          pedido: resumen,
          nombre: datos.name,
          transferencia: datos.paymentMethod === 'transferencia',
        })
      }
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError(error instanceof Error ? error.message : 'No pudimos enviar tu pedido')
    } finally {
      setEnviando(false)
    }
  }, [slug, lineas, business.deliveryFee, onFalloEnlace])

  /**
   * Guarda una dirección nueva y DEVUELVE su id.
   *
   * ⚠️ El id no es un extra: quien acaba de escribir una dirección en el
   * checkout la está escribiendo para ESTE pedido. Como no se seleccionaba,
   * seguía elegida la anterior —la marcada por defecto, o la primera de la
   * lista— y el pedido salía a la casa vieja. La app decía «guardada» y el
   * repartidor iba a otro sitio.
   */
  const nuevaDireccion = useCallback(async (datos: NuevaDireccion) => {
    try {
      const creada = await createAddress(slug, datos)
      setMe(await getMe(slug))
      return creada?.id || null
    } catch (error) {
      if (await onFalloEnlace(error)) return null
      setError('No pudimos guardar la dirección')
      return null
    }
  }, [slug, onFalloEnlace])

  const borrarDireccion = useCallback(async (addressId: string) => {
    try {
      await deleteAddress(slug, addressId)
      setMe(await getMe(slug))
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError('No pudimos eliminar la dirección')
    }
  }, [slug, onFalloEnlace])

  /**
   * El pin de una dirección que ya existía.
   *
   * Si falla NO se corta nada: la dirección sigue guardada y el pedido se puede
   * hacer igual, solo que el repartidor irá con el texto. El pin es una ayuda,
   * no un requisito.
   */
  const ubicarDireccion = useCallback(async (addressId: string, ubicacion: Ubicacion) => {
    try {
      await setAddressLocation(slug, addressId, {
        latitude: ubicacion.latitude,
        longitude: ubicacion.longitude,
        accuracy: ubicacion.accuracy,
      })
      setMe(await getMe(slug))
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError('No pudimos guardar la ubicación')
    }
  }, [slug, onFalloEnlace])

  if (enCuenta) {
    return (
      <Suspense fallback={null}>
        <Account
          slug={slug}
          me={me}
          onVolver={() => setEnCuenta(false)}
          onBorrarDireccion={borrarDireccion}
        />
      </Suspense>
    )
  }

  // ⚠️ Un pedido a medio pagar YA NO secuestra la app al abrirla. Antes se
  // entraba directo aquí; ahora se abre la tienda con un aviso donde estaban
  // los círculos de categoría, y se entra tocándolo. El recordatorio queda a
  // la vista en el sitio más visible, y quien abrió la app para mirar la carta
  // puede mirarla.
  if (pagoPendiente && abrirPago) {
    return (
      <OrderPlaced
        slug={slug}
        business={business}
        pedido={{
          id: pagoPendiente.id,
          order_number: pagoPendiente.order_number,
          total: pagoPendiente.total,
          subtotal: Number(pagoPendiente.total) || 0,
          envio: 0,
          // Lo que pidió, tal como lo congeló la base —y ya agrupado por el
          // servidor—. Aquí no hay carrito del que sacarlo: el cliente cerró
          // la app hace rato.
          lineas: resumenDesdePedido(pagoPendiente.order_items || []),
        }}
        nombre=""
        entrega={pagoPendiente.fulfillment || entrega}
        transferencia
        volviendo
        onVolver={() => setAbrirPago(false)}
      />
    )
  }

  // ⚠️ Aquí había una pantalla de SEGUIMIENTO —línea de tiempo, estados,
  // despedida— y se retiró el 2026-08-12. El pedido se sigue por WhatsApp, con
  // los tres avisos de `services/order-notify.ts`, que es donde el cliente ya
  // está mirando: no hay que enseñarle a volver a una app para enterarse de
  // algo que le llega solo. La despedida de Umbani no se perdió, viaja idéntica
  // en el aviso de `completado`. Lo que queda en la app es la lista de Cuenta,
  // que dice el estado en texto para quien quiera comprobarlo.
  if (recienHecho) {
    return (
      <OrderPlaced
        slug={slug}
        business={business}
        pedido={recienHecho.pedido}
        nombre={recienHecho.nombre}
        entrega={entrega}
        transferencia={recienHecho.transferencia}
        onVolver={() => setRecienHecho(null)}
      />
    )
  }

  if (!catalogo) return null

  // Con el envío ya incluido: el modo de entrega se elige arriba, así que la
  // barra puede decir el número final en vez de uno que crecerá al abrir el
  // carrito. Es el mismo que enseña el desglose del checkout.
  const total = orderTotal(lineas, entrega, business.deliveryFee)
  const unidades = cartCount(lineas)
  const horario = catalogo.todaysHours
  /* La dirección que se enseña arriba. La primera guardada es la que usa el
     checkout por defecto, así que es la que hay que mostrar: enseñar otra
     prometería una entrega donde no va a ir. Sin ninguna guardada NO se
     inventa un «Casa» que no existe — la barra invita a elegir. */
  const direccionActiva = me?.addresses?.[0]?.address || null
  const portada = portadaRota ? null : foto(business.coverUrl, 'portada')
  const abierto = status === 'abierta'

  // ── La tarjeta de la rejilla ──────────────────────────────────────────────
  // Foto arriba a sangre y el `+` sobre ella. Se declara una vez porque la usan
  // la carta y los resultados de búsqueda, y dos copias se desincronizan.
  const tarjeta = (producto: Product) => (
    <div
      key={producto.id}
      className={`superficie relative rounded-(--radius-tarjeta) shadow-tarjeta transition ${
        producto.available ? '' : 'opacity-55'
      }`}
    >
      {/* ⚠️ La foto y los textos NO van dentro de un botón, y el `+` tampoco:
          serían botones anidados, que es HTML inválido. Lo que abre la ficha
          es una CAPA sobre la tarjeta entera (`absolute inset-0`), declarada
          ANTES que el `+` para que el `+` quede encima sin pelear por
          z-index. Así se puede tocar la tarjeta completa y el `+` sigue
          haciendo lo suyo. */}
      <div className="overflow-hidden rounded-(--radius-tarjeta)">
        <div className="relative h-36">
          <Foto url={producto.imageUrl} alto="h-36" uso="tarjeta" nombre={producto.name} />
          {!producto.available && (
            <span className="absolute top-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[10.5px] font-bold text-white">
              Agotado
            </span>
          )}

          {/* El `+` agrega de un toque lo que no exige elegir nada. Si el
              producto trae obligatorios, `agregarAdicional` abre su ficha en
              vez de meterlo a ciegas: la base lo rechazaría igual.

              ⚠️ Va DENTRO de la foto, no a caballo de su borde: montado en el
              borde se comía la primera línea del nombre —«Doble Cheese
              Burguer» quedaba debajo del círculo—. Y no es un botón anidado:
              esto es un `div`, y la capa que abre la ficha es hermana suya.
              El `z-10` es lo que lo mantiene por encima de esa capa, que va
              después en el DOM. */}
          {producto.available && (
            <button
              onClick={() => agregarAdicional(producto.id)}
              disabled={!puedePedir}
              aria-label={`Agregar ${producto.name}`}
              className="acento absolute right-2.5 bottom-2.5 z-10 flex size-11 items-center justify-center rounded-full text-[22px] leading-none font-black shadow-acento transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
            >
              +
            </button>
          )}
        </div>
        <div className="px-3 pt-3 pb-3.5">
          <p className="text-[14.5px] leading-snug font-bold tracking-tight line-clamp-2">
            {producto.name}
          </p>
          {producto.description && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-snug texto-cuerpo">
              {producto.description}
            </p>
          )}
          {/* El precio en TINTA, no en el naranja de la referencia: allí ese
              color señala una rebaja, y aquí no hay descuentos que señalar
              —`Product` no lleva precio promocional—. Naranja permanente
              sería color sin significado, y además `--ascua` da 3,49:1 sobre
              blanco, por debajo del 4,5 que exige AA para texto. */}
          <p className="mt-2 text-[19px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">
            {producto.hasVariants && (
              <span className="text-[11px] font-semibold texto-tenue">desde </span>
            )}
            {money(producto.priceFrom)}
          </p>
        </div>
      </div>

      <button
        onClick={() => setElegido(producto)}
        aria-label={`Ver ${producto.name}`}
        className="absolute inset-0 rounded-(--radius-tarjeta)"
      />

    </div>
  )

  return (
    <div className="mx-auto min-h-full max-w-lg pb-32">
      {/* ══ EL HÉROE ════════════════════════════════════════════════════
          Portada a sangre y ALTA, con el logo del negocio centrado
          solapando el borde. Es la ficha de local de cualquier app de
          reparto grande, y sustituye al banner pequeño del 2026-08-25 por
          decisión del dueño (2026-08-26): aquel confirmaba dónde estabas,
          pero no daba ninguna sensación de marca.

          ⚠️ La foto llega al borde FÍSICO de la pantalla a propósito
          —`viewport-fit=cover` en el index.html—, así que el héroe pasa por
          debajo de la barra de estado y solo el botón de volver respeta el
          `safe-area`. Si el héroe respetara el inset quedaría una franja
          del color del fondo sobre la foto, que es justo lo que se ve roto.

          ⚠️ Sin portada NO se deja un hueco gris: va un degradado del color
          del negocio. Hoy Monster Pizza sí tiene una cargada. */}
      <header className="relative">
        <div className="relative h-56 overflow-hidden rounded-b-4xl">
          {portada
            ? (
                <img
                  src={portada}
                  alt=""
                  // Si el dueño la borró de Cloudinary se retira sola y queda
                  // el degradado de marca: el icono de imagen rota no puede
                  // ser la primera impresión de la tienda.
                  onError={() => setPortadaRota(true)}
                  className="size-full object-cover"
                />
              )
            : (
                <div
                  className="size-full"
                  style={{
                    backgroundImage:
                      'linear-gradient(150deg, color-mix(in srgb, var(--acento) 90%, black) 0%,'
                      + ' color-mix(in srgb, var(--acento) 40%, black) 100%)',
                  }}
                />
              )}
          {/* El velo no es adorno: sin él, una portada clara deja el botón
              de volver invisible, y el negocio elige qué sube. */}
          <div className="absolute inset-0 bg-linear-to-b from-black/45 via-black/5 to-black/25" />

          {onVolver && (
            <button
              onClick={onVolver}
              aria-label="Volver"
              className="absolute left-4 top-[calc(env(safe-area-inset-top)+0.75rem)] flex size-10 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition active:scale-95"
            >
              <ChevronLeft size={20} />
            </button>
          )}
        </div>

        {/* El logo, CENTRADO y solapando el borde del héroe. El anillo es
            del color de la superficie, no blanco fijo, para que el recorte
            siga siendo limpio si algún día la superficie cambia. */}
        {/* ⚠️ `relative z-10`: sin contexto de apilado propio, el héroe —que es
            `relative`— se pinta ENCIMA y le come la mitad de arriba al logo.
            El margen negativo solapa, pero no decide quién va delante. */}
        <div className="relative z-10 -mt-12 flex justify-center">
          <div className="superficie size-24 rounded-full p-1 shadow-alzada">
            {business.logoUrl
              ? (
                  <img
                    src={foto(business.logoUrl, 'miniatura') || undefined}
                    alt=""
                    className="size-full rounded-full object-cover"
                  />
                )
              : (
                  <span className="marcador flex size-full items-center justify-center rounded-full text-[2rem] leading-none font-black opacity-40 select-none">
                    {business.name.trim().charAt(0).toUpperCase()}
                  </span>
                )}
          </div>
        </div>
      </header>

      {/* ── Quién es, y si atiende ahora ───────────────────────────────
          Nombre centrado bajo el logo y, debajo, el ESTADO con su horario.

          ⚠️ Aquí la referencia pinta «★ 4,8 (1.652) · FoodyPro+ · 0,1 mi» y
          NADA de eso existe en este proyecto: no hay reseñas, ni programa
          de fidelidad, ni distancia. Se toma el SITIO y la jerarquía —una
          línea de metadatos centrada bajo el nombre— y se llena con lo
          único que ahí es verdad: si el local está abierto y hasta qué
          hora. Inventar un 4,8 sería el control que no controla nada, pero
          además mintiéndole al cliente. */}
      <div className="px-5 pt-3 text-center">
        <h1 className="titulo-xl">{business.name}</h1>
        {business.slogan && (
          <p className="mt-1.5 text-[13.5px] texto-cuerpo">{business.slogan}</p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-[13px]">
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-bold ${
              abierto ? 'bg-emerald-50 text-emerald-700' : 'bg-black/5 texto-cuerpo'
            }`}
          >
            <span className={`size-1.5 rounded-full ${abierto ? 'bg-emerald-500' : 'bg-current opacity-50'}`} />
            {abierto ? 'Abierto' : 'Cerrado'}
          </span>
          {horario && (
            <span className="texto-cuerpo tabular-nums">
              {horario.open} – {horario.close}
            </span>
          )}
        </div>
      </div>

      {/* ── Cómo llega, y a dónde ──────────────────────────────────────
          La tarjeta de servicio de la referencia, con NUESTROS datos
          reales: el tiempo sale de las dos columnas que pone el dueño, el
          envío de `delivery_fee` y el mínimo de `min_order_amount`.

          ⚠️ Aquí VIVE el selector Entrega/Retiro, que es la misma decisión
          que la del carrito, no dos. Ya estuvo a punto de perderse una vez
          al rediseñar la cabecera: sin él el cliente paga envío sin poder
          elegir retiro. La referencia lo dibuja igual —dos iconos de modo
          dentro de la píldora—, así que el sitio es el suyo.

          ⚠️ La dirección solo aparece en ENTREGA: en retiro la fila entera
          desaparece en vez de pedir un dato que nadie va a usar. */}
      <div className="px-4 pt-4">
        <div className="superficie rounded-[1.75rem] shadow-tarjeta">
          <div className="flex items-center gap-3 p-2.5">
            <div className="flex shrink-0 gap-1 rounded-full bg-black/5 p-1">
              {([
                { id: 'delivery' as const, icono: Bike, etiqueta: 'Entrega a domicilio' },
                { id: 'pickup' as const, icono: ShoppingBag, etiqueta: 'Retiro en el local' },
              ]).map(({ id, icono: Icono, etiqueta }) => (
                <button
                  key={id}
                  onClick={() => setEntrega(id)}
                  aria-label={etiqueta}
                  aria-pressed={entrega === id}
                  className={`flex size-11 items-center justify-center rounded-full transition active:scale-95 ${
                    entrega === id ? 'acento shadow-acento' : 'texto-cuerpo'
                  }`}
                >
                  <Icono size={18} />
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1 pr-1">
              <p className="titulo-m">
                {entrega === 'delivery' ? 'Entrega' : 'Retiro'}
                {' · '}
                {rangoDeEspera(
                  business.prepTimeMinutes
                  + (entrega === 'delivery' ? business.deliveryExtraMinutes : 0),
                )}
              </p>
              <p className="caption mt-0.5 texto-cuerpo">
                {entrega === 'delivery'
                  ? `Envío ${business.deliveryFee > 0 ? money(business.deliveryFee) : 'gratis'}`
                  : 'Sin costo de envío'}
                {business.minOrderAmount > 0 && ` · Mínimo ${money(business.minOrderAmount)}`}
              </p>
            </div>
          </div>

          {entrega === 'delivery' && (
            <button
              onClick={() => setEnCuenta(true)}
              className="flex w-full items-center gap-2.5 border-t borde-tema px-4 py-3 text-left transition active:bg-black/5"
            >
              <MapPin size={17} className="shrink-0 texto-cuerpo" />
              <span className="min-w-0 flex-1">
                <span className="caption block texto-tenue">Entregar en</span>
                <span className="block truncate text-[14px] font-bold tracking-tight">
                  {direccionActiva || 'Elige tu dirección'}
                </span>
              </span>
              <ChevronDown size={18} className="shrink-0 texto-tenue" />
            </button>
          )}
        </div>
      </div>

      {!puedePedir && (
        <div className="px-4 pt-3">
          <Aviso tono="alerta">
            <span className="flex items-center gap-2">
              <Clock size={15} />
              {status === 'cerrada'
                ? 'Ahora está cerrado. Puedes ver la carta y volver cuando abra.'
                : 'La tienda no está recibiendo pedidos en este momento.'}
            </span>
          </Aviso>
        </div>
      )}

      {/* ⚠️ Aquí había una fila de CÍRCULOS de categoría, y se retiró: pintaba
          exactamente la misma lista (`grupos`) que las pestañas pegajosas de
          justo debajo. Dos veces lo mismo, una encima de la otra.

          El sitio se gana lo que vale: es lo primero que se ve bajo el
          buscador, y ahí va el aviso del pago pendiente. */}
      {pagoPendiente && (
        <div className="px-4 pt-4">
          <button
            onClick={() => setAbrirPago(true)}
            // Sin `dark:`. Esta app no tiene modo oscuro —`color-scheme: light`
            // fijo en `index.css`—, pero la media query SÍ se dispara con el
            // teléfono en oscuro: quedaba un ámbar al 10 % sobre página clara,
            // o sea el aviso más importante de la portada casi sin fondo.
            className="flex w-full items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3.5 text-left shadow-tarjeta transition active:scale-[0.99]"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
              <Clock size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-bold">
                Falta tu comprobante
              </span>
              <span className="block text-[12.5px] texto-tenue">
                Tu pedido #{pagoPendiente.order_number} está guardado. Toca para pagarlo.
              </span>
            </span>
            <ChevronLeft size={18} className="shrink-0 rotate-180 texto-tenue" />
          </button>
        </div>
      )}

      {/* ── Buscador ───────────────────────────────────────────────────
          Baja hasta aquí, justo encima de la carta que busca. Estaba sobre
          la portada para que quien ya sabe lo que quiere no tuviera que
          pasar la foto; con el héroe nuevo eso partía la marca en dos —el
          logo y el nombre quedaban debajo de un campo de formulario—. Aquí
          sigue estando antes de un solo scroll, y ahora se lee como
          «buscar en esta carta», que es lo que hace. */}
      <div className="px-4 pt-4">
        <div className="superficie flex items-center gap-2.5 rounded-2xl px-4 py-3.5 shadow-tarjeta">
          <input
            ref={buscador}
            value={busqueda}
            onChange={event => setBusqueda(event.target.value.slice(0, 60))}
            placeholder={`Buscar en ${business.name}`}
            aria-label="Buscar productos"
            className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:texto-tenue"
          />
          {busqueda
            ? (
                <button onClick={() => setBusqueda('')} aria-label="Borrar búsqueda" className="shrink-0 texto-tenue">
                  <X size={18} />
                </button>
              )
            : <Search size={18} className="shrink-0 texto-tenue" />}
        </div>
      </div>

      {/* ── Pestañas de categoría, pegadas arriba ───────────────────────
          ⚠️ La activa va en TINTA, texto y subrayado, como la referencia —
          no en el color del negocio. El subrayado era `border-(--acento)`:
          con el lima de la plataforma eso es 1,19:1 contra el blanco, o
          sea una pestaña «activa» sin marca visible. Un elemento gráfico
          que porta información necesita 3:1, y el acento del negocio no lo
          garantiza porque lo elige él. */}
      {!resultados && grupos.length > 1 && (
        <nav className="superficie sticky top-0 z-30 mt-4 border-b borde-tema">
          <div className="sin-barra flex gap-1 overflow-x-auto px-4">
            {grupos.map(grupo => (
              <button
                key={grupo.id}
                ref={(nodo) => { pestanas.current[grupo.id] = nodo }}
                onClick={() => irACategoria(grupo.id)}
                className={`shrink-0 border-b-[3px] px-3 py-3.5 text-[14.5px] font-bold tracking-tight whitespace-nowrap transition ${
                  categoriaActiva === grupo.id
                    ? 'border-(--tinta) text-(--texto)'
                    : 'border-transparent texto-tenue'
                }`}
              >
                {grupo.nombre}
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* ── Resultados de búsqueda ── */}
      {resultados && (
        <section className="px-4 pt-5">
          <h2 className="mb-3 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            {resultados.length
              ? `${resultados.length} ${resultados.length === 1 ? 'resultado' : 'resultados'}`
              : 'Sin resultados'}
          </h2>
          {resultados.length
            ? <div className="grid grid-cols-2 gap-3">{resultados.map(tarjeta)}</div>
            : (
                <p className="py-10 text-center text-[14px] texto-tenue">
                  No encontramos «{busqueda.trim()}».
                  <br />
                  Prueba con otra palabra o mira la carta completa.
                </p>
              )}
        </section>
      )}

      {/* ── Carta ── */}
      {!resultados && grupos.map((grupo, indice) => (
        <section
          key={grupo.id}
          data-categoria={grupo.id}
          ref={(nodo) => { secciones.current[grupo.id] = nodo }}
          className="scroll-mt-14"
        >
          {/* La banda separa una sección de otra sin que haya que leer nada.
              La primera no la lleva: iría pegada a las pestañas. */}
          {indice > 0 && <div className="banda h-2.5" />}
          <div className="px-4 pt-5">
            <h2 className="mb-3.5 text-[22px] leading-none font-extrabold tracking-tight">
              {grupo.nombre}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {grupo.productos.map(tarjeta)}
            </div>
          </div>
        </section>
      ))}

      {!grupos.length && (
        <p className="px-4 py-16 text-center text-[15px] texto-tenue">
          El negocio todavía no cargó su carta.
        </p>
      )}

      {/* ── Barra inferior ── */}
      {/* Tres destinos porque tres son los que tienen a dónde ir. El seguimiento
          del pedido y la cuenta del cliente todavía no existen, y una pestaña
          que no lleva a ninguna parte se siente rota. Cuando existan, entran
          aquí sin tocar nada más. */}
      <nav className="superficie fixed inset-x-0 bottom-0 z-40 border-t borde-tema">
        <div className="mx-auto flex max-w-lg items-stretch px-2 pt-1.5 pb-seguro">
          {([
            {
              id: 'inicio',
              icono: Home,
              texto: 'Inicio',
              accion: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
            },
            {
              id: 'buscar',
              icono: Search,
              texto: 'Buscar',
              accion: () => {
                buscador.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                buscador.current?.focus()
              },
            },
            {
              id: 'carrito',
              icono: ShoppingCart,
              texto: 'Carrito',
              accion: () => unidades > 0 && setCarritoAbierto(true),
              contador: unidades,
            },
            // ⚠️ Antes decía «Pedido» y abría el ÚLTIMO directamente. Servía
            // mientras solo hubiera uno del que preocuparse; quien ha pedido
            // cinco veces no tiene «un pedido», tiene un historial. Y desde
            // que la pantalla de pago dejó de ofrecer atajo al seguimiento,
            // hacía falta una puerta estable para mirar cómo va lo de uno.
            {
              id: 'cuenta',
              icono: ClipboardList,
              texto: 'Cuenta',
              accion: () => setEnCuenta(true),
            },
          ]).map(({ id, icono: Icono, texto, accion, contador }) => (
            <button
              key={id}
              onClick={accion}
              className="relative flex flex-1 flex-col items-center gap-1 py-1.5 text-[10.5px] font-bold"
            >
              <span className="relative">
                <Icono size={21} />
                {Boolean(contador) && (
                  <span className="acento absolute -top-1.5 -right-2.5 flex min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] leading-4.5 font-extrabold tabular-nums">
                    {contador}
                  </span>
                )}
              </span>
              {texto}
            </button>
          ))}
        </div>
      </nav>

      {/* ── Barra del carrito ── */}
      {/* Va por encima de la barra inferior: con algo en el carrito, cerrar el
          pedido es lo único que importa. */}
      {unidades > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-50 px-4 pt-2 pb-seguro">
          <button
            onClick={() => setCarritoAbierto(true)}
            className="tinta mx-auto flex w-full max-w-lg items-center justify-between rounded-[1.75rem] px-5 py-4 shadow-xl shadow-black/25 transition active:scale-[0.99]"
          >
            <span className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
              <span className="acento flex size-7 items-center justify-center rounded-full text-[12px] font-extrabold tabular-nums">
                {unidades}
              </span>
              Ver pedido
            </span>
            <span className="flex items-center gap-2 text-[19px] font-extrabold tracking-tight tabular-nums">
              {money(total)}
              <ShoppingCart size={18} />
            </span>
          </button>
        </div>
      )}

      <ProductSheet
        product={elegido}
        abierto={Boolean(elegido)}
        onCerrar={() => setElegido(null)}
        onAgregar={linea => setLineas(actuales => addLine(actuales, linea))}
        onAgregarSuelto={agregarAdicional}
        puedePedir={puedePedir}
      />

      <CartSheet
        paymentMethods={business.paymentMethods || []}
        abierta={carritoAbierto}
        onCerrar={() => setCarritoAbierto(false)}
        lines={lineas}
        onCantidad={(key, cantidad) => setLineas(actuales => setQuantity(actuales, key, cantidad))}
        me={me}
        puedePedir={puedePedir}
        enviando={enviando}
        error={error}
        deliveryFee={business.deliveryFee}
        minOrderAmount={business.minOrderAmount}
        entrega={entrega}
        onEntrega={setEntrega}
        onConfirmar={confirmar}
        onNuevaDireccion={nuevaDireccion}
        onUbicarDireccion={ubicarDireccion}
        onBorrarDireccion={borrarDireccion}
      />
    </div>
  )
}
