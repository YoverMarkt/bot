/**
 * EL CHECKOUT DENTRO DEL CHAT
 *
 * Lo que va después de «Finalizar pedido» cuando el local se atiende por
 * WhatsApp: ubicación → método de pago → (datos bancarios) → confirmación.
 *
 * Hasta ahora el menú del chat creaba el pedido y respondía «nuestro equipo te
 * contactará para coordinar la entrega y el pago»: el cliente quedaba a la
 * espera de una llamada y el dueño con un pedido sin dirección ni forma de
 * cobro. Estas son las pantallas 11 a 17 del flujo, las que la mini app ya
 * tenía y el chat no.
 *
 * ⚠️ Funciones PURAS, como `marketplace-menu.ts`: reciben datos ya
 * consultados y devuelven texto y opciones. Así se prueban enteras sin
 * levantar nada, que es lo que permite cubrir casos que en producción
 * costarían un mensaje cada uno.
 *
 * ⚠️ Ningún importe se calcula aquí. El total sale de
 * `create_storefront_order` y este módulo solo lo pinta (regla #8).
 */

export interface MetodoDePago {
  code: string
  label: string
  help_text: string | null
  is_prepaid: boolean
  requires_proof: boolean
}

export interface CuentaBancaria {
  bank_name: string
  account_type: string
  account_number: string
  holder_name?: string | null
  holder_id?: string | null
  instructions?: string | null
}

export interface RespuestaDeCheckout {
  reply: string
  options: string[]
}

const money = (valor: unknown): string => `$${(Number(valor) || 0).toFixed(2)}`

export const COMPARTIR_UBICACION = '📍 Compartir ubicación'

/**
 * Se pide la ubicación ANTES que el pago porque el envío puede cambiar el
 * total: cobrar primero y ajustar después sería pedirle al cliente que pague
 * dos veces.
 */
export function pedirUbicacion(): RespuestaDeCheckout {
  return {
    reply: '📍 Para llevarte el pedido necesito tu ubicación.\n\n'
      + 'Tócala en el clip 📎 → *Ubicación* → *Enviar tu ubicación actual*.\n\n'
      + 'También puedes escribir tu dirección.',
    options: [],
  }
}

/** El texto de la dirección cuando el cliente comparte su punto del mapa. */
export function direccionDesdeUbicacion(location: {
  latitude: number
  longitude: number
  address?: string
  name?: string
}): string {
  // WhatsApp adjunta `address` cuando el cliente elige un sitio del mapa; la
  // mayoría manda solo el punto azul, y ahí las coordenadas SON la dirección.
  // Se guardan legibles para que el repartidor las pueda leer y copiar.
  const escrita = [location.name, location.address]
    .map(parte => String(parte || '').trim())
    .filter(Boolean)
    .join(' — ')
  if (escrita) return escrita.slice(0, 300)
  return `Ubicación compartida (${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)})`
}

/**
 * Los métodos que acepta ESTE local, nunca una lista fija.
 *
 * Si el local no tiene ninguno configurado se dice, en vez de ofrecer una
 * lista vacía que dejaría al cliente sin salida con el carrito lleno.
 */
export function pedirMetodoPago(metodos: MetodoDePago[]): RespuestaDeCheckout {
  if (!metodos.length) {
    return {
      reply: '😕 Este local todavía no tiene formas de pago configuradas. '
        + 'Escribe *MENÚ* para elegir otro.',
      options: [],
    }
  }
  return {
    reply: '💳 ¿Cómo prefieres pagar?',
    options: metodos.map(metodo => metodo.label),
  }
}

/** El método elegido, comparando por su etiqueta o por su número de lista. */
export function elegirMetodo(
  mensaje: string,
  metodos: MetodoDePago[],
): MetodoDePago | null {
  const texto = String(mensaje || '').trim().toLowerCase()
  if (!texto) return null
  const porEtiqueta = metodos.find(m => m.label.toLowerCase() === texto)
  if (porEtiqueta) return porEtiqueta
  // El cliente puede tocar el botón (llega la etiqueta) o escribir el número,
  // igual que en el resto del menú.
  if (/^\d{1,2}$/.test(texto)) {
    const indice = Number(texto) - 1
    if (indice >= 0 && indice < metodos.length) return metodos[indice]
  }
  return null
}

/**
 * Lo que se responde al crear el pedido.
 *
 * ⚠️ El importe viene del pedido ya creado, no de una suma hecha aquí: es la
 * única cifra que el cliente puede usar para transferir, y tiene que ser
 * exactamente la que la base cobró.
 *
 * ⚠️ Si el método pide comprobante, el pedido nace esperando pago y el buzón
 * de comprobantes que ya existe adjunta la foto solo. Por eso aquí no hay
 * ningún paso de «subir comprobante»: basta con pedirlo.
 */
export function pedidoCreado(input: {
  orderNumber: number | null
  total: unknown
  metodo: MetodoDePago
  cuenta: CuentaBancaria | null
  telefonoDelLocal?: string | null
}): RespuestaDeCheckout {
  const numero = input.orderNumber ? `#${input.orderNumber}` : ''
  const cabecera = `✅ Pedido ${numero} registrado\n*Total: ${money(input.total)}*`

  if (!input.metodo.requires_proof) {
    // Efectivo o pago al retirar: no hay nada más que hacer.
    return {
      reply: `${cabecera}\n\n${input.metodo.help_text || 'Paga al recibir tu pedido.'}\n\n`
        + 'Te aviso por aquí cuando esté en preparación 👨‍🍳',
      options: [],
    }
  }

  if (!input.cuenta) {
    // El método exige comprobante pero el local no dejó datos bancarios. Se
    // dice, con el teléfono del local: el pedido ya existe y el cliente no
    // puede quedarse sin saber a dónde transferir.
    const contacto = input.telefonoDelLocal
      ? `\n\nEscríbeles al ${input.telefonoDelLocal} para coordinar el pago.`
      : ''
    return {
      reply: `${cabecera}\n\n⚠️ El local no tiene datos bancarios cargados.${contacto}`,
      options: [],
    }
  }

  const cuenta = input.cuenta
  const titular = [cuenta.holder_name, cuenta.holder_id]
    .map(parte => String(parte || '').trim())
    .filter(Boolean)
    .join(' · ')

  return {
    reply: `${cabecera}\n\n🏦 *Transfiere a:*\n`
      + `Banco: ${cuenta.bank_name}\n`
      + `Cuenta ${cuenta.account_type}: ${cuenta.account_number}\n`
      + (titular ? `Titular: ${titular}\n` : '')
      + `Valor exacto: *${money(input.total)}*\n\n`
      + (cuenta.instructions ? `${cuenta.instructions}\n\n` : '')
      + '📸 Cuando transfieras, envíame la foto del comprobante por aquí.',
    options: [],
  }
}

/** Cuando el pedido no se pudo crear. Nunca se invita a reenviarlo. */
/**
 * El pedido no se pudo crear.
 *
 * ⚠️ `motivo` llega cuando la BASE lo rechazó por una regla que el cliente
 * puede entender y resolver —tener ya tres pedidos sin confirmar, por
 * ejemplo—. Sin él se cae al texto de siempre: un fallo técnico no se le
 * explica al cliente, y decirle «reintenta» tras un error del que no sabemos
 * la causa es cómo se acaba con pedidos duplicados.
 */
export function pedidoNoCreado(motivo?: string | null): RespuestaDeCheckout {
  if (motivo) {
    return {
      reply: `😕 ${motivo}\n\nSi prefieres empezar de nuevo, escribe *MENÚ*.`,
      options: [],
    }
  }
  return {
    reply: '😕 No pude registrar tu pedido de forma segura. '
      + 'Para no duplicarlo, no lo envíes otra vez: el equipo lo va a revisar. '
      + 'Si prefieres empezar de nuevo, escribe *MENÚ*.',
    options: [],
  }
}
