import { MessageCircle, Lock, Store as Tienda } from 'lucide-react'
import { Boton } from '../components/ui'
import type { Business } from '../lib/types'

// Lo que ve quien NO puede usar la tienda.
//
// El caso importante es el enlace reenviado: alguien recibe por un grupo el
// enlace de otra persona y lo abre. La app no lo trata como un error técnico
// —no lo es— sino que le explica que cada enlace es personal y le da el botón
// para pedir el suyo al negocio. Es la diferencia entre perder un cliente y
// ganarlo.

/** Motivos que devuelve el servidor al rechazar la sesión. */
const MENSAJES: Record<string, { titulo: string; detalle: string }> = {
  otro_dispositivo: {
    titulo: 'Este enlace es de otra persona',
    detalle: 'Cada enlace se abre en un solo teléfono, para que nadie pida a nombre de otro. Escríbele al negocio y te enviamos el tuyo al instante.',
  },
  // Los enlaces nuevos ya no caducan (2026-08-02). Este mensaje solo lo ven
  // los que quedaban vivos de antes, hasta que la limpieza se los lleve.
  caducada: {
    titulo: 'Tu enlace expiró',
    detalle: 'Era de los antiguos, que duraban unas horas. Escríbele al negocio y recibes uno nuevo — ese ya no vence.',
  },
  revocada: {
    titulo: 'Este enlace ya no está activo',
    detalle: 'Escríbele al negocio por WhatsApp y te enviamos uno nuevo.',
  },
  otro_negocio: {
    titulo: 'Este enlace es de otro negocio',
    detalle: 'El enlace que abriste pertenece a otra tienda. Escríbele a este negocio para recibir el suyo.',
  },
  no_existe: {
    titulo: 'Necesitas tu propio enlace',
    detalle: 'Para ver el menú y pedir, escríbele al negocio por WhatsApp y te enviamos tu enlace personal.',
  },
}

const textoWhatsapp = (telefono: string): string => {
  const limpio = telefono.replace(/[^\d]/g, '')
  const mensaje = encodeURIComponent('Hola, quiero ver el menú 🙂')
  return `https://wa.me/${limpio}?text=${mensaje}`
}

export default function Gate({ business, motivo }: {
  business: Business | null
  motivo: string | null
}) {
  const { titulo, detalle } = MENSAJES[motivo || 'no_existe'] || MENSAJES.no_existe
  const telefono = business?.phone || ''

  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-marca-suave">
        <Lock size={24} className="text-marca" />
      </div>

      {business?.name && (
        <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold texto-tenue">
          <Tienda size={14} />
          {business.name}
        </p>
      )}

      <h1 className="text-[26px] leading-tight font-extrabold tracking-tight">{titulo}</h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-tenue">{detalle}</p>

      {telefono
        ? (
            <div className="mt-8">
              <a href={textoWhatsapp(telefono)} className="block">
                <Boton>
                  <span className="flex items-center justify-center gap-2">
                    <MessageCircle size={18} />
                    Pedir mi enlace por WhatsApp
                  </span>
                </Boton>
              </a>
            </div>
          )
        : (
            <p className="mt-8 rounded-xl bg-black/5 px-4 py-3 text-[13px] texto-tenue dark:bg-white/5">
              Contacta al negocio para recibir tu enlace.
            </p>
          )}
    </div>
  )
}
