import {
  RiSmartphoneLine,
  RiWhatsappLine,
} from '@remixicon/react'
import { Boton, LocalDeLaPuerta, SelloDePuerta } from '../components/ui'
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
      {/* Las tres puertas se pintan igual a propósito. */}
      <LocalDeLaPuerta nombre={business?.name} logoUrl={business?.logoUrl} />

      <SelloDePuerta><RiSmartphoneLine size={26} /></SelloDePuerta>

      <h1 className="titulo-xl">
        Abre este enlace desde tu celular
      </h1>
      {/* En `texto-cuerpo`, no en el gris de metadatos: esto es la explicación
          de por qué no puede pasar, no un pie de página. */}
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">
        La tienda está hecha para el teléfono. Busca el mensaje en tu WhatsApp del celular
        y toca el enlace desde ahí.
      </p>

      <div className="superficie mt-6 rounded-(--radius-tarjeta) px-4 py-4 text-[13.5px] leading-relaxed texto-cuerpo shadow-tarjeta">
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
