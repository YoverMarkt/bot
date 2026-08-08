import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Clock, Home, Search, ShoppingBag, ShoppingCart, Bike, X } from 'lucide-react'
import { createAddress, createOrder, getCatalog, getMe } from '../lib/api'
import {
  ENTREGA_POR_DEFECTO, addLine, cartCount, cartTotal, lineKey, orderTotal, setQuantity, unitPrice,
} from '../lib/cart'
import { Aviso, Foto } from '../components/ui'
import { money, rangoDeEspera } from '../lib/format'
import ProductSheet from '../components/ProductSheet'
import CartSheet from '../components/CartSheet'
import OrderDone from './OrderDone'
import type {
  Business, CartLine, Catalog, Fulfillment, Me, OrderResult, PaymentMethod, Product, StoreStatus,
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
  const [hecho, setHecho] = useState<
    { order: OrderResult; total: number; pago: PaymentMethod; entrega: Fulfillment } | null
  >(null)
  const [categoriaActiva, setCategoriaActiva] = useState<string | null>(null)
  const [busqueda, setBusqueda] = useState('')
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
      if (!claveDelPedido.current) claveDelPedido.current = crypto.randomUUID()
      const pedido = await createOrder(slug, {
        lines: lineas, ...datos, idempotencyKey: claveDelPedido.current,
      })
      // El total oficial llega en la respuesta (incluye el envío que calculó
      // la base); el del carrito solo sirve de respaldo si no viniera.
      setHecho({
        order: pedido,
        total: Number(pedido.total ?? cartTotal(lineas)),
        pago: datos.paymentMethod,
        entrega: datos.fulfillment,
      })
      setLineas([])
      claveDelPedido.current = null
      setCarritoAbierto(false)
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError(error instanceof Error ? error.message : 'No pudimos enviar tu pedido')
    } finally {
      setEnviando(false)
    }
  }, [slug, lineas, onFalloEnlace])

  const nuevaDireccion = useCallback(async (datos: {
    label: string; address: string; reference: string
  }) => {
    try {
      await createAddress(slug, datos)
      setMe(await getMe(slug))
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError('No pudimos guardar la dirección')
    }
  }, [slug, onFalloEnlace])

  if (hecho) {
    return (
      <OrderDone
        slug={slug}
        business={business}
        order={hecho.order}
        resumen={{ titulo: 'Pedido', total: hecho.total }}
        paymentMethod={hecho.pago}
        fulfillment={hecho.entrega}
        onVolverAlMenu={() => setHecho(null)}
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
  const portada = portadaRota ? null : business.coverUrl
  const abierto = status === 'abierta'

  // ── La tarjeta de la rejilla ──────────────────────────────────────────────
  // Foto arriba a sangre y el `+` sobre ella. Se declara una vez porque la usan
  // la carta y los resultados de búsqueda, y dos copias se desincronizan.
  const tarjeta = (producto: Product) => (
    <div
      key={producto.id}
      className={`superficie relative overflow-hidden rounded-(--radius-tarjeta) shadow-sm transition ${
        producto.available ? '' : 'opacity-55'
      }`}
    >
      <button
        onClick={() => setElegido(producto)}
        className="block w-full text-left transition active:scale-[0.99]"
      >
        <span className="relative block">
          <Foto url={producto.imageUrl} alto="aspect-[4/3]" nombre={producto.name} />
          {!producto.available && (
            <span className="absolute top-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[10.5px] font-bold text-white">
              Agotado
            </span>
          )}
        </span>
        <span className="block px-3 pt-2.5 pb-3">
          <span className="block text-[14.5px] leading-snug font-bold tracking-tight line-clamp-2">
            {producto.name}
          </span>
          {producto.description && (
            <span className="mt-1 block line-clamp-2 text-[12px] leading-snug texto-tenue">
              {producto.description}
            </span>
          )}
          <span className="mt-2 block text-[16px] font-extrabold tracking-tight tabular-nums">
            {producto.hasVariants && (
              <span className="text-[11px] font-semibold texto-tenue">desde </span>
            )}
            {money(producto.priceFrom)}
          </span>
        </span>
      </button>

      {/* El `+` agrega de un toque lo que no exige elegir nada. Si el producto
          trae obligatorios, `agregarAdicional` abre su ficha en vez de meterlo
          a ciegas: la base lo rechazaría igual. */}
      {producto.available && (
        <button
          onClick={() => agregarAdicional(producto.id)}
          disabled={!puedePedir}
          aria-label={`Agregar ${producto.name}`}
          className="acento absolute right-2.5 bottom-2.5 flex size-11 items-center justify-center rounded-full text-[22px] leading-none font-black shadow-lg shadow-black/15 transition active:scale-95 disabled:opacity-40"
        >
          +
        </button>
      )}
    </div>
  )

  return (
    <div className="mx-auto min-h-full max-w-lg pb-32">
      {/* ── Portada del local ── */}
      {/* Lo primero que confirma al cliente que abrió el sitio correcto: quién
          es, si está abierto y cuánto cuesta que se lo lleven. */}
      <header className="tinta relative overflow-hidden rounded-b-[1.75rem] pt-seguro">
        {/* La foto del local, a sangre y detrás de todo. Sin portada la
            cabecera se queda como estaba —bloque de tinta— en vez de dejar un
            hueco: hoy ningún negocio tiene una cargada. */}
        {portada && (
          <>
            <img
              src={portada}
              alt=""
              // Si la imagen no carga —el dueño la borró de Cloudinary, o la
              // conexión falla— se retira en vez de dejar el icono de imagen
              // rota presidiendo la tienda. La cabecera vuelve a ser el bloque
              // de tinta, que es un estado digno.
              onError={() => setPortadaRota(true)}
              className="absolute inset-0 size-full object-cover"
            />
            {/* El degradado no es decoración: sin él, una foto clara deja el
                nombre blanco ilegible, y el negocio no controla qué sube. */}
            <div className="absolute inset-0 bg-linear-to-t from-black/85 via-black/55 to-black/25" />
          </>
        )}

        <div className={`relative px-5 pb-5 ${portada ? 'pt-24' : ''}`}>
        <div className="flex items-center gap-3">
          {onVolver && (
            <button onClick={onVolver} aria-label="Volver" className="-ml-1 shrink-0">
              <ChevronLeft size={22} />
            </button>
          )}
          {business.logoUrl && (
            <img
              src={business.logoUrl}
              alt=""
              className="size-14 shrink-0 rounded-2xl bg-white/10 object-cover ring-2 ring-white/25"
            />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[26px] leading-none font-extrabold tracking-tight">
              {business.name}
            </h1>
            {business.slogan && (
              <p className="mt-1.5 truncate text-[13px] opacity-70">{business.slogan}</p>
            )}
          </div>
        </div>

        {/* Estado y horario, juntos a propósito: «Cerrado» a secas deja al
            cliente sin saber cuándo volver. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px]">
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-bold ${
              abierto ? 'bg-emerald-400/20 text-emerald-300' : 'bg-white/15 text-white/70'
            }`}
          >
            <span className={`size-1.5 rounded-full ${abierto ? 'bg-emerald-400' : 'bg-white/50'}`} />
            {abierto ? 'Abierto' : 'Cerrado'}
          </span>
          {horario && (
            <span className="opacity-70 tabular-nums">
              {horario.open} – {horario.close}
            </span>
          )}
          {/* El tiempo del modo elegido: quien retira no espera lo que tarda
              el repartidor, y decirle lo mismo a los dos miente a uno. */}
          <span className="opacity-70 tabular-nums">
            ·
            {' '}
            {rangoDeEspera(
              business.prepTimeMinutes
              + (entrega === 'delivery' ? business.deliveryExtraMinutes : 0),
            )}
          </span>
        </div>

        {/* ── Cómo lo recibe ── */}
        {/* Se elige aquí y se respeta en el carrito: es la misma decisión, no
            dos. Cambia el envío que se suma al total y si se piden datos de
            dirección al cerrar el pedido. */}
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {([
            {
              id: 'delivery' as const,
              icono: Bike,
              texto: 'Entrega',
              detalle: business.deliveryFee > 0 ? money(business.deliveryFee) : 'Gratis',
            },
            { id: 'pickup' as const, icono: ShoppingBag, texto: 'Retiro', detalle: 'Gratis' },
          ]).map(({ id, icono: Icono, texto, detalle }) => (
            <button
              key={id}
              onClick={() => setEntrega(id)}
              aria-pressed={entrega === id}
              className={`flex items-center justify-center gap-2 rounded-2xl px-3 py-3 text-[13.5px] font-bold transition ${
                entrega === id ? 'acento' : 'border-2 border-white/20 text-white'
              }`}
            >
              <Icono size={16} />
              {texto}
              <span className={entrega === id ? 'opacity-70' : 'opacity-60'}>{detalle}</span>
            </button>
          ))}
        </div>
        </div>
      </header>

      {/* ── Buscador ── */}
      <div className="px-4 pt-4">
        <div className="superficie flex items-center gap-2.5 rounded-2xl border borde-tema px-4 py-3">
          <Search size={17} className="shrink-0 texto-tenue" />
          <input
            ref={buscador}
            value={busqueda}
            onChange={event => setBusqueda(event.target.value.slice(0, 60))}
            placeholder={`Buscar en ${business.name}`}
            aria-label="Buscar productos"
            className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:texto-tenue"
          />
          {busqueda && (
            <button onClick={() => setBusqueda('')} aria-label="Borrar búsqueda" className="shrink-0 texto-tenue">
              <X size={17} />
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

      {/* ── Categorías en círculos ── */}
      {/* El atajo visual de la portada. Las pestañas de abajo hacen el trabajo
          mientras se recorre la carta; esto es para el primer vistazo. */}
      {!resultados && grupos.length > 1 && (
        <div className="sin-barra mt-4 flex gap-4 overflow-x-auto px-4 pb-1">
          {grupos.map(grupo => (
            <button
              key={grupo.id}
              onClick={() => irACategoria(grupo.id)}
              className="flex w-16 shrink-0 flex-col items-center gap-1.5"
            >
              <span className="block size-16 overflow-hidden rounded-full">
                <Foto url={grupo.imagen} alto="h-16" nombre={grupo.nombre} />
              </span>
              <span className="line-clamp-2 text-center text-[11.5px] leading-tight font-semibold">
                {grupo.nombre}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── Pestañas de categoría, pegadas arriba ── */}
      {!resultados && grupos.length > 1 && (
        <nav className="superficie sticky top-0 z-30 mt-4 border-b borde-tema">
          <div className="sin-barra flex gap-1 overflow-x-auto px-4">
            {grupos.map(grupo => (
              <button
                key={grupo.id}
                ref={(nodo) => { pestanas.current[grupo.id] = nodo }}
                onClick={() => irACategoria(grupo.id)}
                className={`shrink-0 border-b-[3px] px-3 py-3 text-[14px] font-bold whitespace-nowrap transition ${
                  categoriaActiva === grupo.id
                    ? 'border-(--acento)'
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
        abierta={carritoAbierto}
        onCerrar={() => setCarritoAbierto(false)}
        lines={lineas}
        onCantidad={(key, cantidad) => setLineas(actuales => setQuantity(actuales, key, cantidad))}
        me={me}
        puedePedir={puedePedir}
        enviando={enviando}
        error={error}
        deliveryFee={business.deliveryFee}
        entrega={entrega}
        onEntrega={setEntrega}
        onConfirmar={confirmar}
        onNuevaDireccion={nuevaDireccion}
      />
    </div>
  )
}
