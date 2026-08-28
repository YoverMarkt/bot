import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { RiCloseLine } from '@remixicon/react'
import { ApiError, confirmarTelefono, getStore, isLinkProblem } from './lib/api'
import { isMobileDevice } from './lib/device'
import { aplicarColorDeMarca } from './lib/marca'
import { readSlug } from './lib/session'
import type { Business, StoreStatus } from './lib/types'
import FoodStore from './screens/FoodStore'

// ── LAS TRES PUERTAS VIAJAN APARTE ─────────────────────────────────────────
//
// Ninguna de las tres se ve en una visita normal, y las tres se descargaban en
// la primera carga —la que se paga en clientes que cierran antes de que la
// tienda abra—:
//
//   · `DesktopGate` solo sale en una COMPUTADORA, y esta app es para el
//     teléfono: en el móvil es peso muerto al 100 %.
//   · `Gate` solo sale con un enlace que no vale.
//   · `Confirmar` solo cuando falta demostrar el número.
//
// ⚠️ Se difieren ESTAS y no la pantalla de pedido recibido, que era la otra
// candidata por tamaño. Aquella se pinta en el instante siguiente a confirmar
// un pedido: si el trozo no llegara, el cliente que acaba de comprar se
// quedaría sin su número de pedido y sin los datos para transferir. Aquí lo
// peor que pasa es que una pantalla que ya dice «esto no se puede usar» tarde
// un instante más en decirlo.
//
// Cada una en su propio trozo, no en uno común: quien se topa con una puerta
// no tiene por qué descargarse las otras dos.
const Confirmar = lazy(() => import('./screens/Confirmar'))
const Gate = lazy(() => import('./screens/Gate'))
const DesktopGate = lazy(() => import('./screens/DesktopGate'))

// Armazón de la tienda.
//
// La decisión que se toma aquí es la importante: QUÉ flujo se pinta. No se
// mira el tipo de negocio, se miran sus capacidades.

type Estado =
  | { fase: 'cargando' }
  | { fase: 'no_disponible' }
  | { fase: 'escritorio'; business: Business | null }
  | { fase: 'bloqueada'; business: Business | null; motivo: string | null }
  | {
    fase: 'lista'
    business: Business
    status: StoreStatus
    /**
     * El enlace dejó de valer con la tienda ya abierta. Se pinta ENCIMA para
     * no llevarse el carrito; sin esto la fase pasaba a 'bloqueada' y
     * `FoodStore` se desmontaba entero.
     */
    bloqueo?: { business: Business | null; motivo: string | null }
  }

export default function App() {
  const slug = readSlug()
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' })
  /**
   * Falta confirmar el número de WhatsApp. No es un error: es la puerta.
   *
   * ⚠️ Vive APARTE de la fase, y eso es el arreglo. Era una fase más, así que
   * pedir el número desmontaba la tienda entera y con ella el carrito: el
   * cliente llenaba su pedido, tocaba confirmar, escribía su número… y volvía
   * a una tienda vacía. Ahora la confirmación se pinta ENCIMA y al cerrarse
   * todo sigue donde estaba.
   */
  const [confirmando, setConfirmando] = useState<{ business: Business | null } | null>(null)

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
      setConfirmando({ business })
      return true
    }
    // ⚠️ ENCIMA de la tienda, no en lugar de ella (2026-08-27).
    //
    // `fase: 'bloqueada'` desmonta `FoodStore`, y con él se va el CARRITO. El
    // momento en que esto salta es el peor posible: la tienda es pública, así
    // que quien llega sin enlace mira la carta, elige, escribe su dirección…
    // y el 401 aparece justo ahí. Perdía todo lo que llevaba y aterrizaba en
    // una pantalla sin vuelta.
    //
    // Es exactamente el fallo que ya se corrigió con la confirmación del
    // teléfono —«va ENCIMA de la tienda, no en lugar de ella»—, y volvía a
    // estar aquí por el otro camino.
    //
    // ⚠️ Se pinta encima SOLO si la tienda ya está montada. Si el 401 llega
    // durante la carga inicial no hay nada que conservar, y sustituir es lo
    // correcto: una tienda a medias detrás de un aviso sería peor.
    setEstado(actual => (
      actual.fase === 'lista'
        ? { ...actual, bloqueo: { business, motivo } }
        : { fase: 'bloqueada', business, motivo }
    ))
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

  // Sin `fallback`: lo correcto mientras baja el trozo es que no se vea nada.
  // Un esqueleto que aparece y desaparece en un cuarto de segundo molesta más
  // que el propio cuarto de segundo — misma decisión que en `DireccionRapida`.
  if (estado.fase === 'escritorio') {
    return (
      <Suspense fallback={null}>
        <DesktopGate business={estado.business} />
      </Suspense>
    )
  }

  if (estado.fase === 'bloqueada') {
    return (
      <Suspense fallback={null}>
        <Gate business={estado.business} motivo={estado.motivo} />
      </Suspense>
    )
  }

  const { business, status } = estado

  /**
   * El enlace dejó de valer con la tienda ya abierta.
   *
   * ⚠️ Lleva CERRAR, y no es un adorno: sin salida, esto sería la pantalla
   * 'bloqueada' de siempre con otro nombre — el cliente se quedaría mirando un
   * aviso con su carrito intacto detrás y sin forma de volver a él. Cerrando
   * puede seguir viendo la carta, que es pública, y pedir su enlace cuando
   * quiera. Lo que no podrá es cerrar el pedido, y eso se lo dirá el servidor
   * otra vez.
   */
  const puertaDelEnlace = estado.bloqueo && (
    <div className="fixed inset-0 z-[60] overflow-y-auto superficie">
      <button
        onClick={() => setEstado(actual => (
          actual.fase === 'lista' ? { ...actual, bloqueo: undefined } : actual
        ))}
        // Etiqueta PROPIA, no un «Cerrar» más: la hoja del carrito que queda
        // debajo tiene la suya, y dos controles con el mismo nombre accesible
        // en la misma pantalla no se distinguen — ni con lector, ni al
        // probarlo. Además dice a dónde vuelve, que es lo que tranquiliza a
        // quien acaba de ver un aviso con su carrito detrás.
        aria-label="Cerrar y volver a la carta"
        className="absolute top-[calc(env(safe-area-inset-top)+1rem)] right-4 z-10 flex size-10 items-center justify-center rounded-full bg-black/5 transition active:scale-90"
      >
        <RiCloseLine size={20} />
      </button>
      <Suspense fallback={null}>
        <Gate business={estado.bloqueo.business || business} motivo={estado.bloqueo.motivo} />
      </Suspense>
    </div>
  )

  // ⚠️ La confirmación va ENCIMA, no en lugar de. Sustituyendo la tienda se
  // perdía el carrito entero: el cliente lo llenaba, tocaba confirmar,
  // escribía su número y volvía a una tienda vacía. Lo mismo valía para el
  // checkout a medio llenar.
  const puertaDelTelefono = confirmando && (
    <div className="fixed inset-0 z-[60] overflow-y-auto superficie">
      <Suspense fallback={null}>
        <Confirmar
          business={confirmando.business}
          onConfirmar={async (telefono) => {
            const fallo = await confirmarTelefono(slug, telefono)
            // El catálogo NO se recarga: la sesión ya está atada a este
            // teléfono y la tienda sigue montada detrás, con su carrito
            // intacto. Volver a pedirlo todo era justo lo que lo vaciaba.
            if (!fallo) setConfirmando(null)
            return fallo
          }}
        />
      </Suspense>
    </div>
  )


  return (
    <>
      <FoodStore
        slug={slug}
        business={business}
        status={status}
        onFalloEnlace={alFallarEnlace}
      />
      {puertaDelTelefono}
      {puertaDelEnlace}
    </>
  )
}
