import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

// Piezas compartidas por los dos flujos (comida y hospedaje). Deliberadamente
// pocas y sin librería de componentes: la tienda vive de cargar rápido.

export function Boton({ children, onClick, disabled, variante = 'principal', type = 'button' }: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variante?: 'principal' | 'suave' | 'linea'
  type?: 'button' | 'submit'
}) {
  const estilos = {
    principal: 'bg-marca text-white active:bg-marca/90 disabled:opacity-40',
    suave: 'bg-marca-suave text-marca active:opacity-80 disabled:opacity-40',
    linea: 'superficie border borde-tema active:opacity-70 disabled:opacity-40',
  }[variante]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-xl px-4 py-3.5 text-[15px] font-semibold transition ${estilos}`}
    >
      {children}
    </button>
  )
}

/** Hoja que sube desde abajo. Es el patrón que la gente ya conoce del móvil. */
export function Hoja({ abierta, onCerrar, children, titulo }: {
  abierta: boolean
  onCerrar: () => void
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
      <div className="animar-hoja superficie relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl sm:rounded-2xl sm:mb-6">
        <div className="superficie sticky top-0 z-10 flex items-center justify-between border-b borde-tema px-4 py-3">
          <h2 className="truncate pr-3 text-[15px] font-bold">{titulo}</h2>
          <button
            onClick={onCerrar}
            aria-label="Cerrar"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
          >
            <X size={17} />
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
    <div className="flex items-center gap-1 rounded-full border borde-tema p-1">
      <button
        onClick={() => onCambiar(Math.max(minimo, valor - 1))}
        disabled={valor <= minimo}
        aria-label="Quitar uno"
        className="flex size-9 items-center justify-center rounded-full text-lg font-bold disabled:opacity-30"
      >
        −
      </button>
      <span className="min-w-7 text-center text-[15px] font-bold tabular-nums">{valor}</span>
      <button
        onClick={() => onCambiar(Math.min(maximo, valor + 1))}
        disabled={valor >= maximo}
        aria-label="Agregar uno"
        className="flex size-9 items-center justify-center rounded-full text-lg font-bold disabled:opacity-30"
      >
        +
      </button>
    </div>
  )
}

export function Aviso({ tono = 'info', children }: { tono?: 'info' | 'alerta'; children: ReactNode }) {
  const estilo = tono === 'alerta'
    ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
    : 'bg-marca-suave text-marca'
  return (
    <div className={`rounded-xl px-3.5 py-2.5 text-[13px] font-medium ${estilo}`}>
      {children}
    </div>
  )
}

/** Imagen del catálogo. Si el negocio no cargó foto, no se deja un hueco roto. */
export function Foto({ url, alto, nombre }: { url: string | null; alto: string; nombre: string }) {
  if (!url) {
    return (
      <div className={`flex ${alto} items-center justify-center bg-black/5 dark:bg-white/5`}>
        <span className="px-2 text-center text-[11px] font-semibold texto-tenue line-clamp-2">
          {nombre}
        </span>
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={nombre}
      loading="lazy"
      decoding="async"
      className={`${alto} w-full object-cover`}
    />
  )
}
