import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Clock, ShoppingCart } from 'lucide-react'
import { createAddress, createOrder, getCatalog, getMe } from '../lib/api'
import { addLine, cartCount, cartTotal, setQuantity } from '../lib/cart'
import { Aviso, Foto } from '../components/ui'
import { money } from '../lib/format'
import ProductSheet from '../components/ProductSheet'
import CartSheet from '../components/CartSheet'
import OrderDone from './OrderDone'
import type {
  Business, CartLine, Catalog, Fulfillment, Me, OrderResult, PaymentMethod, Product, StoreStatus,
} from '../lib/types'

// Flujo de comida, bebidas y retail: categorías → producto → carrito → pedido.
// Es el patrón que la gente ya tiene aprendido de las apps de delivery, y por
// eso no se inventa nada nuevo aquí.

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
    { order: OrderResult; total: number; pago: PaymentMethod } | null
  >(null)
  const [categoriaActiva, setCategoriaActiva] = useState<string | null>(null)
  const secciones = useRef<Record<string, HTMLElement | null>>({})

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
    return sueltos.length
      ? [...porCategoria, { id: 'otros', nombre: 'Más productos', imagen: null, productos: sueltos }]
      : porCategoria
  }, [catalogo])

  const irACategoria = (id: string) => {
    setCategoriaActiva(id)
    secciones.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const confirmar = useCallback(async (datos: {
    fulfillment: Fulfillment
    addressId: string | null
    name: string
    paymentMethod: PaymentMethod
  }) => {
    setEnviando(true)
    setError(null)
    try {
      const pedido = await createOrder(slug, { lines: lineas, ...datos })
      // El total oficial llega en la respuesta (incluye el envío que calculó
      // la base); el del carrito solo sirve de respaldo si no viniera.
      setHecho({ order: pedido, total: Number(pedido.total ?? cartTotal(lineas)), pago: datos.paymentMethod })
      setLineas([])
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
      />
    )
  }

  if (!catalogo) return null

  const total = cartTotal(lineas)
  const unidades = cartCount(lineas)

  return (
    <div className="mx-auto min-h-full max-w-lg pb-28">
      {/* ── Cabecera ── */}
      {/* Bloque de tinta con el nombre grande: es lo primero que confirma al
          cliente que abrió el sitio correcto. */}
      <header className="tinta sticky top-0 z-30 rounded-b-[1.75rem]">
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          {onVolver && (
            <button onClick={onVolver} aria-label="Volver" className="-ml-1 shrink-0">
              <ChevronLeft size={22} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[24px] leading-none font-extrabold tracking-tight">
              {business.name}
            </h1>
            {business.slogan && (
              <p className="mt-1 truncate text-[13px] opacity-70">{business.slogan}</p>
            )}
          </div>
          {unidades > 0 && (
            <span className="acento flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-extrabold tabular-nums">
              <ShoppingCart size={14} />
              {unidades}
            </span>
          )}
        </div>

        {/* Chips de categoría: el atajo a lo que el cliente vino a buscar. */}
        {grupos.length > 1 && (
          <div className="sin-barra flex gap-2 overflow-x-auto px-5 pb-4">
            {grupos.map(grupo => (
              <button
                key={grupo.id}
                onClick={() => irACategoria(grupo.id)}
                className={`shrink-0 rounded-full px-4 py-2 text-[13.5px] font-bold transition ${
                  categoriaActiva === grupo.id
                    ? 'acento'
                    : 'bg-white/10 text-white'
                }`}
              >
                {grupo.nombre}
              </button>
            ))}
          </div>
        )}
      </header>

      {!puedePedir && (
        <div className="px-4 pt-4">
          <Aviso tono="alerta">
            <span className="flex items-center gap-2">
              <Clock size={15} />
              {status === 'cerrada'
                ? 'Ahora está cerrado. Puedes ver la carta y pedir cuando abra.'
                : 'La tienda no está recibiendo pedidos en este momento.'}
            </span>
          </Aviso>
        </div>
      )}

      {/* ── Carta ── */}
      {grupos.map(grupo => (
        <section
          key={grupo.id}
          ref={(nodo) => { secciones.current[grupo.id] = nodo }}
          className="scroll-mt-32 px-4 pt-6"
        >
          <div className="mb-3.5 flex items-center gap-3">
            {grupo.imagen && (
              <img
                src={grupo.imagen}
                alt=""
                loading="lazy"
                className="size-11 rounded-2xl object-cover"
              />
            )}
            <h2 className="text-[26px] leading-none font-extrabold tracking-tight">{grupo.nombre}</h2>
          </div>

          <div className="space-y-3">
            {grupo.productos.map(producto => (
              <button
                key={producto.id}
                onClick={() => setElegido(producto)}
                className={`superficie flex w-full gap-3 overflow-hidden rounded-(--radius-tarjeta) text-left shadow-sm transition active:scale-[0.99] ${
                  producto.available ? '' : 'opacity-55'
                }`}
              >
                <span className="min-w-0 flex-1 py-4 pl-4">
                  <span className="block text-[16px] leading-snug font-bold tracking-tight">
                    {producto.name}
                  </span>
                  {producto.description && (
                    <span className="mt-1 block line-clamp-2 text-[13px] leading-snug texto-tenue">
                      {producto.description}
                    </span>
                  )}
                  <span className="mt-2.5 flex items-center gap-2">
                    <span className="text-[17px] font-extrabold tracking-tight">
                      {producto.hasVariants && (
                        <span className="text-[12px] font-semibold texto-tenue">desde </span>
                      )}
                      {money(producto.priceFrom)}
                    </span>
                    {!producto.available && (
                      <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] font-bold texto-tenue dark:bg-white/10">
                        Agotado
                      </span>
                    )}
                  </span>
                </span>
                <span className="w-32 shrink-0 p-2">
                  <span className="block overflow-hidden rounded-[1.15rem]">
                    <Foto url={producto.imageUrl} alto="h-full min-h-[112px]" nombre={producto.name} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {!grupos.length && (
        <p className="px-4 py-16 text-center text-[15px] texto-tenue">
          El negocio todavía no cargó su carta.
        </p>
      )}

      {/* ── Barra del carrito ── */}
      {unidades > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-4 pt-2 pb-seguro">
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
        onConfirmar={confirmar}
        onNuevaDireccion={nuevaDireccion}
      />
    </div>
  )
}
