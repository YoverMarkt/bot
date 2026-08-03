import { useCallback, useEffect, useMemo, useState } from 'react'
import { BedDouble, Check, ChevronLeft, Clock, Search, Users } from 'lucide-react'
import { getMe, quoteStay, requestStay } from '../lib/api'
import { Aviso, Boton, Contador, Foto, Hoja } from '../components/ui'
import { money } from '../lib/format'
import StayDone from './StayDone'
import type { Business, Me, StayOption, StayQuote, StayRequest, StoreStatus } from '../lib/types'

// Flujo de hospedaje.
//
// Una estadía NO es un pedido, y por eso esta pantalla no se parece en nada a
// la de comida: no hay carrito ni "+/− habitaciones". Primero las fechas, y el
// SERVIDOR dice qué hay libre y cuánto cuesta. La app nunca multiplica noches
// por precio: pinta el total que devolvió la cotización oficial.

/** Hoy en el huso de Ecuador, para que el calendario no ofrezca ayer. */
const hoyISO = (): string => {
  const ahora = new Date()
  const local = new Date(ahora.getTime() - ahora.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

const sumarDias = (iso: string, dias: number): string => {
  const [anio, mes, dia] = iso.split('-').map(Number)
  const fecha = new Date(anio, mes - 1, dia + dias)
  const relleno = (valor: number) => String(valor).padStart(2, '0')
  return `${fecha.getFullYear()}-${relleno(fecha.getMonth() + 1)}-${relleno(fecha.getDate())}`
}

const noches = (entrada: string, salida: string): number => {
  if (!entrada || !salida) return 0
  const diferencia = Date.parse(`${salida}T00:00:00`) - Date.parse(`${entrada}T00:00:00`)
  return Math.max(0, Math.round(diferencia / 86400000))
}

export default function StayStore({ slug, business, status, onVolver, onFalloEnlace }: {
  slug: string
  business: Business
  status: StoreStatus
  onVolver?: () => void
  onFalloEnlace: (error: unknown) => Promise<boolean>
}) {
  const [entrada, setEntrada] = useState(hoyISO())
  const [salida, setSalida] = useState(sumarDias(hoyISO(), 1))
  const [adultos, setAdultos] = useState(2)
  const [ninos, setNinos] = useState(0)
  const [habitaciones, setHabitaciones] = useState(1)

  const [cotizacion, setCotizacion] = useState<StayQuote | null>(null)
  const [buscando, setBuscando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [elegida, setElegida] = useState<StayOption | null>(null)
  const [nombre, setNombre] = useState('')
  const [notas, setNotas] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [hecho, setHecho] = useState<StayRequest | null>(null)
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    getMe(slug).then(setMe).catch(() => setMe(null))
  }, [slug])

  const totalNoches = useMemo(() => noches(entrada, salida), [entrada, salida])
  const fechasValidas = totalNoches > 0

  // Salir antes de entrar no existe: se corrige sola en vez de reclamar.
  const cambiarEntrada = (valor: string) => {
    setEntrada(valor)
    if (noches(valor, salida) <= 0) setSalida(sumarDias(valor, 1))
    setCotizacion(null)
  }

  const buscar = useCallback(async () => {
    setBuscando(true)
    setError(null)
    setCotizacion(null)
    try {
      const resultado = await quoteStay(slug, {
        checkIn: entrada,
        checkOut: salida,
        adults: adultos,
        children: ninos,
        rooms: habitaciones,
      })
      setCotizacion(resultado)
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError(error instanceof Error ? error.message : 'No pudimos consultar disponibilidad')
    } finally {
      setBuscando(false)
    }
  }, [slug, entrada, salida, adultos, ninos, habitaciones, onFalloEnlace])

  const solicitar = useCallback(async () => {
    if (!elegida) return
    setEnviando(true)
    setError(null)
    try {
      const solicitud = await requestStay(slug, {
        roomTypeId: elegida.roomTypeId,
        name: (nombre || me?.name || '').trim(),
        notes: notas.trim() || undefined,
      })
      setHecho(solicitud)
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError(error instanceof Error ? error.message : 'No pudimos registrar la solicitud')
    } finally {
      setEnviando(false)
    }
  }, [slug, elegida, nombre, notas, me, onFalloEnlace])

  if (hecho) return <StayDone business={business} request={hecho} />

  const puedeSolicitar = cotizacion?.canRequest ?? (status === 'abierta')
  const nombreFinal = (nombre || me?.name || '').trim()

  return (
    <div className="mx-auto min-h-full max-w-lg pb-10">
      <header className="superficie sticky top-0 z-30 border-b borde-tema">
        <div className="flex items-center gap-3 px-4 pt-seguro pb-3">
          {onVolver && (
            <button onClick={onVolver} aria-label="Volver" className="-ml-1 shrink-0">
              <ChevronLeft size={22} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] leading-tight font-extrabold">{business.name}</h1>
            <p className="truncate text-[12.5px] texto-tenue">
              {business.slogan || 'Consulta disponibilidad'}
            </p>
          </div>
        </div>
      </header>

      {!puedeSolicitar && (
        <div className="px-4 pt-4">
          <Aviso tono="alerta">
            <span className="flex items-center gap-2">
              <Clock size={15} />
              {status === 'cerrada'
                ? 'Ahora está cerrado. Puedes consultar precios y solicitar cuando abra.'
                : 'No se están recibiendo solicitudes en este momento.'}
            </span>
          </Aviso>
        </div>
      )}

      {/* ── Fechas y huéspedes ── */}
      <section className="px-4 pt-5">
        <div className="superficie space-y-4 rounded-2xl border borde-tema p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold tracking-wide uppercase texto-tenue">
                Entrada
              </span>
              <input
                type="date"
                value={entrada}
                min={hoyISO()}
                onChange={event => cambiarEntrada(event.target.value)}
                className="w-full rounded-xl border borde-tema bg-transparent px-3 py-2.5 text-[14px] outline-none focus:border-marca"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold tracking-wide uppercase texto-tenue">
                Salida
              </span>
              <input
                type="date"
                value={salida}
                min={sumarDias(entrada, 1)}
                onChange={(event) => { setSalida(event.target.value); setCotizacion(null) }}
                className="w-full rounded-xl border borde-tema bg-transparent px-3 py-2.5 text-[14px] outline-none focus:border-marca"
              />
            </label>
          </div>

          {fechasValidas && (
            <p className="text-[13px] font-semibold texto-tenue">
              {totalNoches} {totalNoches === 1 ? 'noche' : 'noches'}
            </p>
          )}

          {[
            { texto: 'Adultos', valor: adultos, set: setAdultos, minimo: 1 },
            { texto: 'Niños', valor: ninos, set: setNinos, minimo: 0 },
            { texto: 'Habitaciones', valor: habitaciones, set: setHabitaciones, minimo: 1 },
          ].map(({ texto, valor, set, minimo }) => (
            <div key={texto} className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                <Users size={16} className="texto-tenue" />
                {texto}
              </span>
              <Contador
                valor={valor}
                minimo={minimo}
                maximo={20}
                onCambiar={(nuevo) => { set(nuevo); setCotizacion(null) }}
              />
            </div>
          ))}

          <Boton onClick={buscar} disabled={buscando || !fechasValidas}>
            <span className="flex items-center justify-center gap-2">
              <Search size={17} />
              {buscando ? 'Buscando…' : 'Ver disponibilidad'}
            </span>
          </Boton>
        </div>
      </section>

      {error && <div className="px-4 pt-4"><Aviso tono="alerta">{error}</Aviso></div>}

      {/* ── Resultados ── */}
      {cotizacion && (
        <section className="px-4 pt-6">
          <h2 className="mb-3 text-[19px] font-extrabold tracking-tight">
            {cotizacion.options.length
              ? `Disponible · ${cotizacion.nights} ${cotizacion.nights === 1 ? 'noche' : 'noches'}`
              : 'Sin disponibilidad'}
          </h2>

          {!cotizacion.options.length && (
            <p className="text-[15px] leading-relaxed texto-tenue">
              No hay habitaciones libres para todo ese periodo. Prueba con otras fechas.
            </p>
          )}

          <div className="space-y-3">
            {cotizacion.options.map(opcion => (
              <article
                key={opcion.roomTypeId}
                className="superficie overflow-hidden rounded-2xl border borde-tema"
              >
                <Foto url={opcion.mediaUrls[0] || null} alto="h-40" nombre={opcion.name} />
                <div className="p-4">
                  <h3 className="text-[16px] leading-snug font-bold">{opcion.name}</h3>
                  {opcion.description && (
                    <p className="mt-1 line-clamp-2 text-[13px] leading-snug texto-tenue">
                      {opcion.description}
                    </p>
                  )}

                  <p className="mt-2 flex items-center gap-3 text-[12.5px] texto-tenue">
                    <span className="flex items-center gap-1">
                      <Users size={13} />
                      Hasta {opcion.maxGuests}
                    </span>
                    <span className="flex items-center gap-1">
                      <BedDouble size={13} />
                      {opcion.unitsRequired}
                      {' '}
                      {opcion.unitsRequired === 1 ? 'habitación' : 'habitaciones'}
                    </span>
                  </p>

                  {opcion.amenities.length > 0 && (
                    <p className="mt-2 flex flex-wrap gap-1.5">
                      {opcion.amenities.slice(0, 4).map(comodidad => (
                        <span
                          key={comodidad}
                          className="rounded-full bg-black/5 px-2.5 py-1 text-[11.5px] font-medium dark:bg-white/10"
                        >
                          {comodidad}
                        </span>
                      ))}
                    </p>
                  )}

                  <div className="mt-4 flex items-end justify-between gap-3">
                    <div>
                      {/* El total sale de la cotización oficial: la app no
                          multiplica noches por precio. */}
                      <p className="text-[22px] leading-none font-extrabold tabular-nums">
                        {money(opcion.total, opcion.currency)}
                      </p>
                      <p className="mt-1 text-[11.5px] texto-tenue">
                        {cotizacion.nights}
                        {' '}
                        {cotizacion.nights === 1 ? 'noche' : 'noches'}
                        {opcion.pricesIncludeTax ? ' · impuestos incluidos' : ' · más impuestos'}
                      </p>
                    </div>
                    <button
                      onClick={() => setElegida(opcion)}
                      disabled={!puedeSolicitar}
                      className="shrink-0 rounded-xl bg-marca px-5 py-3 text-[14px] font-bold text-white disabled:opacity-40"
                    >
                      Solicitar
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* ── Confirmación ── */}
      <Hoja
        abierta={Boolean(elegida)}
        onCerrar={() => setElegida(null)}
        titulo={elegida?.name || ''}
      >
        <div className="space-y-5 p-4">
          <Aviso tono="alerta">
            Vas a <strong>solicitar</strong> esta habitación. Queda apartada mientras el equipo
            la revisa; no es una reserva confirmada ni se cobra nada ahora.
          </Aviso>

          <div className="superficie divide-y divide-[var(--linea)] overflow-hidden rounded-xl border borde-tema">
            <div className="flex justify-between px-4 py-3 text-[14px]">
              <span className="texto-tenue">Fechas</span>
              <span className="font-semibold">{entrada} → {salida}</span>
            </div>
            <div className="flex justify-between px-4 py-3 text-[14px]">
              <span className="texto-tenue">Huéspedes</span>
              <span className="font-semibold">
                {adultos + ninos} · {habitaciones}
                {habitaciones === 1 ? ' habitación' : ' habitaciones'}
              </span>
            </div>
            <div className="flex items-baseline justify-between px-4 py-3.5">
              <span className="text-[14px] font-semibold texto-tenue">Total</span>
              <span className="text-[22px] font-extrabold tabular-nums">
                {money(elegida?.total, elegida?.currency)}
              </span>
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[12px] font-bold tracking-wide uppercase texto-tenue">
              Nombre de quien se hospeda
            </span>
            <input
              value={nombre || me?.name || ''}
              onChange={event => setNombre(event.target.value.slice(0, 120))}
              placeholder="Nombre y apellido"
              className="w-full rounded-xl border borde-tema bg-transparent px-3.5 py-3 text-[14px] outline-none focus:border-marca"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[12px] font-bold tracking-wide uppercase texto-tenue">
              Algo que debamos saber
            </span>
            <textarea
              value={notas}
              onChange={event => setNotas(event.target.value.slice(0, 300))}
              rows={2}
              placeholder="Hora de llegada, cuna, alergias…"
              className="w-full resize-none rounded-xl border borde-tema bg-transparent px-3.5 py-3 text-[14px] outline-none focus:border-marca"
            />
          </label>

          {error && <Aviso tono="alerta">{error}</Aviso>}
        </div>

        <div className="superficie sticky bottom-0 border-t borde-tema px-4 pt-3 pb-seguro">
          <Boton
            onClick={solicitar}
            disabled={enviando || !puedeSolicitar || nombreFinal.length < 2}
          >
            <span className="flex items-center justify-center gap-2">
              <Check size={17} />
              {enviando
                ? 'Enviando…'
                : nombreFinal.length < 2 ? 'Escribe el nombre' : 'Enviar solicitud'}
            </span>
          </Boton>
        </div>
      </Hoja>
    </div>
  )
}
