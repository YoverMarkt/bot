// ── EL PUNTO DE UN LOCAL EN EL MAPA ────────────────────────────────────────
//
// Validar un par de coordenadas parece trivial hasta que se hace en tres
// sitios distintos: el panel del dueño, el alta del superadmin y —mañana— la
// app del repartidor. Tres copias acaban aceptando cosas distintas, y la que
// más suelto valide es la que manda.
//
// ⚠️ LAS DOS O NINGUNA, y no es una preferencia de estilo: media coordenada
// no es media ubicación. Una latitud sin longitud apunta al meridiano de
// Greenwich; una longitud sin latitud, al ecuador. En los dos casos el
// repartidor sale hacia el Atlántico. La base lo hace cumplir con
// `businesses_ubicacion_check`; esto lo dice ANTES, con un 400 que explica
// qué pasa en vez de un 500 de PostgreSQL.
//
// ⚠️ Vaciar la ubicación es legítimo: un local que se muda deja de tener punto
// hasta que ponga el nuevo, y obligarle a dejar uno viejo sería peor. Por eso
// `null` en ambas es un resultado válido, no un error.

export interface PuntoDelLocal {
  latitude: number | null
  longitude: number | null
}

export type ResultadoUbicacion =
  | { ok: true; punto: PuntoDelLocal }
  | { ok: false; error: string }

/** Vacío de verdad: ni el `null` de JSON ni la cadena que deja un input. */
const vacio = (valor: unknown): boolean => (
  valor == null || (typeof valor === 'string' && valor.trim() === '')
)

/**
 * Normaliza el par que llega en un body y dice si sirve.
 *
 * Devuelve el punto ya redondeado a SIETE decimales, que es lo que guarda la
 * columna (`numeric(10,7)`, ~1 cm). Redondear aquí y no dejárselo a PostgreSQL
 * evita que lo que se lee de vuelta no coincida con lo que se mandó.
 */
export function leerUbicacion(body: Record<string, unknown>): ResultadoUbicacion {
  const crudoLat = body.latitude
  const crudoLng = body.longitude
  const sinLat = vacio(crudoLat)
  const sinLng = vacio(crudoLng)

  // Ninguna de las dos: se borra el punto. Es una decisión válida.
  if (sinLat && sinLng) return { ok: true, punto: { latitude: null, longitude: null } }

  if (sinLat !== sinLng) {
    return {
      ok: false,
      error: 'La ubicación necesita latitud Y longitud. Con solo una de las dos, '
        + 'el punto cae en el mar.',
    }
  }

  const lat = Number(crudoLat)
  const lng = Number(crudoLng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'La ubicación tiene que ser un par de números.' }
  }
  if (lat < -90 || lat > 90) {
    return { ok: false, error: 'La latitud tiene que estar entre -90 y 90.' }
  }
  if (lng < -180 || lng > 180) {
    return { ok: false, error: 'La longitud tiene que estar entre -180 y 180.' }
  }
  // ⚠️ El (0, 0) se rechaza a propósito. Es un punto REAL —el golfo de
  // Guinea— pero en la práctica nunca es una tienda: es lo que sale cuando un
  // formulario manda ceros por defecto o un parseo falla y devuelve 0. Dejarlo
  // pasar mandaría al repartidor a 5.000 km de la costa de Ghana, y nadie
  // sabría por qué.
  if (lat === 0 && lng === 0) {
    return {
      ok: false,
      error: 'Esas coordenadas apuntan al océano Atlántico. Revisa el punto del local.',
    }
  }

  const redondear = (valor: number): number => Math.round(valor * 1e7) / 1e7
  return { ok: true, punto: { latitude: redondear(lat), longitude: redondear(lng) } }
}

/** ¿Este negocio tiene punto? Las dos, o no cuenta. */
export const tieneUbicacion = (negocio: {
  latitude?: unknown
  longitude?: unknown
} | null | undefined): boolean => (
  negocio != null
  && negocio.latitude != null && Number.isFinite(Number(negocio.latitude))
  && negocio.longitude != null && Number.isFinite(Number(negocio.longitude))
)

/**
 * El enlace para llegar, que es lo único que el cliente necesita de verdad.
 *
 * ⚠️ NO lleva API key ni cuesta un centavo: es una URL normal de Google Maps.
 * La abre la app nativa del teléfono —Maps, o Waze si es la predeterminada— y
 * funciona igual en Android y en iPhone. Lo que se paga es DIBUJAR un mapa
 * dentro de nuestra app; llegar a un punto, no.
 */
export const comoLlegar = (negocio: {
  latitude?: unknown
  longitude?: unknown
}): string | null => (
  tieneUbicacion(negocio)
    ? `https://www.google.com/maps/dir/?api=1&destination=${negocio.latitude},${negocio.longitude}`
    : null
)

/**
 * La RUTA de un reparto: del local a la puerta del cliente.
 *
 * Es lo que necesita quien lleva el pedido, y hasta ahora no existía en
 * ninguna pantalla: el panel enseñaba el pin del cliente, pero el repartidor
 * sale DEL LOCAL — el trayecto completo es el dato, no el destino suelto.
 *
 * ⚠️ Sin API key ni coste, como el resto: es una URL de Google Maps que abre
 * la app nativa con el trayecto ya trazado. Lo que se paga es dibujar un mapa
 * dentro de nuestra app.
 *
 * ⚠️ Devuelve `null` si falta cualquiera de los dos extremos. Una ruta con un
 * solo punto no es media ruta: es un destino sin origen, que es justo lo que
 * ya se tenía.
 */
export const rutaDeReparto = (
  origen: { latitude?: unknown; longitude?: unknown },
  destino: { latitude?: unknown; longitude?: unknown },
): string | null => (
  tieneUbicacion(origen) && tieneUbicacion(destino)
    ? 'https://www.google.com/maps/dir/?api=1'
      + `&origin=${origen.latitude},${origen.longitude}`
      + `&destination=${destino.latitude},${destino.longitude}`
    : null
)
