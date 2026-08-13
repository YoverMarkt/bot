// ── LA SALIDA A WHATSAPP ───────────────────────────────────────────────────
//
// Desde el 2026-08-12 esto dejó de ser un extra y pasó a ser EL camino: el
// comprobante ya no se sube en la app, se manda por el chat, y el seguimiento
// del pedido son los avisos que llegan por ahí. Un enlace mal armado ya no
// deja al cliente sin un atajo cómodo — lo deja sin forma de pagar.
//
// Por eso vive en un solo sitio y con pruebas, en vez de repetido a mano en
// cada pantalla que lo necesita.

/**
 * El enlace al WhatsApp del negocio, o `null` si no tiene número cargado.
 *
 * ⚠️ Solo dígitos. `wa.me` no admite el «+», ni espacios, ni guiones, y el
 * teléfono se guarda tal como lo escribió su dueño: «+593 99 171 6574».
 */
export const enlaceWhatsApp = (telefono?: string | null, texto?: string | null): string | null => {
  const digitos = String(telefono || '').replace(/\D/g, '')
  if (!digitos) return null
  const mensaje = String(texto || '').trim()
  return mensaje
    ? `https://wa.me/${digitos}?text=${encodeURIComponent(mensaje)}`
    : `https://wa.me/${digitos}`
}

/**
 * Lo que el cliente le escribe al negocio cuando le manda su comprobante.
 *
 * ⚠️ Sin número de pedido NO se escribe el «#». La versión anterior lo pegaba
 * siempre y trataba de limpiarlo después con `.replace(' #  ', ' ')`, que busca
 * dos espacios seguidos que nunca están ahí: el mensaje salía «…de mi pedido
 * # 🙂», con una almohadilla suelta que no identifica nada. Un pedido sin
 * número es raro pero existe —el trigger lo asigna al crear, y un pedido del
 * bot puede llegar aquí sin él—, y el mensaje tiene que leerse bien igual.
 */
export const textoComprobante = (orderNumber?: number | string | null): string => {
  const numero = orderNumber === null || orderNumber === undefined || orderNumber === ''
    ? ''
    : ` #${orderNumber}`
  return `Hola, te envío el comprobante de mi pedido${numero} 🙂`
}
