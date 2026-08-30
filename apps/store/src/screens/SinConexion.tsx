import { RiWifiOffLine } from '@remixicon/react'
import { Boton, SelloDePuerta } from '../components/ui'

// Lo que se ve cuando la tienda no CARGÓ — que no es lo mismo que no existir.
//
// ⚠️ Hasta el 2026-08-30 los dos casos caían en la misma pantalla, y esa
// pantalla decía: «Esta tienda no está disponible. Puede que el negocio la haya
// desactivado». Con el teléfono sin datos, en un ascensor o con el servidor
// tardando, se le estaba echando la culpa al local por un problema del
// teléfono — y el cliente se iba creyendo que había cerrado.
//
// Peor: no ofrecía lo ÚNICO que resuelve un fallo de red, que es volver a
// intentarlo. Una pantalla sin salida sobre un problema que se arregla solo en
// diez segundos.
//
// El 404 —el negocio de verdad no existe o está apagado— sigue teniendo su
// propia pantalla, porque ahí reintentar no arregla nada.

export default function SinConexion({ onReintentar }: { onReintentar: () => void }) {
  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <SelloDePuerta><RiWifiOffLine size={26} /></SelloDePuerta>

      <h1 className="titulo-xl">No pudimos cargar la tienda</h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">
        Revisa tu conexión y vuelve a intentarlo. Tu pedido y tu enlace siguen
        guardados.
      </p>

      {/* La salida, que es lo que faltaba. Reintentar vuelve a preguntarle al
          servidor: si la tienda está bien, la persona entra sin haber tenido
          que cerrar la app ni pedir otro enlace. */}
      <div className="mt-8">
        <Boton onClick={onReintentar}>Volver a intentar</Boton>
      </div>
    </div>
  )
}
