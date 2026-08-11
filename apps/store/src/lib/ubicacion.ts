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

export type FalloUbicacion =
  | 'sin_soporte' | 'incrustado' | 'bloqueada' | 'permiso' | 'no_disponible' | 'tardo'

export type ResultadoUbicacion =
  | { ok: true; ubicacion: Ubicacion }
  | { ok: false; motivo: FalloUbicacion; mensaje: string }

/**
 * Qué se le dice al cliente en cada fallo.
 *
 * ⚠️ Cada uno tiene que decir QUÉ HACER, y decir la verdad. La primera versión
 * mandaba a todos el mismo texto —«si abriste el enlace desde WhatsApp, prueba
 * en tu navegador»— y se lo enseñaba a quien YA estaba en Chrome con la
 * ubicación bloqueada. Un mensaje que culpa al sitio equivocado es peor que no
 * decir nada: el cliente hace lo que le pides, falla otra vez, y se rinde.
 */
export const MENSAJES: Record<FalloUbicacion, string> = {
  sin_soporte: 'Tu navegador no puede compartir la ubicación. Escribe la dirección y listo.',
  incrustado: 'Abriste el enlace dentro de WhatsApp y ahí no se puede compartir la ubicación. Ábrelo en tu navegador con el menú ⋮ y vuelve a intentarlo.',
  bloqueada: 'Tienes la ubicación bloqueada para esta página. Toca el candado 🔒 junto a la dirección, permite «Ubicación» y vuelve a intentarlo.',
  permiso: 'No nos diste permiso para leer tu ubicación. Puedes intentarlo otra vez o escribir la dirección.',
  no_disponible: 'No pudimos ubicarte. Revisa que la ubicación del teléfono esté encendida.',
  tardo: 'Tu ubicación está tardando demasiado. Escribe la dirección y sigue con tu pedido.',
}

/** Cuánto se espera antes de rendirse. Con GPS y bajo techo, 10 s se quedan cortos. */
const ESPERA_MS = 15000
/** El segundo intento, por antena y wifi: llega en segundos y no falla bajo techo. */
const ESPERA_RAPIDA_MS = 8000

/**
 * ¿Esto es el navegador incrustado de otra app?
 *
 * Android marca sus WebView con `; wv)` en el identificador, y WhatsApp además
 * se nombra. En iOS el de WhatsApp es Safari de verdad y la ubicación funciona,
 * así que ahí no hace falta avisar de nada.
 *
 * Solo decide QUÉ MENSAJE se enseña, nunca si se intenta: si algún día ese
 * navegador empieza a pasar el permiso, esto no lo impide.
 */
export const esNavegadorIncrustado = (agente: string): boolean =>
  /; wv\)|WhatsApp/i.test(agente)

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

/** Lo que hace falta del entorno, inyectable entero para poder probarlo. */
export interface EntornoUbicacion {
  geo?: Geo
  /** Para saber si el permiso está BLOQUEADO o solo no se ha pedido. */
  permisos?: { query(descriptor: { name: PermissionName }): Promise<{ state: string }> }
  agente?: string
}

const leerEntorno = (): EntornoUbicacion => (
  typeof navigator === 'undefined'
    ? {}
    : {
        geo: navigator.geolocation,
        permisos: navigator.permissions,
        agente: navigator.userAgent,
      }
)

/** Un intento contra el GPS, con las opciones que se le den. */
const intentar = (geo: Geo, opciones: PositionOptions): Promise<ResultadoUbicacion> =>
  new Promise((resolver) => {
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
      opciones,
    )
  })

/**
 * Pide la ubicación, con dos intentos y un diagnóstico honesto del fallo.
 *
 * **Dos intentos** porque es lo que hacen las apps grandes: el primero exige
 * GPS y sin caché —lo que de verdad sirve para llevarle comida a alguien—, pero
 * bajo techo o de noche el GPS puede no fijar en quince segundos. Si eso pasa,
 * el segundo intento acepta la posición por antena y wifi, que llega en
 * segundos y cae a unos cientos de metros. Peor pin es mejor que ningún pin, y
 * `accuracy` lo dice para que el repartidor sepa de cuál se fía.
 *
 * Solo se reintenta cuando el primero TARDÓ. Si el problema es el permiso, el
 * segundo intento fallaría igual y solo alargaría la espera.
 */
export const pedirUbicacion = async (
  entorno: EntornoUbicacion = leerEntorno(),
): Promise<ResultadoUbicacion> => {
  const { geo, agente = '' } = entorno
  if (!geo || typeof geo.getCurrentPosition !== 'function') return fallo('sin_soporte')

  // Alta precisión y sin caché: una posición guardada de hace una hora puede
  // ser de otro barrio, y esto decide a dónde va un repartidor.
  let resultado = await intentar(geo, {
    enableHighAccuracy: true, timeout: ESPERA_MS, maximumAge: 0,
  })

  if (!resultado.ok && resultado.motivo === 'tardo') {
    resultado = await intentar(geo, {
      enableHighAccuracy: false, timeout: ESPERA_RAPIDA_MS, maximumAge: 60_000,
    })
  }

  // ── Y si falló por permiso, AVERIGUAR POR QUÉ antes de hablar ────────────
  //
  // «Denegado» son tres situaciones distintas y cada una se arregla en un sitio
  // distinto: el permiso bloqueado para la página (candado del navegador), el
  // aviso que el cliente acaba de descartar (volver a intentarlo), y el
  // navegador incrustado de WhatsApp que ni siquiera pregunta (abrir fuera).
  // Mandarlos a todos al mismo sitio hace que dos de cada tres pierdan el tiempo.
  if (!resultado.ok && resultado.motivo === 'permiso') {
    if (esNavegadorIncrustado(agente)) return fallo('incrustado')
    const estado = await entorno.permisos
      ?.query({ name: 'geolocation' as PermissionName })
      .then(permiso => permiso.state)
      .catch(() => null)
    if (estado === 'denied') return fallo('bloqueada')
  }

  return resultado
}
