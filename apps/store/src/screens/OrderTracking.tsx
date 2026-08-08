import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, Copy, Landmark, MessageCircle, Upload } from 'lucide-react'
import { getOrder, getPaymentInfo, uploadPaymentProof } from '../lib/api'
import { Aviso, Boton } from '../components/ui'
import { money } from '../lib/format'
import type { BankAccount, Business, Fulfillment, TrackedOrder } from '../lib/types'

const lineasBanco = (cuenta: BankAccount) => [
  { etiqueta: 'Banco', valor: cuenta.bank_name },
  { etiqueta: 'Tipo', valor: cuenta.account_type },
  { etiqueta: 'Número', valor: cuenta.account_number, copiable: true },
  { etiqueta: 'Titular', valor: cuenta.holder_name },
  { etiqueta: 'Cédula / RUC', valor: cuenta.holder_id, copiable: true },
].filter(linea => Boolean(linea.valor))

// Seguimiento del pedido: por dónde va, con la hora de cada paso.
//
// Los estados internos son DOCE. Al cliente no le sirven doce: le sirve saber
// si su comida está hecha y si viene en camino. Aquí se resumen en los hitos
// del diagrama, y los que solo importan al dueño —`esperando_pago`,
// `aceptado`— se pliegan sobre el hito que representan.

/**
 * Los hitos que ve el cliente, en orden.
 *
 * `en_camino` y `listo_para_retiro` son el MISMO paso contado de dos maneras:
 * a quien le llevan el pedido le importa que salió; a quien lo recoge, que ya
 * puede pasar. Por eso el cuarto hito cambia con el modo de entrega en vez de
 * enseñar los dos y dejar uno siempre gris.
 */
const hitos = (fulfillment: Fulfillment | null) => [
  { clave: 'recibido', texto: 'Recibido', estados: ['pendiente', 'esperando_pago', 'pago_en_revision'] },
  // «Aceptado» y «en preparación» son un solo hito desde el 2026-08-08: el
  // dueño acepta y prepara en un toque, así que separarlos dejaba al cliente
  // mirando un paso que nunca duraba nada.
  { clave: 'preparacion', texto: 'En preparación', estados: ['confirmado', 'aceptado', 'preparacion'] },
  fulfillment === 'delivery'
    ? { clave: 'camino', texto: 'En camino', estados: ['en_camino'] }
    : { clave: 'listo', texto: 'Listo para retirar', estados: ['listo_para_retiro'] },
  { clave: 'entregado', texto: 'Entregado', estados: ['completado'] },
]

/** Los finales que rompen la línea: de ahí no se sigue. */
const CORTADOS: Record<string, string> = {
  cancelado: 'Pedido cancelado',
  rechazado: 'Pedido rechazado',
  expirado: 'El pedido expiró',
}

const hora = (iso?: string | null) => {
  if (!iso) return null
  const cuando = new Date(iso)
  if (Number.isNaN(cuando.getTime())) return null
  // En hora de ECUADOR, no la del teléfono: el pedido lo prepara una cocina que
  // está allí, y un cliente en otro huso vería horas que no le dicen nada.
  return cuando.toLocaleTimeString('es-EC', {
    timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export default function OrderTracking({ slug, business, orderId, onVolver }: {
  slug: string
  business: Business
  orderId: string
  onVolver: () => void
}) {
  const [pedido, setPedido] = useState<TrackedOrder | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cuenta, setCuenta] = useState<BankAccount | null>(null)
  const [copiado, setCopiado] = useState('')
  const [comprobante, setComprobante] = useState<'ninguno' | 'subiendo' | 'listo'>('ninguno')
  const [falloComprobante, setFalloComprobante] = useState<string | null>(null)
  const archivo = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let vivo = true
    const cargar = () => {
      getOrder(slug, orderId)
        .then(datos => { if (vivo) { setPedido(datos); setError(null) } })
        .catch(() => { if (vivo) setError('No pudimos encontrar tu pedido') })
    }
    cargar()
    // Se refresca solo mientras la pantalla está abierta.
    const cada = window.setInterval(cargar, 10_000)

    // ⚠️ Y AL VOLVER A LA PANTALLA, que es lo que de verdad se nota: el
    // cliente deja el móvil mientras espera su comida y vuelve al rato. Sin
    // esto veía el estado de hace diez minutos y tenía que recargar a mano.
    // Los navegadores además frenan los temporizadores en segundo plano, así
    // que el intervalo por sí solo no basta.
    const alVolver = () => { if (document.visibilityState === 'visible') cargar() }
    document.addEventListener('visibilitychange', alVolver)
    return () => {
      vivo = false
      window.clearInterval(cada)
      document.removeEventListener('visibilitychange', alVolver)
    }
  }, [slug, orderId])

  // Los datos para transferir, solo si aún hay algo que pagar.
  //
  // Con el pago ya confirmado por el negocio no se piden: quien transfirió y
  // mandó la captura por WhatsApp seguía viendo el número de cuenta y el
  // botón de subir, como si no hubiera pagado nada.
  const esperandoPago = pedido?.status === 'esperando_pago' && !pedido?.payment_confirmed_at
  useEffect(() => {
    if (!esperandoPago) return
    getPaymentInfo(slug).then(setCuenta).catch(() => setCuenta(null))
  }, [slug, esperandoPago])

  const subir = async (elegido: File | undefined) => {
    if (!elegido) return
    setComprobante('subiendo')
    setFalloComprobante(null)
    try {
      await uploadPaymentProof(slug, orderId, elegido)
      setComprobante('listo')
      // El pedido pasa a «pago en revisión»: se recarga para que la línea de
      // tiempo lo refleje sin esperar al siguiente intervalo.
      getOrder(slug, orderId).then(setPedido).catch(() => {})
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

  if (error) {
    return (
      <div className="mx-auto min-h-full max-w-md px-5 py-10">
        <Aviso tono="alerta">{error}</Aviso>
        <div className="mt-4">
          <Boton variante="linea" onClick={onVolver}>Volver al menú</Boton>
        </div>
      </div>
    )
  }

  if (!pedido) return null

  // ── El pedido entregado se despide ───────────────────────────────────────
  //
  // Reemplaza la pantalla entera, no se añade encima: con el pedido en la
  // mano, la línea de tiempo ya no informa de nada —todos los puntos en
  // verde— y el cliente no ha vuelto a abrir esto para consultar un estado,
  // ha vuelto porque le llegó el aviso. Lo único que queda por hacer es
  // agradecérselo y devolverle al menú, que es donde puede volver a pedir.
  //
  // El texto es el MISMO que el del WhatsApp (`services/order-notify.ts`): el
  // cliente llega por los dos caminos y no puede leer dos despedidas
  // distintas del mismo negocio.
  if (pedido.status === 'completado') {
    return (
      <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 pt-seguro pb-10">
        <div className="mb-6 flex size-16 items-center justify-center rounded-full bg-emerald-500 text-white">
          <Check size={32} strokeWidth={3} />
        </div>

        <p className="text-[13px] font-semibold texto-tenue">
          Pedido #{pedido.order_number} entregado
        </p>
        <h1 className="mt-1.5 text-[28px] leading-tight font-extrabold tracking-tight">
          Gracias por preferirnos 🙌
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed texto-tenue">
          Pronto también estaremos en la app de Umbani.
        </p>

        <div className="mt-8 space-y-2.5">
          <Boton onClick={onVolver}>Volver al menú</Boton>
          {business.phone && (
            <a
              href={`https://wa.me/${business.phone.replace(/[^\d]/g, '')}`}
              className="block"
            >
              <Boton variante="linea">
                <span className="flex items-center justify-center gap-2">
                  <MessageCircle size={18} />
                  Escribir por WhatsApp
                </span>
              </Boton>
            </a>
          )}
        </div>
      </div>
    )
  }

  const pasos = hitos(pedido.fulfillment)
  // La hora de cada hito sale del historial: es el único sitio donde queda
  // cuándo pasó cada cosa. `updated_at` se pisa con cada cambio.
  const horaDe = (estados: string[]) => {
    const evento = pedido.events.find(item => estados.includes(item.to_status))
    // «Recibido» no deja rastro en el historial: el pedido NACE en `pendiente`,
    // y solo se anotan los CAMBIOS de estado. Su hora es la de creación, que es
    // literalmente cuando se recibió. Sin esto el primer paso salía con «--:--»
    // aunque estuviera cumplido, que es justo el que el cliente sabe seguro.
    if (!evento && estados.includes('pendiente')) return hora(pedido.created_at)
    return hora(evento?.created_at)
  }
  const indiceActual = pasos.findIndex(paso => paso.estados.includes(pedido.status))
  const cortado = CORTADOS[pedido.status]

  return (
    <div className="animar-entrada mx-auto min-h-full max-w-md px-5 pt-seguro pb-10">
      <div className="mb-6 flex items-center gap-3">
        <button onClick={onVolver} aria-label="Volver" className="-ml-1 shrink-0">
          <ChevronLeft size={22} />
        </button>
        <h1 className="text-[22px] leading-none font-extrabold tracking-tight">Seguimiento</h1>
      </div>

      <div className="superficie rounded-(--radius-tarjeta) border borde-tema px-4 py-4">
        <p className="text-[13px] font-semibold texto-tenue">Pedido</p>
        <p className="mt-0.5 text-[26px] leading-none font-black tracking-tight text-marca tabular-nums">
          #{pedido.order_number}
        </p>
        {pedido.total != null && (
          <p className="mt-2 text-[14px] texto-tenue">
            Total <span className="font-bold text-(--texto)">{money(Number(pedido.total))}</span>
          </p>
        )}
      </div>

      {/* ── Lo que falta para que arranque ──
          Va ARRIBA de la línea de tiempo a propósito: si el negocio está
          esperando el comprobante, eso es lo único que importa ahora mismo. */}
      {esperandoPago && (
        <section className="mt-5">
          <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            <Landmark size={15} />
            Para transferir
          </h2>
          {cuenta && lineasBanco(cuenta).length > 0 && (
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
          )}
          <div className="mt-3 space-y-3">
            <input
              ref={archivo}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={event => void subir(event.target.files?.[0])}
            />
            <Boton
              disabled={comprobante === 'subiendo'}
              onClick={() => archivo.current?.click()}
            >
              <span className="flex items-center justify-center gap-2">
                <Upload size={17} />
                {comprobante === 'subiendo' ? 'Subiendo…' : 'Subir comprobante'}
              </span>
            </Boton>
            {/* ── Las DOS vías, y la segunda es un enlace de verdad ──
                No es una preferencia estética: mucha gente transfiere desde la
                app de su banco —a veces desde la cuenta de un familiar— y la
                captura le queda en el teléfono con el que abrió WhatsApp, no
                aquí. Antes esto decía «también puedes enviarlo por WhatsApp si
                prefieres», que sonaba a que daba igual hacerlo o no. */}
            <p className="text-center text-[12.5px] texto-tenue">
              Sube tu comprobante para confirmar tu pedido.
            </p>
            {business.phone && (
              <a
                href={`https://wa.me/${business.phone.replace(/[^\d]/g, '')}?text=${
                  encodeURIComponent(
                    `Hola, te envío el comprobante de mi pedido #${pedido.order_number} 🙂`,
                  )
                }`}
                className="flex items-center justify-center gap-1.5 text-center text-[12.5px] font-semibold text-marca"
              >
                <MessageCircle size={14} />
                También puedes enviarlo por WhatsApp
              </a>
            )}
            {falloComprobante && <Aviso tono="alerta">{falloComprobante}</Aviso>}
          </div>
        </section>
      )}

      {/* ── El pago, dicho de una vez ──
          Va antes que el comprobante en revisión: si el negocio ya dio el pago
          por bueno, da igual por qué vía llegó, y decir «lo está revisando»
          sobre algo ya aprobado es peor que no decir nada. */}
      {pedido.payment_confirmed_at
        ? (
            <div className="mt-5 flex items-center gap-2.5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                <Check size={14} strokeWidth={3} />
              </span>
              <p className="text-[13.5px] leading-snug font-semibold text-emerald-900">
                Pago confirmado
                <span className="block font-normal text-emerald-800">
                  {business.name} recibió tu pago.
                </span>
              </p>
            </div>
          )
        : pedido.status === 'pago_en_revision' && (
          <div className="mt-5">
            <Aviso>Recibimos tu comprobante. {business.name} lo está revisando.</Aviso>
          </div>
        )}

      {cortado
        ? (
            <div className="mt-5">
              <Aviso tono="alerta">
                {cortado}. Escríbele al negocio si necesitas saber por qué.
              </Aviso>
            </div>
          )
        : (
            <ol className="mt-6">
              {pasos.map((paso, indice) => {
                const cumplido = indiceActual >= 0 && indice <= indiceActual
                const actual = indice === indiceActual
                const cuando = horaDe(paso.estados)
                return (
                  <li key={paso.clave} className="flex gap-3">
                    {/* La columna del hilo: punto y línea hasta el siguiente. */}
                    <div className="flex flex-col items-center">
                      <span
                        className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
                          cumplido ? 'bg-emerald-500 text-white' : 'border-2 borde-tema'
                        }`}
                      >
                        {cumplido && <Check size={14} strokeWidth={3} />}
                      </span>
                      {indice < pasos.length - 1 && (
                        <span
                          className={`w-0.5 flex-1 ${cumplido ? 'bg-emerald-500' : 'bg-(--linea)'}`}
                        />
                      )}
                    </div>
                    <div className={`pb-7 ${indice === pasos.length - 1 ? 'pb-0' : ''}`}>
                      <p className={`text-[15px] leading-none ${
                        actual ? 'font-extrabold' : cumplido ? 'font-bold' : 'font-semibold texto-tenue'
                      }`}
                      >
                        {paso.texto}
                      </p>
                      {/* Los pendientes llevan «--:--» a propósito: dejar el
                          hueco vacío se lee como que falta un dato, y así se
                          entiende que ese paso todavía no ha ocurrido. */}
                      <p className="mt-1 text-[13px] texto-tenue tabular-nums">
                        {cuando || '--:--'}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

      <div className="mt-8 space-y-2.5">
        {business.phone && (
          <a
            href={`https://wa.me/${business.phone.replace(/[^\d]/g, '')}?text=${
              encodeURIComponent(`Hola, consulto por mi pedido #${pedido.order_number} 🙂`)
            }`}
            className="block"
          >
            <Boton variante="linea">
              <span className="flex items-center justify-center gap-2">
                <MessageCircle size={18} />
                Escribir por WhatsApp
              </span>
            </Boton>
          </a>
        )}
        <Boton variante="linea" onClick={onVolver}>Volver al menú</Boton>
      </div>
    </div>
  )
}
