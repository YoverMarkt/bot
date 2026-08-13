import { Check, Clock, MessageCircle } from 'lucide-react'
import PagoPendiente from '../components/PagoPendiente'
import { money, rangoDeEspera } from '../lib/format'
import { grupoEnTexto } from '../lib/resumen'
import type { LineaResumen } from '../lib/resumen'
import { enlaceWhatsApp, textoComprobante } from '../lib/whatsapp'
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
// ── El comprobante se manda por WhatsApp (2026-08-12) ─────────────────────
//
// Esta pantalla tenía un botón para subirlo aquí y el chat como segunda vía.
// Dos caminos para lo mismo, y el que casi nadie usaba era el de la app: la
// gente transfiere desde su banco y la captura le queda en el teléfono, junto
// a la conversación donde le llegó el enlace. Ahora hay UNO: los datos para
// transferir, y de ahí de vuelta a WhatsApp.
//
// Lo que sostiene la decisión es que la foto del chat YA se adjunta sola al
// pedido (`services/payment-proof-inbox.ts`), así que el cliente no hace nada
// distinto y el dueño ve exactamente lo mismo en su panel.
//
// Es ESTÁTICA a propósito, que fue la otra crítica de cuando se retiró: no
// consulta nada porque no promete nada que pueda cambiar. Lo que cambia —el
// estado del pedido— llega por los tres avisos de WhatsApp, que es donde el
// cliente ya está mirando.

export interface PedidoRecibido {
  id: string
  order_number?: number | string | null
  total?: number | string | null
  /**
   * Lo que se pidió, ENTERO. Las dos fuentes —el carrito recién enviado y el
   * pedido que devuelve el servidor— se normalizan en `lib/resumen.ts`.
   */
  lineas: LineaResumen[]
  envio: number
  subtotal: number
}

export default function OrderPlaced({
  slug, business, pedido, nombre, entrega, transferencia, volviendo, onVolver,
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
  onVolver: () => void
}) {
  const numero = pedido.order_number ? `#${pedido.order_number}` : null
  // El MISMO cálculo que la portada: preparación, más el reparto solo si se lo
  // llevan. Quien retira no espera lo que tarda el repartidor.
  const espera = rangoDeEspera(
    business.prepTimeMinutes + (entrega === 'delivery' ? business.deliveryExtraMinutes : 0),
  )
  const total = Number(pedido.total) || pedido.subtotal + pedido.envio

  // ⚠️ Con transferencia el enlace lleva escrito el texto del comprobante: el
  // cliente vuelve al chat con la frase puesta y solo tiene que adjuntar la
  // foto. Sin transferencia se abre la conversación limpia — no hay nada que
  // pedirle, y un mensaje prellenado que no viene a cuento se borra.
  const whatsapp = enlaceWhatsApp(
    business.phone,
    transferencia ? textoComprobante(pedido.order_number) : null,
  )

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
        <p className="mt-2 text-[14.5px] leading-snug texto-tenue">
          {volviendo
            ? 'Tu pedido está guardado. En cuanto recibamos tu comprobante, el local lo prepara.'
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
            <h2 className="mb-2.5 text-[17px] font-extrabold tracking-tight">
              Resumen del pedido
            </h2>
            <div className="space-y-2">
              {/* ⚠️ Lo elegido va DEBAJO de su producto, no pegado al nombre.
                  Esta pantalla decía «1× Pizza $16.83» justo después de que el
                  cliente eligiera masa, borde y sabor: el dato estaba en el
                  carrito y en el pedido, y no se pintaba.

                  Se corta a dos líneas —y solo aquí—: el cliente acaba de
                  armarlo y ya sabe lo que pidió. En el panel del dueño va
                  entero, porque ahí lo lee la cocina. */}
              {pedido.lineas.map((linea, indice) => (
                <div key={indice} className="flex items-baseline justify-between gap-3 text-[14px]">
                  <span className="min-w-0">
                    <span className="texto-tenue">{linea.cantidad}× </span>
                    {linea.nombre}
                    {linea.grupos.map(grupo => (
                      <span key={grupo.group} className="mt-0.5 block text-[12.5px] leading-snug line-clamp-2 texto-tenue">
                        {grupoEnTexto(grupo)}
                      </span>
                    ))}
                    {linea.nota && (
                      <span className="mt-0.5 block text-[12.5px] leading-snug italic texto-tenue">
                        «{linea.nota}»
                      </span>
                    )}
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
        {/* Los datos para transferir. Sin subidor desde el 2026-08-12: aquí
            solo se lee el número de cuenta, y el comprobante se manda por el
            chat, que es donde el cliente tiene la captura. */}
        {transferencia && (
          <div className="mt-8 w-full">
            <PagoPendiente slug={slug} />
          </div>
        )}

        {/* ⚠️ EL TEXTO GRANDE, y el tamaño es la decisión. Esto no es una nota
            al pie: con transferencia es la instrucción que desbloquea el
            pedido, y en efectivo es la promesa de que nadie tiene que volver a
            abrir esta app para enterarse de nada. Puesto en letra pequeña bajo
            un botón, se lee cuando ya no hace falta. */}
        <div className="superficie mt-6 w-full rounded-2xl border borde-tema px-4 py-4 text-left">
          <div className="flex items-start gap-3">
            <span className="acento flex size-9 shrink-0 items-center justify-center rounded-full">
              <MessageCircle size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-[16px] leading-snug font-bold tracking-tight">
                {transferencia
                  ? 'Mándanos el comprobante por WhatsApp'
                  : 'Te mantenemos al tanto por WhatsApp'}
              </p>
              <p className="mt-1 text-[14px] leading-snug texto-tenue">
                {transferencia
                  ? 'Envía la captura de tu transferencia al chat del local. En cuanto la revisen, te avisamos por ahí y empiezan a prepararlo.'
                  : entrega === 'delivery'
                    ? 'Te escribimos cuando el local empiece a prepararlo, cuando salga para tu dirección y cuando llegue.'
                    : 'Te escribimos cuando el local empiece a prepararlo y cuando esté listo para que pases a retirarlo.'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 space-y-2.5">
        {/* ⚠️ La salida principal es el chat, no una pantalla de esta app. El
            cliente llegó aquí desde WhatsApp y ahí es donde va a recibir los
            avisos; devolverlo es terminar el viaje donde empezó. Va en TINTA
            como todo botón principal: el acento señala, no acciona. */}
        {whatsapp && (
          <a
            href={whatsapp}
            target="_blank"
            rel="noreferrer"
            className="tinta flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-[15.5px] font-bold tracking-tight transition active:opacity-90"
          >
            <MessageCircle size={18} />
            Volver a WhatsApp
          </a>
        )}
        <button
          onClick={onVolver}
          className="w-full py-2.5 text-[14px] font-semibold texto-tenue transition active:scale-[0.98]"
        >
          Volver al menú
        </button>
      </div>
    </div>
  )
}
