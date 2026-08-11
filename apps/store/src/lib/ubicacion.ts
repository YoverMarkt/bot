// ── EL PIN DEL CLIENTE ─────────────────────────────────────────────────────
//
// El GPS del navegador, envuelto para que la pantalla no tenga que saber de
// callbacks ni de códigos de error numéricos.
//
// Esto NO habla con Google: `navigator.geolocation` es del navegador, es gratis
// y no lleva clave. Lo que se paga es DIBUJAR un mapa dentro de la app, que
// llega después. Aquí solo se captura el punto.
//
// ⚠️ Es OPCIONAL a propósito. Quien niega el permiso —o abre el enlace en un
// navegador que no lo pasa— tiene que poder pedir igual: perder una venta por
// un dato de ayuda sería peor que repartir con la dirección escrita, que es
// como se ha repartido siempre.
//
// ⚠️ «Dónde estoy» no es «dónde me lo llevan». Por eso esto se dispara con un
// BOTÓN y nunca solo: quien pide desde la oficina para su casa mandaría al
// repartidor a la oficina sin enterarse.

export interface Ubicacion {
  latitude: number
  longitude: number
  /** Metros de error que reporta el aparato. Nulo = no lo dijo. */
  accuracy: number | null
}

export type FalloUbicacion = 'sin_soporte' | 'permiso' | 'no_disponible' | 'tardo'

export type ResultadoUbicacion =
  | { ok: true; ubicacion: Ubicacion }
  | { ok: false; motivo: FalloUbicacion; mensaje: string }

/**
 * Qué se le dice al cliente en cada fallo.
 *
 * El de `permiso` menciona abrir en el navegador porque el caso más común no es
 * que haya dicho que no: es que el enlace se abrió DENTRO de WhatsApp, y su
 * navegador incrustado no siempre reenvía el permiso de ubicación.
 */
export const MENSAJES: Record<FalloUbicacion, string> = {
  sin_soporte: 'Tu navegador no puede compartir la ubicación. Escribe la dirección y listo.',
  permiso: 'No pudimos leer tu ubicación. Si abriste el enlace desde WhatsApp, prueba abrirlo en tu navegador.',
  no_disponible: 'No se pudo obtener tu ubicación ahora mismo. Puedes escribir la dirección.',
  tardo: 'Tu ubicación está tardando demasiado. Escribe la dirección y sigue con tu pedido.',
}

/** Cuánto se espera antes de rendirse. Con GPS y bajo techo, 10 s se quedan cortos. */
const ESPERA_MS = 15000

const fallo = (motivo: FalloUbicacion): ResultadoUbicacion =>
  ({ ok: false, motivo, mensaje: MENSAJES[motivo] })

/** Traduce el código del navegador (1 permiso · 2 posición · 3 tiempo). */
export const motivoDelError = (codigo: number): FalloUbicacion => {
  if (codigo === 1) return 'permiso'
  if (codigo === 3) return 'tardo'
  return 'no_disponible'
}

/**
 * Redondea a siete decimales, que es lo que acepta la columna `numeric(10,7)`.
 *
 * Sin esto, la base rechazaría la fila entera por desbordamiento: el navegador
 * devuelve latitudes con quince decimales, y del octavo en adelante son
 * milímetros que ningún repartidor va a usar.
 */
export const recortar = (valor: number): number => Math.round(valor * 1e7) / 1e7

/**
 * La precisión, saneada. Se descarta si no es un número usable en vez de
 * rechazar el pin: el punto sirve aunque no sepamos cuánto se equivoca.
 */
export const recortarPrecision = (valor: unknown): number | null => {
  // ⚠️ El vacío se descarta ANTES de convertir: `Number(null)` es 0, y un cero
  // aquí no significa «no lo sé», significa «exacto al centímetro». Sería
  // exactamente el pin que miente que esta columna existe para delatar.
  if (valor === null || valor === undefined || valor === '') return null
  const numero = Number(valor)
  if (!Number.isFinite(numero) || numero < 0 || numero > 100000) return null
  return Math.round(numero * 10) / 10
}

/** El objeto del navegador, inyectable para poder probar esto sin un GPS. */
type Geo = Pick<Geolocation, 'getCurrentPosition'>

export const pedirUbicacion = (
  geo: Geo | undefined = typeof navigator === 'undefined' ? undefined : navigator.geolocation,
): Promise<ResultadoUbicacion> => new Promise((resolver) => {
  if (!geo || typeof geo.getCurrentPosition !== 'function') {
    resolver(fallo('sin_soporte'))
    return
  }

  geo.getCurrentPosition(
    (posicion) => {
      const { latitude, longitude, accuracy } = posicion.coords
      // Un navegador puede devolver la posición con coordenadas imposibles si
      // el aparato va mal. Se comprueba aquí y no solo en el servidor para que
      // el cliente vea «no se pudo» en vez de un error al guardar.
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || latitude < -90 || latitude > 90
        || longitude < -180 || longitude > 180) {
        resolver(fallo('no_disponible'))
        return
      }
      resolver({
        ok: true,
        ubicacion: {
          latitude: recortar(latitude),
          longitude: recortar(longitude),
          accuracy: recortarPrecision(accuracy),
        },
      })
    },
    (error) => resolver(fallo(motivoDelError(Number(error?.code)))),
    // Alta precisión y sin caché: una posición guardada de hace una hora puede
    // ser de otro barrio, y esto decide a dónde va un repartidor.
    { enableHighAccuracy: true, timeout: ESPERA_MS, maximumAge: 0 },
  )
})
