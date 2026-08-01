import { useCallback, useEffect, useState } from 'react'
import { ApiError, getStore, isLinkProblem } from './lib/api'
import { readSlug, readToken } from './lib/session'
import type { Business, StoreStatus } from './lib/types'
import Gate from './screens/Gate'
import FoodStore from './screens/FoodStore'
import StayStore from './screens/StayStore'
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
  | { fase: 'bloqueada'; business: Business | null; motivo: string | null }
  | { fase: 'lista'; business: Business; status: StoreStatus }

export default function App() {
  const slug = readSlug()
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' })
  const [seccion, setSeccion] = useState<'pedido' | 'estadia' | null>(null)

  const cargar = useCallback(async () => {
    if (!slug) return setEstado({ fase: 'no_disponible' })
    try {
      const datos = await getStore(slug)
      // Sin enlace no hay tienda: se explica en vez de mostrar una pantalla vacía.
      if (!readToken()) {
        return setEstado({ fase: 'bloqueada', business: datos.business, motivo: 'no_existe' })
      }
      setEstado({ fase: 'lista', business: datos.business, status: datos.status })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return setEstado({ fase: 'no_disponible' })
      }
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

  if (estado.fase === 'bloqueada') {
    return <Gate business={estado.business} motivo={estado.motivo} />
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
      <StayStore
        slug={slug}
        business={business}
        status={status}
        onVolver={volver}
        onFalloEnlace={alFallarEnlace}
      />
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
