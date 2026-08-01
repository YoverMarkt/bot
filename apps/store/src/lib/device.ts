// ¿Esto es un teléfono o una computadora?
//
// La tienda es para el móvil: el enlace llega por WhatsApp y se pide con el
// pulgar. Abrirla en un PC casi siempre significa una de dos cosas — o alguien
// hizo clic desde WhatsApp Web, o alguien vino a curiosear con la consola.
//
// ⚠️ Esto es FRICCIÓN, no seguridad, y conviene no confundirlo. Quien sabe
// abrir las herramientas de desarrollador sabe también cambiar el modo móvil en
// dos clics. La seguridad de verdad está en otro sitio y no depende de esto: el
// token va atado al dispositivo, los precios los calcula el servidor y el
// frontend no guarda ningún secreto. Lo que esto quita es al curioso, y por eso
// vale lo que cuesta.
//
// El costo de equivocarse NO es simétrico: bloquear a un cliente real que sí
// venía en su teléfono pierde una venta en silencio. Por eso la detección mira
// varias señales y, ante la duda, deja pasar.

export interface DeviceSignals {
  userAgent: string
  /** Cuántos dedos reconoce la pantalla. Un PC normal: 0. */
  maxTouchPoints: number
  /** true si el puntero PRINCIPAL es un dedo, no un ratón. */
  coarsePointer: boolean
}

/** Teléfonos y tablets se declaran en su identificador de navegador. */
const UA_MOVIL = /Android|iPhone|iPad|iPod|Windows Phone|Mobile|Silk|Kindle|Opera Mini/i

/**
 * Un iPad en «modo escritorio» MIENTE: dice ser un Mac. Por eso no basta el
 * identificador y se miran también las señales físicas de la pantalla.
 *
 * Un portátil con pantalla táctil sí reconoce dedos, pero su puntero principal
 * sigue siendo el ratón (`pointer: fine`), así que no se cuela por aquí.
 */
export function looksLikeMobile(signals: DeviceSignals): boolean {
  if (UA_MOVIL.test(signals.userAgent)) return true
  return signals.coarsePointer && signals.maxTouchPoints > 0
}

/** Lee las señales del navegador de verdad. */
export function isMobileDevice(): boolean {
  try {
    return looksLikeMobile({
      userAgent: navigator.userAgent || '',
      maxTouchPoints: navigator.maxTouchPoints || 0,
      coarsePointer: window.matchMedia?.('(pointer: coarse)')?.matches ?? false,
    })
  } catch {
    // Navegador que no deja preguntar: se asume móvil. Ante la duda, vender.
    return true
  }
}
