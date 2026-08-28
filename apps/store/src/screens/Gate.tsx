import {
  RiLockLine,
  RiStore2Line,
  RiWhatsappLine,
} from '@remixicon/react'
import { Boton } from '../components/ui'
import type { Business } from '../lib/types'

// Lo que ve quien NO puede usar la tienda.
//
// El caso importante es el enlace reenviado: alguien recibe por un grupo el
// enlace de otra persona y lo abre. La app no lo trata como un error técnico
// —no lo es— sino que le explica que cada enlace es personal y le da el botón
// para pedir el suyo al negocio. Es la diferencia entre perder un cliente y
// ganarlo.

/**
 * Motivos que devuelve el servidor al rechazar la sesión.
 *
 * ⚠️ Los textos cambian según A QUIÉN hay que escribirle, y eso no es un
 * matiz de estilo: es la diferencia entre que la persona resuelva o se quede
 * dando vueltas.
 *
 * En el marketplace **el enlace no se pide: NACE de elegir un local**. El
 * cliente escribe a Umbani, el bot le enseña las categorías, elige su local y
 * `mandarElEnlace` le emite su sesión en ese momento. Decirle «escríbele al
 * negocio» —como decía hasta el 2026-08-30— lo manda a buscar un WhatsApp que
 * ese local no tiene, porque en el marketplace ninguno tiene número propio.
 *
 * Con canal propio sigue valiendo el texto de siempre.
 */
const MENSAJES: Record<string, { titulo: string; detalle: (donde: string) => string }> = {
  otro_dispositivo: {
    titulo: 'Este enlace es de otra persona',
    detalle: donde => 'Cada enlace se abre en un solo teléfono, para que nadie '
      + `pida a nombre de otro. ${donde} y te llega el tuyo al instante.`,
  },
  // Los enlaces nuevos ya no caducan (2026-08-02). Este mensaje solo lo ven
  // los que quedaban vivos de antes, hasta que la limpieza se los lleve.
  caducada: {
    titulo: 'Tu enlace expiró',
    detalle: donde => 'Era de los antiguos, que duraban unas horas. '
      + `${donde} y recibes uno nuevo — ese ya no vence.`,
  },
  revocada: {
    titulo: 'Este enlace ya no está activo',
    detalle: donde => `${donde} y te llega uno nuevo.`,
  },
  otro_negocio: {
    titulo: 'Este enlace es de otro local',
    detalle: donde => 'El enlace que abriste pertenece a otra tienda. '
      + `${donde} para pedir aquí.`,
  },
  no_existe: {
    titulo: 'Necesitas tu propio enlace',
    detalle: donde => 'Puedes mirar la carta, pero para pedir hace falta tu '
      + `enlace personal. ${donde}: te llega al instante.`,
  },
}

/**
 * El enlace a WhatsApp, con el mensaje ya escrito.
 *
 * ⚠️ En el marketplace se NOMBRA el local. El bot de Umbani busca por texto
 * libre, así que escribir «quiero pedir en Monster Pizza» lo lleva directo a
 * ese local en vez de empezar por las categorías. Y si la búsqueda no lo
 * encontrara, el cliente recibe el menú de siempre: no se pierde nada.
 *
 * Con canal propio se deja el saludo de antes: ahí no hay nada que elegir.
 */
const textoWhatsapp = (telefono: string, negocio: string, esPlataforma: boolean): string => {
  const limpio = telefono.replace(/[^\d]/g, '')
  const mensaje = encodeURIComponent(
    esPlataforma && negocio
      ? `Hola, quiero pedir en ${negocio} 🙂`
      : 'Hola, quiero ver el menú 🙂',
  )
  return `https://wa.me/${limpio}?text=${mensaje}`
}

export default function Gate({ business, motivo }: {
  business: Business | null
  motivo: string | null
}) {
  const { titulo, detalle } = MENSAJES[motivo || 'no_existe'] || MENSAJES.no_existe
  const telefono = business?.phone || ''
  const nombre = business?.name || ''
  // Con el número del MARKETPLACE hay un paso más que nombrar: elegir el local.
  // Es el paso que EMITE el enlace, así que callarlo deja a la persona
  // esperando algo que no va a llegar sola.
  const esPlataforma = Boolean(business?.phoneIsPlatform)
  // ⚠️ SIN asteriscos. `*así*` pone negrita en WhatsApp, pero esto es una
  // pantalla HTML: salían literales, «elige *Monster Pizza*». El énfasis de
  // WhatsApp solo vale en los textos que viajan por el chat.
  const donde = esPlataforma
    ? `Escríbele a Umbani por WhatsApp y elige ${nombre || 'tu local'}`
    : 'Escríbele al negocio por WhatsApp'

  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 pt-[calc(env(safe-area-inset-top)+3rem)] pb-12">
      {/* ⚠️ El candado va en TINTA sobre el tinte de marca, no en `text-marca`.
          El color del negocio como color de LETRA da 1,80:1 sobre blanco con
          el verde real de Monster Pizza y 1,19:1 con el lima de la plataforma,
          donde AA exige 4,5. El tinte de fondo sí es un uso legítimo del
          acento —es fondo, no letra— y deja la marca presente sin apagar el
          símbolo. El acento sólido se reserva para lo accionable, que aquí es
          el botón de abajo. */}
      <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-marca-suave shadow-tarjeta">
        <RiLockLine size={24} />
      </div>

      {business?.name && (
        <p className="caption mb-2 flex items-center gap-1.5 font-bold texto-cuerpo">
          <RiStore2Line size={14} />
          {business.name}
        </p>
      )}

      <h1 className="titulo-xl">{titulo}</h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">{detalle(donde)}</p>

      {telefono
        ? (
            <div className="mt-8">
              <a href={textoWhatsapp(telefono, nombre, esPlataforma)} className="block">
                <Boton>
                  <span className="flex items-center justify-center gap-2">
                    <RiWhatsappLine size={18} />
                    {esPlataforma ? 'Escribir a Umbani' : 'Pedir mi enlace por WhatsApp'}
                  </span>
                </Boton>
              </a>
            </div>
          )
        : (
            <p className="superficie mt-8 rounded-2xl px-4 py-3.5 text-[13.5px] texto-cuerpo shadow-tarjeta">
              Contacta al negocio para recibir tu enlace.
            </p>
          )}
    </div>
  )
}
