import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock, Copy, Landmark, MessageCircle, Upload } from 'lucide-react'
import { getPaymentInfo, uploadPaymentProof } from '../lib/api'
import { Aviso, Boton } from '../components/ui'
import { money, rangoDeEspera } from '../lib/format'
import type { BankAccount, Business, Fulfillment, OrderResult, PaymentMethod } from '../lib/types'

// Pedido registrado.
//
// Aquí NO se dice "pagado" ni "confirmado": el negocio cobra por fuera de la
// plataforma (regla inviolable #6). Se muestran los datos para transferir y se
// pide mandar el comprobante por WhatsApp, que es lo que hoy de verdad ocurre.

const lineasBanco = (cuenta: BankAccount) => [
  { etiqueta: 'Banco', valor: cuenta.bank_name },
  { etiqueta: 'Tipo', valor: cuenta.account_type },
  { etiqueta: 'Número', valor: cuenta.account_number, copiable: true },
  { etiqueta: 'Titular', valor: cuenta.holder_name },
  { etiqueta: 'Cédula / RUC', valor: cuenta.holder_id, copiable: true },
].filter(linea => Boolean(linea.valor))

export default function OrderDone({
  slug, business, order, resumen, paymentMethod, fulfillment, onVolverAlMenu, onSeguirPedido,
}: {
  slug: string
  business: Business
  order: OrderResult
  resumen: { titulo: string; total: number | null }
  /** Cómo dijo que iba a pagar. Solo `transferencia` enseña la cuenta. */
  paymentMethod?: PaymentMethod | null
  /** Cómo lo recibe: decide si el tiempo estimado incluye el reparto. */
  fulfillment?: Fulfillment | null
  /** Volver a la carta. Ausente en hospedaje, que no tiene menú al que volver. */
  onVolverAlMenu?: () => void
  /** Abrir el seguimiento. Sin id de pedido no hay nada que seguir. */
  onSeguirPedido?: () => void
}) {
  const [cuenta, setCuenta] = useState<BankAccount | null>(null)
  const [copiado, setCopiado] = useState('')
  const [comprobante, setComprobante] = useState<'ninguno' | 'subiendo' | 'listo'>('ninguno')
  const [falloComprobante, setFalloComprobante] = useState<string | null>(null)
  const archivo = useRef<HTMLInputElement>(null)

  // Solo se piden datos bancarios a quien dijo que iba a TRANSFERIR.
  //
  // ⚠️ Se comprueba en positivo a propósito. Estaba escrito como
  // `paymentMethod !== 'efectivo'`, y al añadir «pago al retirar» ese método
  // pasó a contar como transferencia: al cliente se le enseñaba la cuenta
  // bancaria y el subidor de comprobante, y si lo subía su pedido se iba a
  // `pago_en_revision` esperando un pago que nunca iba a llegar por ahí.
  // Con la lista en positivo, un método nuevo se queda fuera hasta que alguien
  // decida a mano que va aquí, que es el fallo seguro.
  const vaATransferir = paymentMethod === 'transferencia'

  useEffect(() => {
    if (!vaATransferir) return
    // Si el negocio no cargó datos bancarios no es un error: simplemente
    // coordinará el pago por WhatsApp como siempre.
    getPaymentInfo(slug).then(setCuenta).catch(() => setCuenta(null))
  }, [slug, vaATransferir])

  // El pedido YA está creado: si esto falla, no se pierde nada y el negocio
  // pedirá el comprobante por WhatsApp. Por eso el fallo se cuenta sin drama.
  const subir = async (elegido: File | undefined) => {
    // Sin id no hay a qué adjuntarlo: se calla y queda el camino de WhatsApp.
    if (!elegido || !order.id) return
    setComprobante('subiendo')
    setFalloComprobante(null)
    try {
      await uploadPaymentProof(slug, order.id, elegido)
      setComprobante('listo')
    } catch (error) {
      setComprobante('ninguno')
      setFalloComprobante(
        error instanceof Error ? error.message : 'No pudimos subir tu comprobante',
      )
    }
  }

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(texto)
      setTimeout(() => setCopiado(''), 1800)
    } catch { /* sin portapapeles: el número está a la vista igual */ }
  }

  const numero = order.order_number ? `#${order.order_number}` : ''
  // El mismo cálculo que la portada: preparación, más el reparto solo si se lo
  // llevan. Sin `fulfillment` —hospedaje— no se promete ningún tiempo.
  const espera = fulfillment
    ? rangoDeEspera(
      business.prepTimeMinutes + (fulfillment === 'delivery' ? business.deliveryExtraMinutes : 0),
    )
    : null
  const totalOficial = resumen.total != null
    ? resumen.total
    : Number.parseFloat(String(order.total ?? ''))
  const whatsapp = business.phone
    ? `https://wa.me/${business.phone.replace(/[^\d]/g, '')}?text=${
      encodeURIComponent(`Hola, acabo de enviar mi ${resumen.titulo.toLowerCase()} ${numero} 🙂`)
    }`
    : null

  return (
    <div className="animar-entrada mx-auto min-h-full max-w-md px-5 py-10">
      {/* Check verde grande y centrado, como la pantalla 10 del diagrama: es la
          señal de que la espera terminó, antes incluso de leer nada. */}
      <div className="mx-auto mb-6 flex size-20 items-center justify-center rounded-full bg-emerald-500/12">
        <CheckCircle2 size={44} className="text-emerald-600" strokeWidth={2.25} />
      </div>

      <h1 className="text-center text-[26px] leading-tight font-extrabold tracking-tight">
        ¡{resumen.titulo} confirmado!
      </h1>
      <p className="mt-2.5 text-center text-[15px] leading-relaxed texto-tenue">
        {business.name} lo recibió y te escribe por WhatsApp para confirmarlo.
      </p>

      {/* ── El número del pedido ──
          Es lo que el cliente dicta por teléfono para reclamar y lo que el
          dueño canta en la cocina. Va destacado y en el color del negocio, no
          escondido en el título. */}
      {numero && (
        <div className="mt-6 text-center">
          <p className="text-[13px] font-semibold texto-tenue">Número de pedido</p>
          <p className="mt-1 text-[30px] leading-none font-black tracking-tight text-marca tabular-nums">
            {numero}
          </p>
        </div>
      )}

      {Number.isFinite(totalOficial) && (
        <div className="superficie mt-6 flex items-baseline justify-between rounded-2xl border borde-tema px-4 py-4">
          <span className="text-[14px] font-semibold texto-tenue">Total</span>
          <span className="text-[26px] font-extrabold tabular-nums">{money(totalOficial)}</span>
        </div>
      )}

      {/* Tiempo estimado: lo que el cliente quiere saber justo después de
          confirmar. Sale del tiempo que puso el dueño, igual que la portada. */}
      {espera && (
        <div className="mt-3 flex items-center justify-center gap-2 text-[14px] texto-tenue">
          <Clock size={16} />
          Tiempo estimado
          <span className="font-bold text-(--texto)">{espera}</span>
        </div>
      )}

      {vaATransferir && cuenta && lineasBanco(cuenta).length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            <Landmark size={15} />
            Para transferir
          </h2>
          <div className="superficie divide-y divide-(--linea) overflow-hidden rounded-2xl border borde-tema">
            {lineasBanco(cuenta).map(({ etiqueta, valor, copiable }) => (
              <div key={etiqueta} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-[13px] texto-tenue">{etiqueta}</span>
                <span className="flex items-center gap-2 text-right text-[14px] font-semibold">
                  {String(valor)}
                  {copiable && (
                    <button onClick={() => copiar(String(valor))} aria-label={`Copiar ${etiqueta}`}>
                      <Copy size={14} className={copiado === String(valor) ? 'text-marca' : 'texto-tenue'} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
          {cuenta.instructions && (
            <p className="mt-2.5 text-[13px] texto-tenue">{cuenta.instructions}</p>
          )}
          {/* ── Comprobante ── */}
          {/* Es opcional a propósito: el pedido ya está hecho. Quien no
              encuentre la foto ahora la manda por WhatsApp y no pierde nada. */}
          <div className="mt-4 space-y-3">
            {!order.id
              ? (
                  <Aviso>
                    Envía el comprobante por WhatsApp para que el negocio lo verifique.
                  </Aviso>
                )
              : comprobante === 'listo'
              ? (
                  <Aviso>
                    <span className="flex items-center gap-2">
                      <CheckCircle2 size={16} />
                      Comprobante recibido. El negocio lo va a verificar.
                    </span>
                  </Aviso>
                )
              : (
                  <>
                    <input
                      ref={archivo}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={event => void subir(event.target.files?.[0])}
                    />
                    <Boton
                      variante="suave"
                      disabled={comprobante === 'subiendo'}
                      onClick={() => archivo.current?.click()}
                    >
                      <span className="flex items-center justify-center gap-2">
                        <Upload size={17} />
                        {comprobante === 'subiendo' ? 'Subiendo…' : 'Subir comprobante'}
                      </span>
                    </Boton>
                    <p className="text-center text-[12px] texto-tenue">
                      También puedes enviarlo por WhatsApp si prefieres.
                    </p>
                  </>
                )}
            {falloComprobante && <Aviso tono="alerta">{falloComprobante}</Aviso>}
          </div>
        </section>
      )}

      {/* Las acciones, en el orden del diagrama: primero hablar con el negocio
          —que es lo que de verdad resuelve una duda— y después volver a la
          carta. «Seguir pedido» no está porque la pantalla de seguimiento aún
          no existe: un botón que no lleva a ninguna parte se siente roto. */}
      <div className="mt-6 space-y-2.5">
        {onSeguirPedido && (
          <Boton onClick={onSeguirPedido}>Seguir pedido</Boton>
        )}
        {whatsapp && (
          <a href={whatsapp} className="block">
            <Boton variante={cuenta ? 'principal' : 'linea'}>
              <span className="flex items-center justify-center gap-2">
                <MessageCircle size={18} />
                Escribir por WhatsApp
              </span>
            </Boton>
          </a>
        )}
        {onVolverAlMenu && (
          <Boton variante="linea" onClick={onVolverAlMenu}>
            Volver al menú
          </Boton>
        )}
      </div>
    </div>
  )
}
