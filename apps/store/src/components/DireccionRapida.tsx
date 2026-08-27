import { useState } from 'react'
import { RiCheckLine, RiFocus3Line, RiMapPin2Line } from '@remixicon/react'
import { Boton, Hoja } from './ui'
import { MENSAJES, pedirUbicacion } from '../lib/ubicacion'
import type { Ubicacion } from '../lib/ubicacion'
import type { NuevaDireccion } from './CartSheet'

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

const TIPOS_DE_EDIFICIO = [
  { valor: 'casa', texto: 'Casa' },
  { valor: 'departamento', texto: 'Departamento' },
  { valor: 'oficina', texto: 'Oficina' },
  { valor: 'hotel', texto: 'Hotel' },
  { valor: 'otro', texto: 'Otro' },
] as const

export default function DireccionRapida({ abierta, onCerrar, onGuardar }: {
  abierta: boolean
  onCerrar: () => void
  /** Devuelve el id de la dirección creada, o null si no se pudo. */
  onGuardar: (datos: NuevaDireccion) => Promise<string | null>
}) {
  const [direccion, setDireccion] = useState('')
  const [referencia, setReferencia] = useState('')
  const [tipo, setTipo] = useState<string>('casa')
  const [pin, setPin] = useState<Ubicacion | null>(null)
  const [ubicando, setUbicando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [guardando, setGuardando] = useState(false)

  const capturar = async () => {
    setUbicando(true)
    setAviso(null)
    const resultado = await pedirUbicacion()
    setUbicando(false)
    if (!resultado.ok) return setAviso(resultado.mensaje || MENSAJES.no_disponible)
    setPin(resultado.ubicacion)
  }

  // ⚠️ El pin NO sustituye a la calle escrita. Una coordenada lleva al
  // repartidor a la puerta del edificio, pero no le dice el piso ni cómo se
  // llama la casa, y en un barrio sin numerar la referencia es lo único que
  // sirve. Por eso guardar exige la dirección aunque haya pin.
  const listo = direccion.trim().length >= 6

  const guardar = async () => {
    if (!listo || guardando) return
    setGuardando(true)
    const id = await onGuardar({
      label: TIPOS_DE_EDIFICIO.find(t => t.valor === tipo)?.texto || 'Casa',
      address: direccion.trim(),
      reference: referencia.trim(),
      buildingType: tipo,
      ...(pin ? { latitude: pin.latitude, longitude: pin.longitude, accuracy: pin.accuracy } : {}),
    })
    setGuardando(false)
    if (id) onCerrar()
  }

  return (
    <Hoja abierta={abierta} onCerrar={onCerrar} titulo="¿A dónde te lo llevamos?">
      <div className="space-y-4 p-4 pb-6">
        <p className="text-[14px] leading-relaxed texto-cuerpo">
          Guárdala una vez y no te la volvemos a pedir. La usamos solo para
          llevarte el pedido.
        </p>

        {/* El camino de un toque va PRIMERO y es el más grande: escribir una
            dirección en un teclado de móvil es la parte cara. */}
        <button
          onClick={() => void capturar()}
          disabled={ubicando}
          className={`flex w-full items-center gap-3 rounded-2xl border-2 px-4 py-3.5 text-left transition active:scale-[0.98] ${
            pin ? 'border-emerald-500 bg-emerald-50' : 'borde-tema superficie shadow-tarjeta'
          }`}
        >
          <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
            pin ? 'bg-emerald-500 text-white' : 'acento'
          }`}
          >
            {pin ? <RiCheckLine size={20} /> : <RiFocus3Line size={20} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="titulo-m block">
              {pin ? 'Ubicación lista' : ubicando ? 'Buscándote…' : 'Usar mi ubicación actual'}
            </span>
            <span className="caption block texto-cuerpo">
              {pin
                ? 'El repartidor llegará directo a tu puerta'
                : 'Un toque y sabemos dónde estás'}
            </span>
          </span>
        </button>

        {aviso && (
          <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] font-medium text-amber-700">
            {aviso}
          </p>
        )}

        <div className="space-y-3">
          <label className="block">
            <span className="caption mb-1.5 block texto-tenue">Calle y número</span>
            <div className="flex items-center gap-2 rounded-2xl border-2 borde-tema px-4 py-3 focus-within:border-(--tinta)">
              <RiMapPin2Line size={18} className="shrink-0 texto-tenue" />
              <input
                value={direccion}
                onChange={event => setDireccion(event.target.value.slice(0, 160))}
                placeholder="Av. Amazonas N34-120"
                className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold outline-none placeholder:font-normal placeholder:texto-tenue"
              />
            </div>
          </label>

          <label className="block">
            <span className="caption mb-1.5 block texto-tenue">Referencia (opcional)</span>
            <input
              value={referencia}
              onChange={event => setReferencia(event.target.value.slice(0, 160))}
              placeholder="Edificio Zenith, piso 4, timbre 2"
              className="w-full rounded-2xl border-2 borde-tema px-4 py-3 text-[15px] outline-none focus:border-(--tinta) placeholder:texto-tenue"
            />
          </label>

          {/* La etiqueta la ponen las cápsulas, no un campo de texto: eligiendo
              no hay forma de fallar, y `building_type` y `label` no pueden
              contradecirse. Misma decisión que en el checkout. */}
          <div className="sin-barra -mx-4 flex gap-2 overflow-x-auto px-4">
            {TIPOS_DE_EDIFICIO.map(({ valor, texto }) => (
              <button
                key={valor}
                onClick={() => setTipo(valor)}
                aria-pressed={tipo === valor}
                className={`shrink-0 rounded-full px-4 py-2 text-[13px] font-bold transition active:scale-95 ${
                  tipo === valor ? 'acento shadow-acento' : 'superficie borde-tema border texto-cuerpo'
                }`}
              >
                {texto}
              </button>
            ))}
          </div>
        </div>

        <Boton onClick={() => void guardar()} disabled={!listo || guardando}>
          {guardando ? 'Guardando…' : 'Guardar mi dirección'}
        </Boton>

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
