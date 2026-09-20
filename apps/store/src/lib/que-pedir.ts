import type { Fulfillment } from './types'

// ── ¿QUÉ SE LE PIDE AL CLIENTE CUANDO EL CARRITO DEJA DE ESTAR VACÍO? ──────
//
// Son dos peticiones distintas y cada una tiene su momento: el número de
// WhatsApp (sin él no hay pedido posible) y la dirección (sin ella no hay a
// dónde llevarlo). Vive aquí, fuera de la pantalla, porque la mezcla de las
// dos ya se rompió una vez y en un `useEffect` no se puede comprobar.
//
// ⚠️ El fallo que obliga a tener esto escrito y probado (2026-09-20): había
// UNA sola marca de «ya se lo pedimos» para las dos cosas. Y `necesita_telefono`
// no es un caso raro — es «la primera apertura de TODO enlace nuevo». Así que
// a cada cliente nuevo le pasaba:
//
//   1. agrega algo → no hay sesión → se le pide el número, y la marca se gasta;
//   2. confirma su número y sigue, ya identificado y sin direcciones;
//   3. la marca ya está puesta → **la dirección no se le pide nunca**, y lo
//      descubre al ir a pagar.
//
// Se notaba con los platos que se ARMAN y no con los sueltos, y esa diferencia
// despista: lo que cambia no es el producto, es el TIEMPO. Armando una pizza
// da tiempo a que `/me` conteste 401 antes de agregar, así que al agregar ya
// se entra por la rama de la sesión. Con un producto suelto se agrega antes de
// que conteste, y la marca se gastaba más tarde.

/** Qué toca enseñar ahora mismo. `nada` incluye «ya se pidió en esta visita». */
export type Peticion = 'nada' | 'sesion' | 'direccion'

export function quePedir(estado: {
  /** ¿Hay algo en el carrito? Antes de eso no se pide nada: sería un peaje. */
  hayLineas: boolean
  /** El fallo de `/me` cuando es un problema de enlace (401). */
  sinSesion: boolean
  yaAvisamosDeLaSesion: boolean
  yaPedimosDireccion: boolean
  entrega: Fulfillment
  /** `null` = todavía no contestó. No es lo mismo que «no tiene sesión». */
  tieneDirecciones: boolean | null
}): Peticion {
  if (!estado.hayLineas) return 'nada'

  // ⚠️ Va PRIMERO: sin sesión no hay dirección que guardar, y pedirla sería un
  // formulario que el servidor va a rechazar.
  if (estado.sinSesion) {
    return estado.yaAvisamosDeLaSesion ? 'nada' : 'sesion'
  }

  // ⚠️ Y la marca de la dirección se mira DESPUÉS de la sesión, nunca antes:
  // al revés, avisar de la sesión gastaría el turno de pedir la dirección.
  if (estado.yaPedimosDireccion) return 'nada'

  // Quien retira en el local no tiene a dónde recibir nada.
  if (estado.entrega !== 'delivery') return 'nada'

  // `null` = `/me` no ha contestado todavía. No se pide nada aún, y tampoco se
  // gasta la marca: en cuanto conteste, esto se vuelve a preguntar.
  if (estado.tieneDirecciones === null) return 'nada'

  return estado.tieneDirecciones ? 'nada' : 'direccion'
}
