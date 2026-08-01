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
  Business, CartLine, Catalog, Fulfillment, Me, OrderResult, Product, StoreStatus,
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
  const [hecho, setHecho] = useState<{ order: OrderResult; total: number } | null>(null)
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
    fulfillment: Fulfillment; addressId: string | null; name: string
  }) => {
    setEnviando(true)
    setError(null)
    try {
      const pedido = await createOrder(slug, { lines: lineas, ...datos })
      setHecho({ order: pedido, total: cartTotal(lineas) })
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
      />
    )
  }

  if (!catalogo) return null

  const total = cartTotal(lineas)
  const unidades = cartCount(lineas)

  return (
    <div className="mx-auto min-h-full max-w-lg pb-28">
      {/* ── Cabecera ── */}
      <header className="superficie sticky top-0 z-30 border-b borde-tema">
        <div className="flex items-center gap-3 px-4 py-3">
          {onVolver && (
            <button onClick={onVolver} aria-label="Volver" className="-ml-1 shrink-0">
              <ChevronLeft size={22} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] leading-tight font-extrabold">{business.name}</h1>
            {business.slogan && (
              <p className="truncate text-[12.5px] texto-tenue">{business.slogan}</p>
            )}
          </div>
        </div>

        {/* Chips de categoría: el atajo a lo que el cliente vino a buscar. */}
        {grupos.length > 1 && (
          <div className="sin-barra flex gap-2 overflow-x-auto px-4 pb-3">
            {grupos.map(grupo => (
              <button
                key={grupo.id}
                onClick={() => irACategoria(grupo.id)}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${
                  categoriaActiva === grupo.id
                    ? 'bg-marca text-white'
                    : 'bg-black/5 dark:bg-white/10'
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
          <div className="mb-3 flex items-center gap-3">
            {grupo.imagen && (
              <img
                src={grupo.imagen}
                alt=""
                loading="lazy"
                className="size-11 rounded-xl object-cover"
              />
            )}
            <h2 className="text-[19px] font-extrabold tracking-tight">{grupo.nombre}</h2>
          </div>

          <div className="space-y-2.5">
            {grupo.productos.map(producto => (
              <button
                key={producto.id}
                onClick={() => setElegido(producto)}
                className={`superficie flex w-full gap-3 overflow-hidden rounded-2xl border borde-tema text-left transition active:scale-[0.99] ${
                  producto.available ? '' : 'opacity-55'
                }`}
              >
                <span className="min-w-0 flex-1 p-3.5">
                  <span className="block text-[15px] leading-snug font-bold">{producto.name}</span>
                  {producto.description && (
                    <span className="mt-0.5 block line-clamp-2 text-[13px] leading-snug texto-tenue">
                      {producto.description}
                    </span>
                  )}
                  <span className="mt-2 block text-[15px] font-extrabold">
                    {producto.hasVariants && (
                      <span className="text-[12px] font-semibold texto-tenue">desde </span>
                    )}
                    {money(producto.priceFrom)}
                    {!producto.available && (
                      <span className="ml-2 text-[12px] font-semibold texto-tenue">Agotado</span>
                    )}
                  </span>
                </span>
                <span className="w-28 shrink-0">
                  <Foto url={producto.imageUrl} alto="h-full min-h-[104px]" nombre={producto.name} />
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
            className="mx-auto flex w-full max-w-lg items-center justify-between rounded-2xl bg-marca px-5 py-4 text-white shadow-lg shadow-black/20 transition active:scale-[0.99]"
          >
            <span className="flex items-center gap-2.5 text-[15px] font-bold">
              <span className="flex size-6 items-center justify-center rounded-full bg-white/25 text-[12px] tabular-nums">
                {unidades}
              </span>
              Ver pedido
            </span>
            <span className="flex items-center gap-2 text-[17px] font-extrabold tabular-nums">
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
        onConfirmar={confirmar}
        onNuevaDireccion={nuevaDireccion}
      />
    </div>
  )
}
