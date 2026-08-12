import { Check, Clock, MessageCircle } from 'lucide-react'
import { Boton } from '../components/ui'
import PagoPendiente from '../components/PagoPendiente'
import { money, rangoDeEspera } from '../lib/format'
import type { Business, Fulfillment } from '../lib/types'

// ── EL PEDIDO ENTRÓ ────────────────────────────────────────────────────────
//
// El instante después de confirmar. Sirve para una cosa muy concreta: que el
// cliente sepa que su pedido LLEGÓ y con qué número reclamarlo, antes de
// pasar al seguimiento.
//
// ⚠️ Dice «recibido», nunca «confirmado», y esto no es una sutileza. Esta
// pantalla existió antes y se retiró el 2026-08-08 justamente por eso: decía
// «¡Pedido confirmado!» en el mismo instante de crearlo, cuando el estado real
// era `pendiente` y el negocio ni lo había mirado. Le prometía al cliente un
// compromiso que nadie había dado, y cuando el local rechazaba el pedido diez
// minutos después, la app ya le había dicho que sí.
//
// «Recibido» es verdad siempre: el pedido está en la base y el dueño lo tiene
// en su bandeja. Es además el primer hito de la línea de tiempo del
// seguimiento, así que las dos pantallas cuentan lo mismo.
//
// ⚠️ Y con transferencia ni siquiera eso basta: ese pedido nace en
// `esperando_pago` y lo que le toca al cliente es pagar, no esperar. Por eso
// el texto cambia — decirle «lo estamos preparando» a quien todavía no ha
// transferido es mandarlo a esperar sentado.
//
// Es ESTÁTICA a propósito, que fue la otra crítica de entonces: no consulta
// nada porque no promete nada que pueda cambiar. Todo lo que sí cambia vive en
// el seguimiento, a un toque de aquí.

export interface PedidoRecibido {
  id: string
  order_number?: number | string | null
  total?: number | string | null
  /** Lo que se pidió, tal como lo devolvió el servidor o el carrito local. */
  lineas: { nombre: string; cantidad: number; importe: number }[]
  envio: number
  subtotal: number
}

export default function OrderPlaced({
  slug, business, pedido, nombre, entrega, transferencia, volviendo, onSeguir, onVolver,
}: {
  slug: string
  business: Business
  pedido: PedidoRecibido
  nombre: string
  entrega: Fulfillment
  /** Si va a transferir, todavía falta su parte. */
  transferencia: boolean
  /**
   * `true` cuando el cliente VUELVE a un pedido que dejó sin pagar.
   *
   * Cambia el titular, y no es cosmético: «¡Gracias!» sobre un pedido que
   * lleva veinte minutos esperando el comprobante suena a que ya está todo
   * hecho, y es justo lo contrario — falta lo único que hace falta.
   */
  volviendo?: boolean
  onSeguir: () => void
  onVolver: () => void
}) {
  const numero = pedido.order_number ? `#${pedido.order_number}` : null
  // El MISMO cálculo que la portada: preparación, más el reparto solo si se lo
  // llevan. Quien retira no espera lo que tarda el repartidor.
  const espera = rangoDeEspera(
    business.prepTimeMinutes + (entrega === 'delivery' ? business.deliveryExtraMinutes : 0),
  )
  const total = Number(pedido.total) || pedido.subtotal + pedido.envio

  const telefono = String(business.phone || '').replace(/\D/g, '')
  const whatsapp = telefono
    ? `https://wa.me/${telefono}?text=${encodeURIComponent(
        `Hola, quiero consultar por mi pedido ${numero || ''}`.trim(),
      )}`
    : null

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col px-5 py-10">
      <div className="flex flex-1 flex-col items-center text-center">
        <div className={`flex size-16 items-center justify-center rounded-full text-white ${
          volviendo ? 'bg-amber-500' : 'bg-marca'
        }`}
        >
          {volviendo ? <Clock size={30} strokeWidth={2.5} /> : <Check size={32} strokeWidth={3} />}
        </div>

        <h1 className="mt-5 text-[26px] leading-tight font-extrabold tracking-tight">
          {volviendo
            ? 'Falta tu comprobante'
            : nombre ? `¡Gracias, ${nombre.split(' ')[0]}!` : '¡Gracias!'}
        </h1>
        <p className="mt-2 text-[14px] texto-tenue">
          {volviendo
            ? 'Tu pedido está guardado. En cuanto subas el comprobante, el local lo prepara.'
            : transferencia
              ? 'Recibimos tu pedido. Falta tu comprobante para que el local lo prepare.'
              : 'Tu pedido fue recibido correctamente.'}
        </p>

        <dl className="mt-7 w-full space-y-2.5">
          {numero && (
            <div className="flex items-center justify-between">
              <dt className="text-[13.5px] texto-tenue">Número de pedido</dt>
              <dd className="rounded-lg bg-marca-suave px-2.5 py-1 text-[14px] font-bold text-marca tabular-nums">
                {numero}
              </dd>
            </div>
          )}
          {espera && (
            <div className="flex items-center justify-between">
              <dt className="text-[13.5px] texto-tenue">Tiempo estimado</dt>
              <dd className="rounded-lg bg-black/5 px-2.5 py-1 text-[14px] font-semibold">
                {espera}
              </dd>
            </div>
          )}
        </dl>

        {/* El resumen es del CARRITO que se acaba de enviar: el servidor ya
            devolvió el total oficial, y ese es el que manda arriba del todo. */}
        {pedido.lineas.length > 0 && (
          <section className="mt-7 w-full text-left">
            <h2 className="mb-2.5 text-[13px] font-bold tracking-wide uppercase texto-tenue">
              Resumen del pedido
            </h2>
            <div className="space-y-2">
              {pedido.lineas.map((linea, indice) => (
                <div key={indice} className="flex items-baseline justify-between gap-3 text-[14px]">
                  <span className="min-w-0">
                    <span className="texto-tenue">{linea.cantidad}× </span>
                    {linea.nombre}
                  </span>
                  <span className="shrink-0 tabular-nums">{money(linea.importe)}</span>
                </div>
              ))}
              {pedido.envio > 0 && (
                <div className="flex items-baseline justify-between text-[14px] texto-tenue">
                  <span>Envío</span>
                  <span className="tabular-nums">{money(pedido.envio)}</span>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t borde-tema pt-2.5">
                <span className="text-[14px] font-bold">Total</span>
                <span className="text-[20px] font-extrabold tracking-tight tabular-nums">
                  {money(total)}
                </span>
              </div>
            </div>
          </section>
        )}
        {/* ⚠️ Los datos para transferir van AQUÍ y no en el seguimiento. El
            seguimiento cuenta por dónde va el pedido; mezclarle un formulario
            de pago lo convertía en un cajón donde la línea de tiempo —lo único
            que el cliente vuelve a mirar— quedaba enterrada al final. */}
        {transferencia && (
          <div className="mt-8 w-full">
            <PagoPendiente
              slug={slug}
              orderId={pedido.id}
              orderNumber={pedido.order_number}
              telefonoNegocio={business.phone}
              onSubido={onSeguir}
            />
          </div>
        )}
      </div>

      <div className="mt-8 space-y-2.5">
        {/* Con transferencia el botón de arriba ya es el que importa, así que
            aquí solo queda seguir el pedido sin pagar todavía. */}
        <Boton onClick={onSeguir} variante={transferencia ? 'linea' : 'principal'}>
          {transferencia ? 'Ver el estado de mi pedido' : 'Seguir mi pedido'}
        </Boton>
        {whatsapp && (
          <a
            href={whatsapp}
            target="_blank"
            rel="noreferrer"
            className="flex w-full items-center justify-center gap-2 rounded-2xl border borde-tema px-4 py-3.5 text-[15px] font-bold transition active:scale-[0.98]"
          >
            <MessageCircle size={18} />
            Contactar por WhatsApp
          </a>
        )}
        <button
          onClick={onVolver}
          className="w-full py-2 text-[13.5px] font-semibold texto-tenue transition active:scale-[0.98]"
        >
          Volver al menú
        </button>
      </div>
    </div>
  )
}
