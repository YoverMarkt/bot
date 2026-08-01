import { BedDouble, ChevronRight, UtensilsCrossed } from 'lucide-react'
import type { Business } from '../lib/types'

// Solo aparece cuando el negocio hace las dos cosas (el hostal con restaurante).
// Preguntar es mejor que adivinar: el que viene a dormir y el que viene a comer
// necesitan pantallas distintas desde el primer toque.

export default function Picker({ business, onElegir }: {
  business: Business
  onElegir: (seccion: 'pedido' | 'estadia') => void
}) {
  const opciones = [
    {
      id: 'estadia' as const,
      icono: BedDouble,
      titulo: 'Reservar una estadía',
      detalle: 'Consulta disponibilidad por fechas',
    },
    {
      id: 'pedido' as const,
      icono: UtensilsCrossed,
      titulo: 'Hacer un pedido',
      detalle: 'Mira la carta y pide',
    },
  ]

  return (
    <div className="animar-entrada mx-auto min-h-full max-w-md px-5 py-10">
      <h1 className="text-[28px] leading-tight font-extrabold tracking-tight">{business.name}</h1>
      <p className="mt-2 text-[15px] texto-tenue">
        {business.slogan || '¿Qué necesitas hoy?'}
      </p>

      <div className="mt-8 space-y-3">
        {opciones.map(({ id, icono: Icono, titulo, detalle }) => (
          <button
            key={id}
            onClick={() => onElegir(id)}
            className="superficie flex w-full items-center gap-4 rounded-2xl border borde-tema p-4 text-left transition active:scale-[0.99]"
          >
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-marca-suave">
              <Icono size={22} className="text-marca" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[16px] font-bold">{titulo}</span>
              <span className="block text-[13px] texto-tenue">{detalle}</span>
            </span>
            <ChevronRight size={20} className="shrink-0 texto-tenue" />
          </button>
        ))}
      </div>
    </div>
  )
}
