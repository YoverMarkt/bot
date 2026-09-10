// ── DE UN ENLACE DE GOOGLE MAPS A UN PAR DE COORDENADAS ────────────────────
//
// El dueño de un local no sabe cuáles son sus coordenadas, y no tiene por qué:
// lo que SÍ sabe hacer es abrir Google Maps en el móvil, buscar su negocio y
// tocar «Compartir». Esto convierte lo que pega en un punto.
//
// ⚠️ Se resuelve en el NAVEGADOR y no en el servidor, a propósito. Un enlace
// pegado es una URL arbitraria: hacer que el servidor la siga para leer las
// coordenadas sería pedirle que haga peticiones a donde diga un usuario —el
// agujero que se llama SSRF—. Aquí solo se lee el texto que ya está pegado.
//
// ⚠️ Los enlaces CORTOS (`maps.app.goo.gl/xxx`) no llevan coordenadas dentro:
// hay que seguir la redirección para verlas, y eso es justo lo que no se va a
// hacer. Se detectan para poder decirle al dueño qué hacer en vez de dejarle
// mirando un «no se pudo leer» — que es lo que convierte un error en abandono.

export interface Punto {
  latitude: number
  longitude: number
}

/**
 * Por qué no se pudo leer un punto.
 *
 * ⚠️ Va en su propio tipo y no inline en la unión: `LecturaDelPunto['motivo']`
 * no compila, porque la rama `ok: true` no tiene ese campo. Lo cazó el `tsc -b`
 * del CI, no el `check` local — que corre el lint de las apps, no su build.
 */
export type MotivoDelPunto = 'vacio' | 'enlace_corto' | 'sin_coordenadas' | 'fuera_de_rango'

export type LecturaDelPunto =
  | { ok: true; punto: Punto }
  | { ok: false; motivo: MotivoDelPunto }

/** Qué se le dice al dueño en cada caso. Cada mensaje tiene que decir QUÉ HACER. */
export const MENSAJE_DEL_PUNTO: Record<MotivoDelPunto, string> = {
  vacio: '',
  enlace_corto:
    'Ese enlace es de los cortos y no lleva el punto dentro. Ábrelo en el navegador '
    + 'y copia la dirección que quede arriba, o busca tu local en Google Maps desde '
    + 'la computadora y copia esa.',
  sin_coordenadas:
    'No encontré el punto en ese texto. Pega el enlace de Google Maps de tu local, '
    + 'o las coordenadas separadas por coma (ejemplo: -1.0661434, -80.467013).',
  fuera_de_rango:
    'Esas coordenadas no caen en el mapa. Revisa que no falte un signo menos.',
}

const enRango = (lat: number, lng: number): boolean => (
  Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  // El (0,0) es el golfo de Guinea: nunca es una tienda, siempre es un parseo
  // que devolvió ceros.
  && !(lat === 0 && lng === 0)
)

/**
 * Saca el punto de lo que sea que el dueño haya pegado.
 *
 * Acepta, en este orden:
 *   · coordenadas sueltas — «-1.0661434, -80.467013»
 *   · el enlace largo de Maps — «…/@-1.0661434,-80.467013,17z…»
 *   · el formato de sitio concreto — «…!3d-1.0661434!4d-80.467013»
 *   · un `?q=lat,lng` o `?ll=lat,lng`
 *
 * ⚠️ El `@` del enlace largo es el CENTRO DEL MAPA, no siempre el sitio. Por
 * eso `!3d!4d` —que sí es el sitio— se busca ANTES: cuando Maps trae los dos,
 * el bueno es el segundo. Con solo el `@` se usa ese, que para un local
 * buscado por su nombre cae encima igual.
 */
export function leerPunto(texto: string): LecturaDelPunto {
  const limpio = String(texto || '').trim()
  if (!limpio) return { ok: false, motivo: 'vacio' }

  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(limpio)) {
    return { ok: false, motivo: 'enlace_corto' }
  }

  const candidatos: [number, number][] = []
  // El sitio concreto, que es el que manda cuando existe.
  const sitio = limpio.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/)
  if (sitio) candidatos.push([Number(sitio[1]), Number(sitio[2])])
  // El centro del mapa.
  const centro = limpio.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/)
  if (centro) candidatos.push([Number(centro[1]), Number(centro[2])])
  // Un `q=` o `ll=` explícito.
  const consulta = limpio.match(/[?&](?:q|ll|daddr|destination)=(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/)
  if (consulta) candidatos.push([Number(consulta[1]), Number(consulta[2])])
  // Coordenadas pegadas a mano, que es lo que pasa cuando ya las tiene.
  if (!/https?:\/\//i.test(limpio)) {
    const sueltas = limpio.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/)
    if (sueltas) candidatos.push([Number(sueltas[1]), Number(sueltas[2])])
  }

  if (!candidatos.length) return { ok: false, motivo: 'sin_coordenadas' }
  const bueno = candidatos.find(([lat, lng]) => enRango(lat, lng))
  if (!bueno) return { ok: false, motivo: 'fuera_de_rango' }

  // Siete decimales: lo que guarda la columna (~1 cm).
  const redondear = (v: number): number => Math.round(v * 1e7) / 1e7
  return { ok: true, punto: { latitude: redondear(bueno[0]), longitude: redondear(bueno[1]) } }
}

/** El enlace para VER el punto guardado. Sin API key: es una URL normal. */
export const verEnElMapa = (punto: Punto): string =>
  `https://www.google.com/maps?q=${punto.latitude},${punto.longitude}`
