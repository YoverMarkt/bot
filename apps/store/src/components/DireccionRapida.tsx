import { Hoja } from './ui'
import FormularioDireccion from './FormularioDireccion'
import type { NuevaDireccion } from '../lib/types'

// ── ¿A DÓNDE TE LO LLEVAMOS? ───────────────────────────────────────────────
//
// Se pide la dirección en el PRIMER «Agregar», no al entrar.
//
// El dueño quería el registro nada más abrir la app (2026-08-27). Se propuso
// esto en su lugar y lo eligió, por dos motivos que no son de gusto:
//
//  1. `DISENO-MINIAPP.md` dice que la carta se ve SIN enlace, y no es un
//     capricho: un enlace de comida se reenvía por un grupo, y quien lo abre
//     tiene que poder mirar antes de dar su número. Con un muro al entrar,
//     esa persona se va sin ver un solo producto.
//  2. Pedir datos al entrar ya rompió algo real: la confirmación del teléfono
//     era una fase del armazón, así que desmontaba la tienda entera y **con
//     ella el carrito**. Se arregló pintándola ENCIMA. Un muro nuevo al
//     arranque es el mismo error con otro nombre.
//
// El primer «Agregar» captura lo mismo y en mejor momento: esa persona ya
// decidió comprar, así que dar su dirección es parte de lo que vino a hacer,
// no un peaje antes de saber si le interesa.
//
// ⚠️ Y se puede CERRAR. El checkout vuelve a pedir la dirección de todas
// formas y ahí sí es obligatoria —sin ella no hay a dónde repartir—, así que
// bloquear aquí no gana un solo dato: solo impide meter cosas al carrito, que
// es justo lo contrario de lo que se quiere en ese instante.
//
// ⚠️ El teléfono NO se pide aquí. Quien llega por el enlace del bot ya está
// identificado —la sesión lleva su número—, así que preguntárselo sería pedir
// dos veces lo mismo. A quien no lo tenga se lo pide `Confirmar.tsx` cuando
// intente pedir, que es donde hace falta de verdad.
//
// ⚠️ El formulario en sí vive en `FormularioDireccion` y lo comparte con el
// checkout. Esta hoja solo pone el marco: el título, la frase que explica para
// qué se pide, y la salida.

export default function DireccionRapida({ abierta, onCerrar, onGuardar }: {
  abierta: boolean
  onCerrar: () => void
  /** Devuelve el id de la dirección creada, o null si no se pudo. */
  onGuardar: (datos: NuevaDireccion) => Promise<string | null>
}) {
  return (
    <Hoja abierta={abierta} onCerrar={onCerrar} titulo="¿A dónde te lo llevamos?">
      <div className="space-y-4 p-4 pb-6">
        <p className="text-[14px] leading-relaxed texto-cuerpo">
          Guárdala una vez y no te la volvemos a pedir. La usamos solo para
          llevarte el pedido.
        </p>

        <FormularioDireccion onGuardar={onGuardar} onListo={onCerrar} />

        {/* La salida. El checkout la vuelve a pedir y ahí sí es obligatoria:
            bloquear aquí no ganaría ningún dato, solo impediría comprar. */}
        <button
          onClick={onCerrar}
          className="w-full py-2 text-[14px] font-semibold texto-cuerpo transition active:scale-[0.98]"
        >
          Ahora no, sigo viendo
        </button>
      </div>
    </Hoja>
  )
}
