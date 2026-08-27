// ── LA FOTO QUE SE DESCARGA DE VERDAD ──────────────────────────────────────
//
// El dueño sube la foto desde su teléfono, y eso son entre 2 y 5 MB. Se
// servía TAL CUAL: una sola foto pesaba más de treinta veces la app entera, y
// una carta de diecisiete productos son decenas de megas por cliente. Todo el
// cuidado que se pone en que el código quepa en 82 kB se pierde en la primera
// imagen que alguien suba.
//
// Cloudinary lo resuelve en la URL, sin procesar nada por nuestra parte y sin
// costo adicional: se inserta un tramo de transformaciones después de
// `/upload/` y su CDN devuelve —y cachea— la versión pedida.
//
//   f_auto  → WebP o AVIF si el navegador los soporta, JPEG si no. Es el que
//             más ahorra: AVIF baja alrededor del 50% frente a un JPEG.
//   q_auto  → calidad decidida por contenido. Una foto de comida aguanta
//             mucha más compresión que un texto y aquí solo hay comida.
//   c_limit → ⚠️ IMPRESCINDIBLE junto a `w_`. Sin él, `w_1200` AMPLÍA una
//             imagen más pequeña, y ampliar solo añade peso: medido contra la
//             portada real del negocio, la dejó en 61 kB cuando el original
//             pesaba 43. Con `c_limit` nunca crece.
//   w_<n>   → nunca más ancho de lo que cabe en la pantalla. Servir 4000 px
//             para pintarlos en 400 es el desperdicio más grande de todos.
//
// ⚠️ `dpr_auto` se probó y se DESCARTÓ: sin las client hints que necesita pide
// más de lo debido, y fue la otra mitad de aquella regresión.
//
// Medido contra las imágenes reales del negocio: el logo, un JPEG subido desde
// un teléfono, pasa de 23.838 a 6.339 bytes (−73%). La portada, que ya venía
// en AVIF, apenas baja un 2% — y ese es justo el punto: el ahorro grande está
// en lo que sube un dueño desde su móvil, que es lo que va a subir siempre.
//
// ⚠️ Solo se toca lo que ES de Cloudinary. Una URL de otro sitio se devuelve
// intacta: meterle parámetros a un dominio ajeno rompería la imagen, y el
// negocio puede pegar la suya de donde quiera.

/** Anchos reales de uso, para no inventar tamaños que nadie pide. */
export type AnchoDeFoto = 'miniatura' | 'tarjeta' | 'ficha' | 'portada'

const ANCHOS: Record<AnchoDeFoto, number> = {
  // La foto pequeña de una línea del carrito o de un adicional.
  miniatura: 160,
  // Las tarjetas del catálogo, dos por fila en un teléfono.
  tarjeta: 400,
  // La cabecera de la ficha del producto, a lo ancho de la pantalla.
  ficha: 800,
  // La portada del local, que es la única a sangre completa.
  portada: 1200,
}

/**
 * Recorte previo, ENCADENADO, y solo para la portada.
 *
 * El héroe de la tienda pinta la portada en un marco 16:9 con `object-cover`,
 * así que el navegador se descargaba píxeles que el CSS iba a tirar — y los
 * tiraba a ciegas, por el centro. La portada real de Monster Pizza es un
 * banner 2,18:1: el recorte del navegador se comía el 20% del ancho y partía
 * «24/7 FREE HOME DELIVERY» por la mitad.
 *
 * `c_fill,g_auto` recorta al 16:9 eligiendo la parte con contenido, y viaja
 * ya recortada: menos bytes y sin recorte doble. Medido contra la portada
 * real: 55.693 → 51.847 bytes, y el resultado conserva las pizzas y el
 * titular enteros.
 *
 * ⚠️ Va ENCADENADO (`…/`) y ANTES del `c_limit,w_1200`, y ese orden es lo
 * único que hace que funcione:
 *   · `c_fill,…,w_1200` en un solo tramo **amplía** una portada de 740 px a
 *     1200 y la deja en 99 kB — la misma regresión que documenta `c_limit`
 *     más abajo, por la puerta de al lado. Medido.
 *   · `c_lfill` (fill que no amplía) **no recorta nada** cuando el ancho
 *     pedido supera al original: devuelve la imagen tal cual, 740×339.
 * Recortando primero a resolución nativa y limitando después, el `c_limit`
 * sigue impidiendo cualquier ampliación.
 */
const RECORTE: Partial<Record<AnchoDeFoto, string>> = {
  portada: 'c_fill,g_auto,ar_16:9/',
}

/** El punto donde Cloudinary acepta transformaciones dentro de su URL. */
const MARCA = '/image/upload/'

/**
 * Devuelve la misma foto, pero del tamaño y formato que hace falta.
 *
 * Si la URL ya trae transformaciones se deja como está: el dueño —o una
 * versión futura de esto— pudo pedir algo a propósito, y encadenar dos tramos
 * daría un resultado que nadie escribió.
 */
export const foto = (url: string | null | undefined, ancho: AnchoDeFoto): string | null => {
  const limpia = String(url || '').trim()
  if (!limpia) return null
  if (!limpia.includes('res.cloudinary.com') || !limpia.includes(MARCA)) return limpia

  const [antes, despues] = limpia.split(MARCA)
  // Un tramo de transformaciones ya puesto empieza por una clave conocida
  // seguida de `_`: `f_auto,q_auto/v123/...` frente a `v123/...`.
  if (/^[a-z]{1,3}_/.test(despues)) return limpia

  return `${antes}${MARCA}${RECORTE[ancho] || ''}f_auto,q_auto,c_limit,w_${ANCHOS[ancho]}/${despues}`
}
