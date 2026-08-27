import {
  RiSmartphoneLine,
  RiWhatsappLine,
} from '@remixicon/react'
import { Boton } from '../components/ui'
import type { Business } from '../lib/types'

// Lo que ve quien abre el enlace en una computadora (normalmente, un clic desde
// WhatsApp Web).
//
// No se pide nada al servidor desde aquí salvo la portada, que es pública: así
// abrir en el PC NO consume el enlace. Cuando la persona lo abra en su teléfono
// funcionará con normalidad, que es justo lo que queremos — un clic sin querer
// en WhatsApp Web no puede quemarle el enlace a un cliente honesto.

export default function DesktopGate({ business }: { business: Business | null }) {
  const telefono = business?.phone || ''
  const whatsapp = telefono
    ? `https://wa.me/${telefono.replace(/[^\d]/g, '')}?text=${
      encodeURIComponent('Hola, quiero ver el menú 🙂')
    }`
    : null

  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      {/* Icono en tinta sobre el tinte de marca, igual que las otras dos
          puertas (`Gate.tsx` y `Confirmar.tsx`): el color del negocio como
          LETRA no llega a AA. Las tres se pintan igual a propósito. */}
      <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-marca-suave shadow-tarjeta">
        <RiSmartphoneLine size={24} />
      </div>

      {business?.name && (
        <p className="caption mb-2 font-bold texto-cuerpo">{business.name}</p>
      )}

      <h1 className="text-[26px] leading-tight font-extrabold tracking-tight">
        Abre este enlace desde tu celular
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-tenue">
        La tienda está hecha para el teléfono. Busca el mensaje en tu WhatsApp del celular
        y toca el enlace desde ahí.
      </p>

      <div className="mt-6 rounded-xl bg-black/5 px-4 py-3.5 text-[13px] leading-relaxed texto-tenue">
        Tu enlace sigue intacto: abrirlo aquí no lo gastó.
      </div>

      {whatsapp && (
        <div className="mt-8">
          <a href={whatsapp} className="block">
            <Boton variante="linea">
              <span className="flex items-center justify-center gap-2">
                <RiWhatsappLine size={18} />
                Escribir al negocio
              </span>
            </Boton>
          </a>
        </div>
      )}
    </div>
  )
}
