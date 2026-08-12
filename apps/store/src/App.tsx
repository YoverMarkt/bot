import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { ApiError, confirmarTelefono, getStore, isLinkProblem } from './lib/api'
import { isMobileDevice } from './lib/device'
import { aplicarColorDeMarca } from './lib/marca'
import { readSlug } from './lib/session'
import type { Business, StoreStatus } from './lib/types'
import Confirmar from './screens/Confirmar'
import Gate from './screens/Gate'
import DesktopGate from './screens/DesktopGate'
import FoodStore from './screens/FoodStore'
const StayStore = lazy(() => import('./screens/StayStore'))
import Picker from './screens/Picker'

// Armazón de la tienda.
//
// La decisión que se toma aquí es la importante: QUÉ flujo se pinta. No se
// mira el tipo de negocio, se miran sus capacidades. Un carrito con "+/−
// habitaciones" no es una estadía, y una estadía por fechas no sirve para
// vender pizzas. Un hostal con restaurante tiene las dos y elige el cliente.

type Estado =
  | { fase: 'cargando' }
  | { fase: 'no_disponible' }
  | { fase: 'escritorio'; business: Business | null }
  | { fase: 'bloqueada'; business: Business | null; motivo: string | null }
  // Falta confirmar el número de WhatsApp: no es un error, es la puerta.
  | { fase: 'confirmar'; business: Business | null }
  | { fase: 'lista'; business: Business; status: StoreStatus }

export default function App() {
  const slug = readSlug()
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' })
  const [seccion, setSeccion] = useState<'pedido' | 'estadia' | null>(null)

  const cargar = useCallback(async () => {
    if (!slug) return setEstado({ fase: 'no_disponible' })

    // Se comprueba el dispositivo ANTES de pedir nada con sesión, y no es un
    // detalle de orden: la portada es pública y no consume el enlace, así que
    // un clic desde WhatsApp Web deja el enlace intacto para cuando la persona
    // lo abra en su teléfono.
    const enMovil = isMobileDevice()

    try {
      const datos = await getStore(slug)
      // El color del negocio se aplica en cuanto se conoce, antes de pintar el
      // catálogo: así nadie ve el verde por defecto y luego un salto de color.
      aplicarColorDeMarca(datos.business?.brandColor)
      if (!enMovil) return setEstado({ fase: 'escritorio', business: datos.business })
      // La carta se ve sin enlace: un enlace de comida se reenvía, se pega en
      // una historia y se busca, y quien llegue tiene que poder mirar antes de
      // dar su número. Pedir sí lo exige, y el 401 de esa petición es lo que
      // lleva a `Gate` o a confirmar el teléfono — ver `alFallarEnlace`.
      setEstado({ fase: 'lista', business: datos.business, status: datos.status })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return setEstado({ fase: 'no_disponible' })
      }
      // Ni siquiera se pudo leer la portada; en un PC igual toca decir por qué.
      if (!enMovil) return setEstado({ fase: 'escritorio', business: null })
      setEstado({ fase: 'no_disponible' })
    }
  }, [slug])

  useEffect(() => { void cargar() }, [cargar])

  /**
   * Un 401 en cualquier pantalla significa lo mismo: el enlace no vale para
   * este teléfono. Se recupera la portada (que es pública) solo para poder
   * ofrecer el WhatsApp del negocio.
   */
  const alFallarEnlace = useCallback(async (error: unknown) => {
    if (!isLinkProblem(error)) return false
    const motivo = error instanceof ApiError ? error.reason : null
    let business: Business | null = null
    try {
      business = (await getStore(slug)).business
    } catch { business = null }
    // 'necesita_telefono' no es un portazo: es que aún no ha demostrado quién
    // es. Se le pide el número en vez de mandarlo a pedir otro enlace.
    if (motivo === 'necesita_telefono') {
      setEstado({ fase: 'confirmar', business })
      return true
    }
    setEstado({ fase: 'bloqueada', business, motivo })
    return true
  }, [slug])

  if (estado.fase === 'cargando') return null // el esqueleto del HTML sigue a la vista

  if (estado.fase === 'no_disponible') {
    return (
      <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12 text-center">
        <h1 className="text-[22px] font-extrabold">Esta tienda no está disponible</h1>
        <p className="mt-2.5 text-[15px] texto-tenue">
          Puede que el negocio la haya desactivado. Escríbele por WhatsApp y te atiende igual.
        </p>
      </div>
    )
  }

  if (estado.fase === 'escritorio') {
    return <DesktopGate business={estado.business} />
  }

  if (estado.fase === 'bloqueada') {
    return <Gate business={estado.business} motivo={estado.motivo} />
  }

  if (estado.fase === 'confirmar') {
    return (
      <Confirmar
        business={estado.business}
        onConfirmar={async (telefono) => {
          const fallo = await confirmarTelefono(slug, telefono)
          // Al entrar se recarga la tienda: la sesión ya está atada a este
          // teléfono y el catálogo puede pedirse con normalidad.
          if (!fallo) await cargar()
          return fallo
        }}
      />
    )
  }

  const { business, status } = estado
  const { orders, lodging } = business.capabilities

  // Las dos cosas: el cliente decide si viene a comer o a dormir.
  if (orders && lodging && !seccion) {
    return <Picker business={business} onElegir={setSeccion} />
  }

  const volver = orders && lodging ? () => setSeccion(null) : undefined

  if (seccion === 'estadia' || (lodging && !orders)) {
    return (
      <Suspense fallback={null}><StayStore
        slug={slug}
        business={business}
        status={status}
        onVolver={volver}
        onFalloEnlace={alFallarEnlace}
      /></Suspense>
    )
  }

  return (
    <FoodStore
      slug={slug}
      business={business}
      status={status}
      onVolver={volver}
      onFalloEnlace={alFallarEnlace}
    />
  )
}
