import { useEffect, type ReactNode } from 'react'
import { ChevronLeft, X } from 'lucide-react'
import { foto } from '../lib/imagen'
import type { AnchoDeFoto } from '../lib/imagen'

// Piezas compartidas por los dos flujos (comida y hospedaje). Deliberadamente
// pocas y sin librería de componentes: la tienda vive de cargar rápido.

export function Boton({ children, onClick, disabled, variante = 'principal', type = 'button' }: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variante?: 'principal' | 'suave' | 'linea'
  type?: 'button' | 'submit'
}) {
  // El principal es TINTA, no el color del negocio: así el botón que cierra el
  // pedido se lee igual aunque el dueño elija un color pálido. El acento se
  // reserva para señalar, no para todo.
  const estilos = {
    principal: 'tinta active:opacity-90 disabled:opacity-40',
    suave: 'acento active:opacity-85 disabled:opacity-40',
    linea: 'superficie border-2 borde-tema active:opacity-70 disabled:opacity-40',
  }[variante]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-2xl px-4 py-4 text-[15px] font-bold tracking-tight transition ${estilos}`}
    >
      {children}
    </button>
  )
}

/** Hoja que sube desde abajo. Es el patrón que la gente ya conoce del móvil. */
export function Hoja({ abierta, onCerrar, onAtras, children, titulo }: {
  abierta: boolean
  onCerrar: () => void
  /** Si el contenido tiene pasos, la flecha vuelve al anterior en vez de cerrar. */
  onAtras?: () => void
  children: ReactNode
  titulo?: string
}) {
  // Con la hoja abierta el fondo no debe desplazarse: se pierde el sitio.
  useEffect(() => {
    if (!abierta) return
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previo }
  }, [abierta])

  if (!abierta) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        aria-label="Cerrar"
        onClick={onCerrar}
        className="absolute inset-0 bg-black/50"
      />
      <div className="animar-hoja superficie relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[1.75rem] sm:mb-6 sm:rounded-[1.75rem]">
        <div className="superficie sticky top-0 z-10 flex items-center gap-2 border-b borde-tema px-5 py-4">
          {/* Volver un paso NO es cerrar: quien está en el checkout y toca la
              flecha quiere revisar su carrito, no perder el pedido entero. */}
          {onAtras && (
            <button
              onClick={onAtras}
              aria-label="Volver"
              className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-full transition active:scale-95"
            >
              <ChevronLeft size={20} />
            </button>
          )}
          <h2 className="flex-1 truncate pr-3 text-[19px] font-extrabold tracking-tight">{titulo}</h2>
          <button
            onClick={onCerrar}
            aria-label="Cerrar"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-black/5"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** +/− de cantidad. El control más tocado de toda la app. */
export function Contador({ valor, onCambiar, minimo = 1, maximo = 99 }: {
  valor: number
  onCambiar: (valor: number) => void
  minimo?: number
  maximo?: number
}) {
  return (
    <div className="flex items-center gap-1 rounded-full border-2 borde-tema p-1">
      <button
        onClick={() => onCambiar(Math.max(minimo, valor - 1))}
        disabled={valor <= minimo}
        aria-label="Quitar uno"
        className="flex size-10 items-center justify-center rounded-full text-xl font-bold transition active:bg-black/5 disabled:opacity-30/10"
      >
        −
      </button>
      <span className="min-w-8 text-center text-[16px] font-extrabold tabular-nums">{valor}</span>
      <button
        onClick={() => onCambiar(Math.min(maximo, valor + 1))}
        disabled={valor >= maximo}
        aria-label="Agregar uno"
        className="flex size-10 items-center justify-center rounded-full text-xl font-bold transition active:bg-black/5 disabled:opacity-30/10"
      >
        +
      </button>
    </div>
  )
}

export function Aviso({ tono = 'info', children }: { tono?: 'info' | 'alerta'; children: ReactNode }) {
  // El aviso informativo va sobre el acento del negocio, con su texto legible
  // calculado; el de alerta se queda ámbar siempre, porque «ojo» no es marca.
  const estilo = tono === 'alerta'
    ? 'bg-amber-500/15 text-amber-700'
    : 'acento'
  return (
    <div className={`rounded-2xl px-4 py-3 text-[13.5px] font-semibold ${estilo}`}>
      {children}
    </div>
  )
}

/**
 * Imagen del catálogo. Si el negocio no cargó foto, no se deja un hueco roto.
 *
 * El caso sin foto es HOY el normal —ningún producto tiene imagen todavía—, así
 * que el marcador no es un error que tapar: lleva la inicial grande sobre un
 * tinte del color del negocio y sostiene la rejilla mientras tanto. El tamaño
 * se reserva igual en los dos casos para que la lista no salte al cargar.
 */
export function Foto({ url, alto, uso, nombre }: {
  url: string | null
  /** La clase de altura, que sostiene la rejilla mientras la imagen llega. */
  alto: string
  /** Para qué es: decide el ancho que se le pide a Cloudinary. */
  uso: AnchoDeFoto
  nombre: string
}) {
  const fuente = foto(url, uso)
  if (!fuente) {
    return (
      <div className={`marcador flex ${alto} w-full items-center justify-center overflow-hidden`}>
        <span
          aria-hidden
          className="text-[2.75rem] leading-none font-black tracking-tight opacity-30 select-none"
        >
          {nombre.trim().charAt(0).toUpperCase()}
        </span>
      </div>
    )
  }
  return (
    <img
      src={fuente}
      alt={nombre}
      loading="lazy"
      decoding="async"
      className={`${alto} w-full object-cover`}
    />
  )
}
