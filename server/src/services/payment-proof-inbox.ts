// ── EL COMPROBANTE QUE LLEGA POR WHATSAPP ──────────────────────────────────
//
// La mayoría de la gente transfiere desde la app de su banco y manda la
// captura POR EL CHAT, no por la mini app. Hasta ahora esa foto se perdía para
// el pedido: el dueño la veía en su WhatsApp, pero el panel nunca activaba
// «Ver comprobante» y el pedido seguía en `esperando_pago` — con el cliente
// atascado en la pantalla de pago hasta que alguien lo marcara a mano.
//
// Esto la engancha: si quien manda la foto tiene un pedido esperando pago, se
// sube como su comprobante y el pedido pasa a `pago_en_revision`. A partir de
// ahí es EXACTAMENTE igual que subirla desde la app — misma RPC, mismo estado,
// misma alarma en el panel, mismo «Ver comprobante» con firma temporal.
//
// ── Las cuatro decisiones que lo hacen seguro ────────────────────────────
//
// 1. **Solo si hay un pedido esperando pago.** Sin eso no se toca Cloudinary,
//    y el negocio no paga almacenamiento por cada foto que le manden. Es
//    también lo que impide que una foto cualquiera se convierta en nada.
//
// 2. **El más reciente, si hay varios.** Es lo que haría cualquiera
//    mentalmente, y con dos pedidos abiertos el cliente está pensando en el
//    último.
//
// 3. **Si la foto NO es un comprobante, no pasa nada malo.** Se adjunta igual
//    y el pedido queda `pago_en_revision`, que es precisamente el estado en el
//    que una PERSONA lo mira antes de aceptar. El dueño ve una foto de un
//    perro, se ríe y le escribe. Preferible a perder comprobantes de verdad,
//    que es lo que pasaba hasta hoy.
//
// 4. **Privado, como en la app.** `uploadPrivateMedia` sube como
//    `authenticated`: un movimiento bancario con el nombre y la cuenta de una
//    persona no puede quedar en una URL pública que se adivine.
//
// ⚠️ NUNCA lanza. Esto corre dentro del camino de un mensaje entrante: si
// Cloudinary está caído o la RPC falla, el cliente tiene que recibir su
// respuesta igual. Un fallo va al registro de errores y la conversación sigue.

/**
 * Lo justo que hace falta del pedido. Se declara aquí en vez de importar el
 * tipo del repositorio —que es `Record<string, unknown>`— para que el
 * compilador compruebe de verdad los campos que se miran.
 */
export interface PedidoEsperandoPago {
  id?: unknown
  status?: unknown
  order_number?: number | null
  payment_proof_url?: unknown
  payment_confirmed_at?: unknown
  /**
   * El teléfono TAL COMO lo guardó el pedido.
   *
   * ⚠️ Se usa este y no el que llega por el canal: la RPC que adjunta compara
   * `contact_phone = btrim(p_contact_phone)`, exacto. Un pedido de la mini app
   * guarda `593990978367` y el mismo cliente por WhatsApp llega
   * `+593990978367` — buscar ya contempla las dos formas, pero al adjuntar hay
   * que devolverle a la base la que ella tiene escrita.
   */
  contact_phone?: unknown
}

/** Los estados en los que una foto es, casi con seguridad, el comprobante. */
const ESPERANDO_PAGO = 'esperando_pago'

export interface ComprobanteDependencias {
  /** El último pedido de ese contacto en ese negocio. */
  ultimoPedido(businessId: string, contactPhone: string): Promise<PedidoEsperandoPago | null>
  subirPrivado(buffer: Buffer, businessId: string): Promise<{ url: string; public_id: string }>
  adjuntar(input: {
    businessId: string
    orderId: string
    contactPhone: string
    url: string
    publicId?: string | null
  }): Promise<{ data: unknown; error: { message?: string } | null }>
  registrarError(input: {
    businessId?: string | null
    category: 'servidor'
    message: unknown
    context?: Record<string, unknown>
  }): Promise<void>
}

export interface ResultadoComprobante {
  /** `true` solo si la foto quedó adjunta al pedido. */
  adjuntado: boolean
  /** El número, para poder nombrarlo en la respuesta al cliente. */
  orderNumber?: number | null
}

/**
 * ¿Este pedido está esperando que su dueño pague?
 *
 * Se exige además que NO tenga ya comprobante: quien sube uno por la app y
 * después manda la misma foto por el chat no debe pisar el primero, porque el
 * pedido ya avanzó a revisión y el dueño puede estar mirándolo.
 */
export const esperaComprobante = (pedido: PedidoEsperandoPago | null): boolean => {
  if (!pedido?.id) return false
  if (pedido.status !== ESPERANDO_PAGO) return false
  if (pedido.payment_confirmed_at) return false
  return !pedido.payment_proof_url
}

export const crearBuzonDeComprobantes = (dependencias: ComprobanteDependencias) =>
  async function adjuntarComprobante(
    businessId: string,
    contactPhone: string,
    imagen: Buffer,
  ): Promise<ResultadoComprobante> {
    try {
      const pedido = await dependencias.ultimoPedido(businessId, contactPhone)
      // Sin pedido esperando pago no se sube NADA: ni un byte a Cloudinary.
      if (!esperaComprobante(pedido)) return { adjuntado: false }

      const subida = await dependencias.subirPrivado(imagen, businessId)
      const { error } = await dependencias.adjuntar({
        businessId,
        orderId: String(pedido!.id),
        // El del PEDIDO, no el del canal: ver el comentario del tipo.
        contactPhone: String(pedido!.contact_phone || contactPhone),
        url: subida.url,
        publicId: subida.public_id,
      })
      if (error) throw new Error(error.message || 'La base rechazó el comprobante')

      return { adjuntado: true, orderNumber: pedido!.order_number ?? null }
    } catch (error) {
      // El cliente recibe su respuesta igual: esto es una mejora del camino,
      // no el camino. Callarlo sería peor —el dueño creería tener un
      // comprobante que nunca llegó—, así que queda en el registro.
      await dependencias.registrarError({
        businessId,
        category: 'servidor',
        message: error,
        context: { motivo: 'comprobante por WhatsApp', contacto: contactPhone },
      }).catch(() => { /* registrar el fallo no puede provocar otro */ })
      return { adjuntado: false }
    }
  }

/**
 * Lo que se escribe en la conversación cuando la foto era un comprobante.
 *
 * No es un marcador técnico escondido: es la frase que el DUEÑO va a leer en
 * su panel al abrir ese chat, en el sitio donde antes había una imagen sin
 * explicación. Que además sirva para decidir la respuesta es un extra.
 */
export const MARCA_COMPROBANTE = 'su comprobante de pago'

export const textoDelComprobante = (orderNumber?: number | null): string =>
  `[el cliente envió ${MARCA_COMPROBANTE}${orderNumber ? ` del pedido #${orderNumber}` : ''}]`

export const esComprobante = (texto: string): boolean =>
  String(texto || '').includes(MARCA_COMPROBANTE)

/** Lo que se le responde. No lleva el enlace: ya pidió, ya pagó. */
export const RESPUESTA_COMPROBANTE =
  'Recibimos tu comprobante 🙌 El local lo está revisando y te avisamos '
  + 'en cuanto empiece a prepararlo.'
