import crypto from 'node:crypto'

/**
 * LA HUELLA DEL COMPROBANTE
 *
 * Registra cada comprobante que llega —venga del chat o de la mini app— con
 * sus dos huellas, y avisa si esa misma imagen ya se usó antes.
 *
 * ⚠️ Es una capa ENCIMA del flujo de siempre, no un reemplazo.
 * `attach_storefront_payment_proof` sigue siendo lo que mueve el pedido a
 * `pago_en_revision` y lo que el panel enseña. Si esto falla, el comprobante
 * se adjunta igual: un fallo registrando la huella no puede dejar a un
 * cliente sin poder pagar.
 *
 * ⚠️ Y NUNCA confirma un pago. Un comprobante limpio sigue siendo una imagen:
 * pudo editarse, generarse o reutilizarse. Lo único que hace es darle al
 * dueño una señal más antes de que él decida.
 *
 * Las dos huellas se complementan:
 *
 *   · **SHA-256** caza el archivo idéntico. Exacto, gratis, nunca falla.
 *   · **Perceptual** caza la misma imagen recortada o recomprimida — que es
 *     lo que pasa al reenviar por WhatsApp, porque WhatsApp la recomprime y
 *     el SHA ya no coincide. Lo calcula Cloudinary al subirla.
 */

export interface ReceiptIngestDatabase {
  registerPaymentReceipt(input: {
    businessId: string
    orderId: string
    fileUrl: string
    filePublicId?: string | null
    sha256: string
    perceptualHash?: string | null
    mimeType?: string | null
    fileSize?: number | null
  }): Promise<{
    data?: {
      result?: string
      receipt_id?: string
      duplicado?: boolean
      duplicado_exacto?: boolean
      duplicado_visual?: boolean
      pedido_previo?: number | null
    } | null
    error?: { message?: string } | null
  }>
}

export interface HuellaDelComprobante {
  registrado: boolean
  receiptId?: string
  duplicado: boolean
  /** El mismo archivo, byte a byte. */
  duplicadoExacto: boolean
  /** La misma imagen recortada o recomprimida. */
  duplicadoVisual: boolean
  /**
   * El pedido de ESTE negocio donde ya se usó, si lo hubo.
   *
   * ⚠️ Nulo cuando el duplicado está en otro local: que exista basta para
   * desconfiar, y el número de pedido ajeno no es asunto de este dueño.
   */
  pedidoPrevio?: number | null
}

/** La huella exacta del archivo, sin tocar disco. */
export const huellaDelArchivo = (imagen: Buffer): string =>
  crypto.createHash('sha256').update(imagen).digest('hex')

export const crearRegistroDeComprobantes = (dependencias: {
  database: ReceiptIngestDatabase
  logger?: { log(...args: unknown[]): void }
}) =>
  /**
   * Registra el comprobante y devuelve lo que se sabe de él.
   *
   * NUNCA lanza: corre después de que el comprobante ya se adjuntó al pedido,
   * y un fallo aquí no puede deshacer eso ni dejar al cliente sin respuesta.
   */
  async function registrarComprobante(input: {
    businessId: string
    orderId: string
    imagen: Buffer
    fileUrl: string
    filePublicId?: string | null
    perceptualHash?: string | null
    mimeType?: string | null
  }): Promise<HuellaDelComprobante> {
    const vacio: HuellaDelComprobante = {
      registrado: false,
      duplicado: false,
      duplicadoExacto: false,
      duplicadoVisual: false,
    }
    try {
      const { data, error } = await dependencias.database.registerPaymentReceipt({
        businessId: input.businessId,
        orderId: input.orderId,
        fileUrl: input.fileUrl,
        filePublicId: input.filePublicId ?? null,
        sha256: huellaDelArchivo(input.imagen),
        perceptualHash: input.perceptualHash ?? null,
        mimeType: input.mimeType ?? null,
        fileSize: input.imagen.length,
      })
      if (error || !data || data.result !== 'registered') {
        dependencias.logger?.log(
          `⚠️  [comprobante] no se pudo registrar la huella: ${error?.message || data?.result || 'sin datos'}`,
        )
        return vacio
      }

      const huella: HuellaDelComprobante = {
        registrado: true,
        receiptId: data.receipt_id,
        duplicado: Boolean(data.duplicado),
        duplicadoExacto: Boolean(data.duplicado_exacto),
        duplicadoVisual: Boolean(data.duplicado_visual),
        pedidoPrevio: data.pedido_previo ?? null,
      }
      if (huella.duplicado) {
        dependencias.logger?.log(
          `🚨 [comprobante] POSIBLE DUPLICADO — ${
            huella.duplicadoExacto ? 'mismo archivo' : 'misma imagen'
          }${huella.pedidoPrevio ? ` (pedido #${huella.pedidoPrevio})` : ''}`,
        )
      }
      return huella
    } catch (error) {
      dependencias.logger?.log(
        `⚠️  [comprobante] fallo registrando la huella: ${
          error instanceof Error ? error.message : 'desconocido'
        }`,
      )
      return vacio
    }
  }

const database: ReceiptIngestDatabase = require('../db') as unknown as ReceiptIngestDatabase

export const registrarComprobante = crearRegistroDeComprobantes({
  database,
  logger: console,
})
