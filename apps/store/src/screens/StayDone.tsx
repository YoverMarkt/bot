import { CalendarCheck, Clock, MessageCircle } from 'lucide-react'
import { Aviso, Boton } from '../components/ui'
import { money } from '../lib/format'
import type { Business, StayRequest } from '../lib/types'

// Solicitud de estadía registrada.
//
// ⚠️ Esto NO es una reserva confirmada y la pantalla lo dice sin rodeos. Es una
// retención temporal que el equipo confirma a mano; prometer lo contrario sería
// vender una habitación que quizá no esté. El huésped merece saberlo aquí, no
// al llegar con las maletas.

const fechaLarga = (iso: string): string => {
  const partes = iso.split('-').map(Number)
  if (partes.length !== 3) return iso
  const fecha = new Date(partes[0], partes[1] - 1, partes[2])
  return fecha.toLocaleDateString('es-EC', { weekday: 'short', day: 'numeric', month: 'short' })
}

export default function StayDone({ business, request }: {
  business: Business
  request: StayRequest
}) {
  const whatsapp = business.phone
    ? `https://wa.me/${business.phone.replace(/[^\d]/g, '')}?text=${
      encodeURIComponent('Hola, acabo de solicitar una habitación 🙂')
    }`
    : null

  const filas = [
    { etiqueta: 'Habitación', valor: request.roomTypeName },
    { etiqueta: 'Entrada', valor: `${fechaLarga(request.checkIn)} · ${request.checkInTime}` },
    { etiqueta: 'Salida', valor: `${fechaLarga(request.checkOut)} · ${request.checkOutTime}` },
    { etiqueta: 'Noches', valor: String(request.nights) },
  ]

  return (
    <div className="animar-entrada mx-auto min-h-full max-w-md px-5 py-10">
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-amber-500/12">
        <Clock size={26} className="text-amber-600" />
      </div>

      <h1 className="text-[26px] leading-tight font-extrabold tracking-tight">
        Solicitud enviada
      </h1>
      <p className="mt-2.5 text-[15px] leading-relaxed texto-tenue">
        {business.name} está revisando tu solicitud y te confirma por WhatsApp.
      </p>

      <div className="mt-6">
        <Aviso tono="alerta">
          Tu habitación queda apartada temporalmente. Todavía <strong>no está confirmada</strong>:
          el equipo la revisa y coordina el pago contigo.
        </Aviso>
      </div>

      <div className="superficie mt-6 divide-y divide-[var(--linea)] overflow-hidden rounded-2xl border borde-tema">
        {filas.map(({ etiqueta, valor }) => (
          <div key={etiqueta} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-[13px] texto-tenue">{etiqueta}</span>
            <span className="text-right text-[14px] font-semibold">{valor}</span>
          </div>
        ))}
        <div className="flex items-baseline justify-between px-4 py-4">
          <span className="text-[14px] font-semibold texto-tenue">Total estimado</span>
          <span className="text-[24px] font-extrabold tabular-nums">
            {money(request.total, request.currency)}
          </span>
        </div>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[12px] texto-tenue">
        <CalendarCheck size={13} />
        Confírmala pronto para que no se libere.
      </p>

      {whatsapp && (
        <div className="mt-6">
          <a href={whatsapp} className="block">
            <Boton>
              <span className="flex items-center justify-center gap-2">
                <MessageCircle size={18} />
                Escribir por WhatsApp
              </span>
            </Boton>
          </a>
        </div>
      )}
    </div>
  )
}
