import { useState } from 'react'
import { RiCheckLine, RiFocus3Line, RiMapPin2Line } from '@remixicon/react'
import { Boton } from './ui'
import { MENSAJES, pedirUbicacion } from '../lib/ubicacion'
import type { Ubicacion } from '../lib/ubicacion'
import type { NuevaDireccion } from '../lib/types'

// ── ESCRIBIR UNA DIRECCIÓN, EN UN SOLO SITIO ───────────────────────────────
//
// Antes esto existía DOS veces: la pantalla «¿A dónde te lo llevamos?» que
// salta al primer «Agregar», y un formulario propio dentro del checkout. Hacían
// lo mismo con distinta cara, y el cliente tenía que aprender las dos.
//
// El del checkout además ponía el pin ABAJO, como opción secundaria, detrás
// de un `select`. Y el pin es justo el dato que hace que el repartidor llegue:
// una dirección escrita —«Av. Amazonas, casa azul»— puede ser cualquier sitio
// en un barrio sin numerar; una coordenada, no. Enterrarlo empujaba al camino
// peor. Lo vio el dueño probando La Abuelita (2026-09-19): «que salga mejor esa
// pantalla».
//
// Así que gana la buena y vive aquí. El pedido de un toque va PRIMERO y es lo
// más grande de la pantalla, porque escribir en el teclado de un móvil es la
// parte cara.

/**
 * Los mismos cinco valores que acepta el CHECK de `customer_addresses`. Si
 * alguien añade uno aquí sin añadirlo allí, la base rechaza la dirección
 * entera — por eso los textos se separan de los valores.
 *
 * ⚠️ Las cápsulas son TAMBIÉN la etiqueta de la dirección. Hubo un campo de
 * texto libre además —«Casa, Oficina…»— y preguntaba dos veces lo mismo: el
 * cliente escribía «Casa» arriba y volvía a tocar «Casa» abajo. Peor, podía
 * escribir «Fffffff» y quedarse con una libreta que no distingue una de otra.
 * Eligiendo, no hay forma de fallar, y `building_type` y `label` no pueden
 * contradecirse.
 */
const TIPOS_DE_EDIFICIO = [
  { valor: 'casa', texto: 'Casa' },
  { valor: 'departamento', texto: 'Departamento' },
  { valor: 'oficina', texto: 'Oficina' },
  { valor: 'hotel', texto: 'Hotel' },
  { valor: 'otro', texto: 'Otro' },
] as const

export default function FormularioDireccion({ onGuardar, onListo, textoGuardar = 'Guardar mi dirección' }: {
  /** Devuelve el id de la dirección creada, o null si no se pudo. */
  onGuardar: (datos: NuevaDireccion) => Promise<string | null>
  /** Se llama solo si se guardó de verdad. Quien lo use decide a dónde va. */
  onListo: () => void
  textoGuardar?: string
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
    try {
      const resultado = await pedirUbicacion()
      if (!resultado.ok) return setAviso(resultado.mensaje || MENSAJES.no_disponible)
      setPin(resultado.ubicacion)
    } catch {
      // Ni un fallo inesperado puede dejar al cliente sin poder pedir.
      setAviso(MENSAJES.no_disponible)
    } finally {
      setUbicando(false)
    }
  }

  // ⚠️ El pin NO sustituye a la calle escrita. Una coordenada lleva al
  // repartidor a la puerta del edificio, pero no le dice el piso ni cómo se
  // llama la casa, y en un barrio sin numerar la referencia es lo único que
  // sirve. Por eso guardar exige la dirección aunque haya pin.
  const listo = direccion.trim().length >= 6

  const guardar = async () => {
    if (!listo || guardando) return
    setGuardando(true)
    try {
      const id = await onGuardar({
        label: TIPOS_DE_EDIFICIO.find(item => item.valor === tipo)?.texto || 'Casa',
        address: direccion.trim(),
        reference: referencia.trim(),
        buildingType: tipo,
        ...(pin ? { latitude: pin.latitude, longitude: pin.longitude, accuracy: pin.accuracy } : {}),
      })
      if (id) onListo()
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* El camino de un toque va PRIMERO y es el más grande: escribir una
          dirección en un teclado de móvil es la parte cara. */}
      <button
        type="button"
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

        <div className="sin-barra -mx-4 flex gap-2 overflow-x-auto px-4">
          {TIPOS_DE_EDIFICIO.map(({ valor, texto }) => (
            <button
              key={valor}
              type="button"
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
        {guardando ? 'Guardando…' : textoGuardar}
      </Boton>
    </div>
  )
}
