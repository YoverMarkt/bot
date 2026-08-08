import { useEffect, useState } from 'react'
import { Check, ChevronLeft, MessageCircle } from 'lucide-react'
import { getOrder } from '../lib/api'
import { Aviso, Boton } from '../components/ui'
import { money } from '../lib/format'
import type { Business, Fulfillment, TrackedOrder } from '../lib/types'

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
  { clave: 'confirmado', texto: 'Confirmado', estados: ['confirmado', 'aceptado'] },
  { clave: 'preparacion', texto: 'En preparación', estados: ['preparacion'] },
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

  useEffect(() => {
    let vivo = true
    const cargar = () => {
      getOrder(slug, orderId)
        .then(datos => { if (vivo) { setPedido(datos); setError(null) } })
        .catch(() => { if (vivo) setError('No pudimos encontrar tu pedido') })
    }
    cargar()
    // Se refresca solo mientras la pantalla está abierta: el cliente la deja
    // mirando y quiere ver cómo avanza sin tocar nada. Cada 20 s es suficiente
    // para una cocina y no castiga los datos móviles.
    const cada = window.setInterval(cargar, 20_000)
    return () => { vivo = false; window.clearInterval(cada) }
  }, [slug, orderId])

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
