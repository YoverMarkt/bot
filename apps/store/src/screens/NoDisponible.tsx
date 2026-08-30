import { RiStore2Line } from '@remixicon/react'
import { SelloDePuerta } from '../components/ui'

// La tienda no existe, o el negocio la apagó.
//
// ⚠️ Vivía escrita a mano dentro de `App.tsx`, en el paquete PRINCIPAL — el que
// se descarga con datos móviles antes de ver un solo producto—, para una
// pantalla que en una visita normal no se ve nunca. Las otras cuatro puertas ya
// viajaban aparte por esa misma razón; esta se quedó atrás.
//
// ⚠️ Distinta de `SinConexion`: aquí reintentar NO arregla nada, así que no se
// ofrece. Lo único que resuelve es escribirle al negocio.

export default function NoDisponible() {
  return (
    // Se pinta como las otras puertas —sello, titular fuerte y explicación en
    // cuerpo de texto— porque para el cliente es la misma clase de noticia: no
    // puede pasar, y quiere saber por qué.
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <SelloDePuerta><RiStore2Line size={26} /></SelloDePuerta>
      <h1 className="titulo-xl">Esta tienda no está disponible</h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">
        Puede que el negocio la haya desactivado. Escríbele por WhatsApp y te atiende igual.
      </p>
    </div>
  )
}
