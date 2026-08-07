import { useState } from 'react'
import { Banknote, Bike, Landmark, MapPin, ShoppingBag, Trash2 } from 'lucide-react'
import { Aviso, Boton, Contador, Hoja } from './ui'
import { money } from '../lib/format'
import { cartTotal, lineTotal, needsAddress, orderTotal } from '../lib/cart'
import type { Address, CartLine, Fulfillment, Me, PaymentMethod } from '../lib/types'

// El carrito y el cierre del pedido, en una sola hoja.
//
// El total que se ve aquí es informativo. Al confirmar se mandan ids y
// cantidades, y el importe real lo devuelve el servidor: si el negocio cambió
// un precio hace un minuto, gana el suyo.

export default function CartSheet({
  abierta, onCerrar, lines, onCantidad, me, puedePedir, enviando, error, deliveryFee,
  entrega, onEntrega, onConfirmar, onNuevaDireccion,
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
  /**
   * Cómo lo recibe. Llega de fuera porque también se elige en la portada, y
   * las dos pantallas tienen que reflejar la MISMA decisión: con un estado
   * aquí dentro, elegir «Retiro» arriba y abrir el carrito volvía a «Entrega»
   * y el cliente pagaba un envío que había rechazado.
   */
  entrega: Fulfillment
  onEntrega: (entrega: Fulfillment) => void
  onConfirmar: (datos: {
    fulfillment: Fulfillment
    addressId: string | null
    name: string
    paymentMethod: PaymentMethod
  }) => void
  onNuevaDireccion: (datos: { label: string; address: string; reference: string }) => Promise<void>
}) {
  const [pago, setPago] = useState<PaymentMethod>('transferencia')
  const [direccionId, setDireccionId] = useState<string | null>(null)
  const [nombre, setNombre] = useState('')
  const [nuevaAbierta, setNuevaAbierta] = useState(false)
  const [nueva, setNueva] = useState({ label: 'Casa', address: '', reference: '' })
  const [guardando, setGuardando] = useState(false)

  const direcciones: Address[] = me?.addresses || []
  const elegida = direccionId || direcciones.find(item => item.is_default)?.id || direcciones[0]?.id || null
  const nombreFinal = (nombre || me?.name || '').trim()
  const faltaDireccion = needsAddress(entrega) && !elegida
  const faltaNombre = nombreFinal.length < 2

  const guardarDireccion = async () => {
    if (nueva.address.trim().length < 5) return
    setGuardando(true)
    try {
      await onNuevaDireccion(nueva)
      setNueva({ label: 'Casa', address: '', reference: '' })
      setNuevaAbierta(false)
    } finally {
      setGuardando(false)
    }
  }

  const opcionesEntrega = [
    { id: 'delivery' as const, icono: Bike, texto: 'A domicilio' },
    { id: 'pickup' as const, icono: ShoppingBag, texto: 'Yo lo recojo' },
  ]

  const opcionesPago = [
    {
      id: 'transferencia' as const,
      icono: Landmark,
      texto: 'Transferencia bancaria',
      detalle: 'Te mostramos la cuenta y subes tu comprobante.',
    },
    {
      id: 'efectivo' as const,
      icono: Banknote,
      texto: 'Efectivo al recibir',
      detalle: 'Pagas cuando llegue tu pedido.',
    },
  ]

  // Vista previa del envío. El importe que manda es el que calcula el servidor
  // al crear el pedido: aquí solo se anticipa para que nadie se lleve sorpresas.
  const subtotal = cartTotal(lines)
  const envio = needsAddress(entrega) ? deliveryFee : 0
  const total = orderTotal(lines, entrega, deliveryFee)

  return (
    <Hoja abierta={abierta} onCerrar={onCerrar} titulo="Tu pedido">
      <div className="space-y-6 p-4">
        {/* ── Lo que lleva ── */}
        <section className="space-y-3">
          {lines.map(linea => (
            <div key={linea.key} className="flex gap-3 border-b borde-tema pb-3 last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] leading-snug font-semibold">{linea.product.name}</p>
                {linea.variant && (
                  <p className="text-[13px] texto-tenue">{linea.variant.name}</p>
                )}
                {linea.extras.length > 0 && (
                  <p className="text-[12px] texto-tenue">
                    {linea.extras.map(extra => extra.name).join(' · ')}
                  </p>
                )}
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

        {/* ── Cómo lo recibe ── */}
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
                <button
                  key={direccion.id}
                  onClick={() => setDireccionId(direccion.id)}
                  className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${
                    elegida === direccion.id ? 'border-marca bg-marca-suave' : 'borde-tema'
                  }`}
                >
                  <MapPin size={17} className="mt-0.5 shrink-0 texto-tenue" />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold">{direccion.label}</span>
                    <span className="block text-[13px] texto-tenue">{direccion.address}</span>
                    {direccion.reference && (
                      <span className="block text-[12px] texto-tenue">{direccion.reference}</span>
                    )}
                  </span>
                </button>
              ))}

              {nuevaAbierta
                ? (
                    <div className="space-y-2 rounded-xl border borde-tema p-3">
                      <input
                        value={nueva.label}
                        onChange={event => setNueva({ ...nueva, label: event.target.value.slice(0, 40) })}
                        placeholder="Casa, Oficina…"
                        className="w-full rounded-lg border borde-tema bg-transparent px-3 py-2.5 text-[14px] outline-none focus:border-marca"
                      />
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
                      <Boton
                        variante="suave"
                        onClick={guardarDireccion}
                        disabled={guardando || nueva.address.trim().length < 5}
                      >
                        {guardando ? 'Guardando…' : 'Guardar dirección'}
                      </Boton>
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
                  pago === id ? 'border-(--acento) bg-(--acento-suave)' : 'borde-tema'
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
            value={nombre || me?.name || ''}
            onChange={event => setNombre(event.target.value.slice(0, 120))}
            placeholder="Tu nombre"
            className="w-full rounded-xl border borde-tema bg-transparent px-3.5 py-3 text-[14px] outline-none focus:border-marca"
          />
          {me?.phone && (
            <p className="mt-2 text-[12px] texto-tenue">
              Te contactamos al {me.phone} — el mismo de WhatsApp.
            </p>
          )}
        </section>

        {error && <Aviso tono="alerta">{error}</Aviso>}
      </div>

      <div className="superficie sticky bottom-0 border-t borde-tema px-4 pt-3 pb-seguro">
        <div className="mb-3 space-y-1.5">
          <div className="flex items-baseline justify-between text-[13.5px] texto-tenue">
            <span>Subtotal</span>
            <span className="tabular-nums">{money(subtotal)}</span>
          </div>
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
        <Boton
          onClick={() => onConfirmar({
            fulfillment: entrega, addressId: elegida, name: nombreFinal,
            paymentMethod: pago,
          })}
          disabled={!puedePedir || enviando || faltaDireccion || faltaNombre || !lines.length}
        >
          {enviando
            ? 'Enviando…'
            : faltaNombre
              ? 'Escribe tu nombre'
              : faltaDireccion
                ? 'Elige una dirección'
                : 'Confirmar pedido'}
        </Boton>
        <p className="mt-2.5 text-center text-[11.5px] texto-tenue">
          El negocio confirma tu pedido por WhatsApp y coordina el pago.
        </p>
      </div>
    </Hoja>
  )
}
