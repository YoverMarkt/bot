// ═══════════════════════════════════════════════════════════════════════════
// QUÉ PUEDE GUARDARSE EL NAVEGADOR, Y POR CUÁNTO TIEMPO
//
// ⚠️ Vive aparte de `index.ts` para poder probarse. Estaba dentro del
// compositor, donde la única forma de comprobarla era levantar el servidor
// entero — así que no se comprobaba, y así fue como pasó desapercibido durante
// meses que solo marcaba el HTML.
//
// El fallo, medido contra producción el 2026-09-06: todo lo que no era `.html`
// se quedaba con el valor por defecto de `express.static`,
// `Cache-Control: public, max-age=0`, que obliga al navegador a REVALIDAR cada
// archivo en cada visita. Los archivos de Vite llevan el hash del contenido en
// el nombre (`index-BkwLoUoU.js`): son inmutables por definición, porque si
// cambian, cambia el nombre. El cliente que abría la mini app por tercera vez
// pagaba la misma ronda de red que la primera —283 kB de JS, ~1 s— con datos
// móviles y desde el navegador incrustado de WhatsApp.
// ═══════════════════════════════════════════════════════════════════════════

import type { Response } from 'express'

/** Un año. Lo máximo que la especificación recomienda anunciar. */
const UN_ANIO = 31536000

/**
 * ¿Este archivo puede guardarse para siempre?
 *
 * Solo si su nombre cambia cuando cambia su contenido. Es el caso de todo lo
 * que Vite emite en `assets/` y de las fuentes, que se sustituyen con otro
 * nombre el día que cambian.
 */
export const esInmutable = (filePath: string): boolean => (
  /[/\\]assets[/\\]/.test(filePath) || /\.(woff2?|ttf|otf)$/i.test(filePath)
)

/**
 * La política de caché de un archivo estático.
 *
 * ⚠️ El `.html` NUNCA se guarda, y no es una precaución de más: es el archivo
 * que dice qué assets tocan. Un HTML cacheado seguiría pidiendo los del
 * despliegue anterior, así que la app se quedaría congelada en una versión
 * vieja hasta que alguien vaciara la caché — con los assets nuevos ya
 * publicados y nadie usándolos.
 */
export const cachearEstaticos = (response: Response, filePath: string): void => {
  if (filePath.endsWith('.html')) {
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    return
  }
  response.setHeader(
    'Cache-Control',
    esInmutable(filePath)
      ? `public, max-age=${UN_ANIO}, immutable`
      // Lo demás —un icono, un manifiesto— cambia sin cambiar de nombre: una
      // hora es suficiente para no pedirlo en cada visita y poco para que una
      // corrección tarde en verse.
      : 'public, max-age=3600',
  )
}
