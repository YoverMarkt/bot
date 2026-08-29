import { useEffect, useState } from 'react'
import { RiForbid2Line, RiWhatsappLine } from '@remixicon/react'
import { Boton, LocalDeLaPuerta, SelloDePuerta } from '../components/ui'
import { cuantoFalta } from '../lib/bloqueo'
import type { Business } from '../lib/types'

// Lo que ve quien está bloqueado en este local.
//
// ⚠️ Es una pantalla APARTE de `Gate`, y no un motivo más suyo. `Gate` habla
// del ENLACE —«pide el tuyo», «este es de otra persona»— y aquí el enlace está
// perfecto: lo que pasa es que esta persona no puede comprar en este local
// ahora mismo. Mandarla a pedir otro enlace la dejaría en bucle pidiendo
// enlaces que tampoco funcionarían.
//
// Nace del 2026-08-29: el dueño, bloqueado, subió en el chat, tocó un enlace
// viejo, entró a la tienda, recorrió la carta y creó el pedido #74 — que se
// quedó en el limbo porque nadie iba a poder pagarlo. Esta pantalla es la
// puerta que faltaba.

export default function Bloqueado({ business, until, permanent, onReintentar }: {
  business: Business | null
  until: string | null
  permanent: boolean
  onReintentar: () => void
}) {
  /**
   * El plazo se recalcula solo.
   *
   * ⚠️ No es adorno: quien mira esta pantalla está esperando a que pase, y sin
   * esto tendría que cerrar y volver a abrir para saber si ya puede. Cuando
   * llega a cero aparece el botón de volver a entrar, que es lo único que de
   * verdad resuelve.
   */
  const [restante, setRestante] = useState(() => cuantoFalta(until))
  useEffect(() => {
    if (!until) return
    const t = setInterval(() => setRestante(cuantoFalta(until)), 20000)
    return () => clearInterval(t)
  }, [until])

  const nombre = business?.name || 'este local'
  const telefono = String(business?.phone || '').replace(/[^\d]/g, '')
  const cumplido = Boolean(until) && !restante

  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 pt-[calc(env(safe-area-inset-top)+3rem)] pb-12">
      <LocalDeLaPuerta nombre={business?.name} logoUrl={business?.logoUrl} />

      <SelloDePuerta><RiForbid2Line size={26} /></SelloDePuerta>

      <h1 className="titulo-xl">
        {permanent ? `${nombre} pausó tus pedidos` : 'Ahora no puedes pedir aquí'}
      </h1>

      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">
        {permanent
          ? 'Suele pasar cuando quedan pedidos sin confirmar o sin recoger. '
            + 'Si crees que es un error, comunícate directamente con el local.'
          : 'Se cerró tu acceso a este local por incumplir las políticas de Umbani. '
            + 'Es temporal: después podrás volver a pedir con normalidad.'}
      </p>

      {/* El plazo, solo cuando existe de verdad. Un bloqueo permanente NO
          promete hora: prometer una que no se cumple es peor que no decir
          nada — es cómo nació el fallo del número del 2026-08-23. */}
      {until && !cumplido && (
        <p className="superficie mt-6 rounded-(--radius-tarjeta) px-4 py-4 text-center text-[15px] font-bold shadow-tarjeta">
          Podrás pedir de nuevo en un rato
          <span className="mt-1 block text-[13px] font-semibold texto-cuerpo">{restante}</span>
        </p>
      )}

      {cumplido && (
        <div className="mt-6">
          <Boton onClick={onReintentar}>Ya puedo pedir · Entrar</Boton>
        </div>
      )}

      {/* Siempre hay salida: los DEMÁS locales. Un «no puedes» sin salida es
          peor que no bloquear — la misma regla que sigue el bot en el chat. */}
      <p className="mt-8 text-[13.5px] leading-relaxed texto-cuerpo">
        Mientras tanto puedes pedir en los demás locales de Umbani.
      </p>

      {telefono && (
        <div className="mt-4">
          <a
            href={`https://wa.me/${telefono}?text=${encodeURIComponent('MENÚ')}`}
            className="block"
          >
            <Boton variante={cumplido ? 'linea' : 'principal'}>
              <span className="flex items-center justify-center gap-2">
                <RiWhatsappLine size={18} />
                Ver otros locales
              </span>
            </Boton>
          </a>
        </div>
      )}
    </div>
  )
}
