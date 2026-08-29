import { useState } from 'react'
import {
  RiPhoneLine,
  RiWhatsappLine,
} from '@remixicon/react'
import { Boton, LocalDeLaPuerta, SelloDePuerta } from '../components/ui'
import type { Business } from '../lib/types'

// La puerta del enlace.
//
// El enlace ya no caduca, así que lo que lo protege es esto: para usarlo hay
// que saber a qué número de WhatsApp se emitió.
//
// Antes bastaba con abrirlo primero, y eso tenía un fallo que se veía en
// cuanto alguien reenviaba el enlace ANTES de abrirlo: el amigo hacía clic, se
// quedaba la sesión, y el cliente legítimo recibía «ya lo está usando otra
// persona» sobre un enlace suyo. Quedaba fuera de su propia tienda por haber
// sido educado.
//
// Ahora entra quien demuestre el número. Y de paso se arregla algo que antes
// era un portazo: el cliente que cambia de teléfono vuelve a entrar solo.
//
// Se pide el número entero y no los últimos dígitos: escribir el suyo es lo
// más natural del mundo, y "los últimos 4" se adivinan mucho antes.

const textoWhatsapp = (telefono: string): string => {
  const limpio = telefono.replace(/[^\d]/g, '')
  const mensaje = encodeURIComponent('Hola, quiero ver el menú 🙂')
  return `https://wa.me/${limpio}?text=${mensaje}`
}

export default function Confirmar({ business, onConfirmar }: {
  business: Business | null
  /** Devuelve null si entró; el texto del error si no. */
  onConfirmar: (telefono: string) => Promise<string | null>
}) {
  const [telefono, setTelefono] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  const suficiente = telefono.replace(/\D/g, '').length >= 8

  async function enviar() {
    if (!suficiente || enviando) return
    setEnviando(true)
    setError(null)
    const fallo = await onConfirmar(telefono)
    // Si entró, App desmonta esta pantalla: no hay que apagar `enviando`.
    if (fallo) {
      setError(fallo)
      setEnviando(false)
    }
  }

  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 pt-[calc(env(safe-area-inset-top)+3rem)] pb-12">
      {/* Las tres puertas se pintan IGUAL a propósito: el cliente puede verlas
          seguidas —enlace ajeno, confirmar número— y si cada una tuviera su
          composición parecerían tres apps distintas fallando. */}
      <LocalDeLaPuerta nombre={business?.name} logoUrl={business?.logoUrl} />

      <SelloDePuerta><RiPhoneLine size={26} /></SelloDePuerta>

      <h1 className="titulo-xl">
        Confirma tu número
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">
        Escribe el número de WhatsApp con el que le escribiste al negocio. Es
        para que nadie más pueda pedir a tu nombre.
      </p>

      <form
        className="mt-8"
        onSubmit={(evento) => { evento.preventDefault(); void enviar() }}
      >
        <label htmlFor="telefono" className="sr-only">Número de WhatsApp</label>
        <input
          id="telefono"
          // `tel` abre el teclado numérico en el móvil, que es donde se abre
          // esto siempre. `autoComplete` deja que el teléfono lo rellene solo.
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          autoFocus
          value={telefono}
          onChange={(evento) => { setTelefono(evento.target.value); setError(null) }}
          placeholder="Ej. 0999 111 222"
          // ⚠️ El foco en TINTA, no en el color del negocio. Aquí decía que un
          // borde sí podía llevar el acento «porque es borde, no letra», y no
          // se sostiene: un borde de foco PORTA INFORMACIÓN —dice dónde estás
          // escribiendo— y por eso necesita 3:1, que el lima de la plataforma
          // (1,19:1) no da. Además ahora todos los campos de la app enfocan
          // igual: ficha, checkout, dirección y este.
          className="superficie w-full rounded-(--radius-tarjeta) border-2 borde-tema px-4 py-4 text-[17px] font-semibold tracking-tight shadow-tarjeta outline-none focus:border-(--tinta)"
        />

        {error && (
          <p className="mt-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13.5px] font-semibold text-amber-700">
            {error}
          </p>
        )}

        <div className="mt-4">
          <Boton type="submit" disabled={!suficiente || enviando}>
            {enviando ? 'Comprobando…' : 'Entrar'}
          </Boton>
        </div>
      </form>

      {/* La salida para quien recibió el enlace de otra persona: no se le deja
          en un callejón, se le da el camino para tener el suyo. */}
      {business?.phone && (
        <a
          href={textoWhatsapp(business.phone)}
          className="mt-6 flex items-center justify-center gap-2 py-2 text-[14px] font-semibold texto-cuerpo"
        >
          <RiWhatsappLine size={16} />
          No es mi enlace, quiero el mío
        </a>
      )}
    </div>
  )
}
