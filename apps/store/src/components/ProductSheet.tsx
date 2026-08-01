import { useMemo, useState } from 'react'
import { Boton, Contador, Foto, Hoja } from './ui'
import { money } from '../lib/format'
import { groupExtras, lineKey, unitPrice } from '../lib/cart'
import type { CartLine, Extra, Product, Variant } from '../lib/types'

// Detalle del producto: variantes, extras, nota y cantidad.
//
// La regla del límite de extras se aplica AQUÍ y también en el servidor. Aquí
// para que se entienda —el grupo se bloquea solo cuando llegas al máximo—, y
// allá porque es lo único que de verdad manda.

export default function ProductSheet({ product, abierto, onCerrar, onAgregar, puedePedir }: {
  product: Product | null
  abierto: boolean
  onCerrar: () => void
  onAgregar: (linea: CartLine) => void
  puedePedir: boolean
}) {
  const [variante, setVariante] = useState<Variant | null>(null)
  const [extras, setExtras] = useState<Extra[]>([])
  const [nota, setNota] = useState('')
  const [cantidad, setCantidad] = useState(1)

  // Al cambiar de producto se descarta lo elegido del anterior.
  const idActual = product?.id || ''
  const [ultimoId, setUltimoId] = useState(idActual)
  if (idActual !== ultimoId) {
    setUltimoId(idActual)
    setVariante(product?.variants[0] || null)
    setExtras([])
    setNota('')
    setCantidad(1)
  }

  const grupos = useMemo(() => groupExtras(product?.extras || []), [product])
  const precio = product ? unitPrice(product, variante, extras) : 0

  if (!product) return null

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
    onAgregar({
      key: lineKey(product, variante, extras, nota),
      product,
      variant: variante,
      extras,
      quantity: cantidad,
      note: nota.trim(),
      unitPrice: precio,
    })
    onCerrar()
  }

  const faltaVariante = product.hasVariants && !variante

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
          <Boton onClick={agregar} disabled={!puedePedir || faltaVariante || !product.available}>
            {!product.available
              ? 'Agotado'
              : faltaVariante
                ? 'Elige una opción'
                : `Agregar · ${money(precio * cantidad)}`}
          </Boton>
        </div>
      </div>
    </Hoja>
  )
}
