import crypto from 'node:crypto'
import {
  compararConElPedido, leerReglas,
  type LoEsperado, type SenalDeRiesgo,
} from './receipt-analysis'
import type { ResultadoVision } from './receipt-vision'

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
  /**
   * Guarda lo leído, sus señales y el score. Opcional a propósito: sin ella el
   * registro se comporta exactamente como antes de que el análisis existiera.
   */
  saveReceiptAnalysis?(input: {
    businessId: string
    receiptId: string
    status: 'analizado' | 'requiere_revision'
    datos?: Record<string, unknown> | null
    flags?: Array<Record<string, unknown>> | null
    analysis?: Record<string, unknown> | null
    puntosReferencia?: number
  }): Promise<{ error?: { message?: string } | null }>
  /** La cuenta que el negocio publica, para comparar el destino del dinero. */
  getBusinessBankAccount?(businessId: string): Promise<{
    bank_name?: string | null
    account_number?: string | null
    holder_name?: string | null
  } | null>
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
  /** Los puntos de cada señal, de `server_settings`. Sin esto, los de código. */
  settings?: { get(key: 'receipt_risk_rules'): Promise<string | null> }
  logger?: { log(...args: unknown[]): void }
}) => {
  /**
   * Guarda lo que la visión leyó, comparado con el pedido.
   *
   * ⚠️ LOS TRES DESENLACES, y la diferencia entre ellos importa:
   *
   *   · **Análisis apagado** (`motivo: 'apagado'`) → no se escribe nada y el
   *     comprobante se queda en `pendiente_analisis`. No hay nada que decir:
   *     nadie lo miró. Es el estado de siempre.
   *   · **Análisis encendido pero fallido** —OpenAI caído, sin saldo, JSON
   *     roto— → `requiere_revision`. Se intentó y no se pudo, y el dueño tiene
   *     que saber que ese comprobante no lleva señales porque nadie las buscó,
   *     no porque estuviera limpio. Falla ABIERTO: no bloquea nada.
   *   · **Leído** → `analizado`, con sus campos y sus señales.
   *
   * ⚠️ Ninguno de los tres confirma un pago ni mueve el pedido. La RPC no
   * escribe una sola columna de `orders`.
   */
  async function guardarAnalisis(
    receiptId: string,
    input: {
      businessId: string
      analisis?: ResultadoVision
      esperado?: Omit<LoEsperado, 'cuenta'>
    },
  ): Promise<void> {
    const guardar = dependencias.database.saveReceiptAnalysis
    // Sin la función en la base, o con el análisis apagado, esto no existe: el
    // comprobante se queda como siempre. Es el camino de hoy.
    if (!guardar || !input.analisis) return
    if (!input.analisis.ok && input.analisis.motivo === 'apagado') return

    const reglas = leerReglas(
      dependencias.settings
        ? await dependencias.settings.get('receipt_risk_rules').catch(() => null)
        : null,
    )

    // No se pudo leer: se deja constancia de que se intentó, sin acusar a
    // nadie. `ilegible` no dice que el comprobante sea falso, dice que hacen
    // falta ojos humanos — que es exactamente lo que había antes de esto.
    if (!input.analisis.ok) {
      await guardar({
        businessId: input.businessId,
        receiptId,
        status: 'requiere_revision',
        flags: [{
          flag_type: 'ilegible',
          severity: 'media',
          description: 'No se pudo leer el comprobante automáticamente: revísalo a mano',
          points: reglas.ilegible,
        }],
        analysis: { motivo: input.analisis.motivo },
        puntosReferencia: reglas.referencia_duplicada,
      })
      dependencias.logger?.log(
        `⚠️  [comprobante] sin análisis (${input.analisis.motivo}): queda para revisión manual`,
      )
      return
    }

    const cuenta = dependencias.database.getBusinessBankAccount
      ? await dependencias.database.getBusinessBankAccount(input.businessId).catch(() => null)
      : null

    const senales: SenalDeRiesgo[] = input.esperado
      ? compararConElPedido(input.analisis.datos, { ...input.esperado, cuenta }, reglas)
      : []

    // El modelo dijo que no era un comprobante, pero se vio alguna señal
    // suelta —un monto, una fecha— y por eso llegó hasta aquí en vez de
    // rechazarse. No se decide por él: se marca fuerte y lo mira una persona.
    if (!input.analisis.esComprobante && reglas.patron_debil !== 0) {
      senales.push({
        flag_type: 'patron_debil',
        severity: 'alta',
        description: 'La imagen apenas tiene rasgos de un comprobante bancario',
        points: reglas.patron_debil,
      })
    }

    const { error } = await guardar({
      businessId: input.businessId,
      receiptId,
      status: 'analizado',
      datos: input.analisis.datos as Record<string, unknown>,
      flags: senales as unknown as Array<Record<string, unknown>>,
      analysis: input.analisis.crudo,
      puntosReferencia: reglas.referencia_duplicada,
    })
    if (error) {
      dependencias.logger?.log(
        `⚠️  [comprobante] no se pudo guardar el análisis: ${error.message || 'sin detalle'}`,
      )
    }
  }

  /**
   * Registra el comprobante y devuelve lo que se sabe de él.
   *
   * NUNCA lanza: corre después de que el comprobante ya se adjuntó al pedido,
   * y un fallo aquí no puede deshacer eso ni dejar al cliente sin respuesta.
   */
  return async function registrarComprobante(input: {
    businessId: string
    orderId: string
    imagen: Buffer
    fileUrl: string
    filePublicId?: string | null
    perceptualHash?: string | null
    mimeType?: string | null
    /**
     * Lo que la visión ya leyó de esta imagen.
     *
     * ⚠️ Se RECIBE en vez de calcularse aquí: quien llama ya pagó esa lectura
     * para decidir si la foto era siquiera un comprobante. Volver a llamar al
     * modelo sería cobrar dos veces por mirar la misma imagen.
     *
     * Ausente = el análisis está apagado y el comprobante se queda en
     * `pendiente_analisis`, exactamente como antes de que esto existiera.
     */
    analisis?: ResultadoVision
    /** Lo que el pedido dice que hay que cobrar, para comparar. */
    esperado?: Omit<LoEsperado, 'cuenta'>
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

      // El análisis va DESPUÉS y en su propio try: un fallo guardándolo no
      // puede tirar la huella, que ya está registrada y ya marcó el duplicado.
      if (huella.receiptId) {
        await guardarAnalisis(huella.receiptId, input).catch(() => { /* ya se registró */ })
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
}

/**
 * ¿Lo leído CUADRA con este pedido?
 *
 * Es la segunda pregunta del comprobante, y la que faltaba. `analizarComprobante`
 * responde «¿esto es siquiera un pago?» —la portería—; esta responde «¿es ESTE
 * pago?». Un comprobante impecable de una transferencia a otra persona pasa la
 * primera y falla esta.
 *
 * ⚠️ Reutiliza `compararConElPedido`, la MISMA comparación que puntúa el
 * comprobante para el panel del dueño. Una segunda comparación aquí acabaría
 * contestando distinto que la del panel, y el dueño vería un comprobante en
 * verde que el bot rechazó.
 *
 * ⚠️ Solo `severity: 'critica'` corta, y hoy eso son dos señales:
 * `cuenta_incorrecta` (el dinero fue a otra cuenta) y `monto_menor` (pagó menos
 * de lo que cuesta). El NOMBRE de quien paga no corta nunca — la gente
 * transfiere desde la cuenta de su pareja, de su madre o del negocio, y el
 * propio análisis ya decidió no marcar el beneficiario por eso mismo.
 *
 * ⚠️ Una regla puesta en cero APAGA su señal, y entonces deja de cortar: el
 * dueño puede desactivar cualquiera desde `receipt_risk_rules` sin desplegar.
 *
 * ⚠️ Falla hacia NO cortar: sin cuenta bancaria cargada, sin datos leídos o
 * ante cualquier excepción devuelve `{ critica: null, limpio: false }` — se
 * adjunta y decide el dueño, que es lo que se hacía antes de esto.
 */
export const crearCuadreDelComprobante = (dependencias: {
  database: Pick<ReceiptIngestDatabase, 'getBusinessBankAccount'>
  settings?: { get(key: 'receipt_risk_rules'): Promise<string | null> }
}) => async (input: {
  businessId: string
  analisis: unknown
  esperado: { total: number; createdAt: string | null }
}): Promise<{
  critica: { flag_type: string; description: string } | null
  limpio: boolean
}> => {
  const vacio = { critica: null, limpio: false }
  try {
    const analisis = input.analisis as { ok?: boolean; datos?: unknown } | null
    if (!analisis?.ok || !analisis.datos) return vacio

    const reglas = leerReglas(
      dependencias.settings
        ? await dependencias.settings.get('receipt_risk_rules').catch(() => null)
        : null,
    )
    const cuenta = dependencias.database.getBusinessBankAccount
      ? await dependencias.database.getBusinessBankAccount(input.businessId).catch(() => null)
      : null

    const senales = compararConElPedido(
      analisis.datos as never,
      { ...input.esperado, cuenta },
      reglas,
    )
    const critica = senales.find(senal => senal.severity === 'critica') || null
    return {
      critica: critica
        ? { flag_type: critica.flag_type, description: critica.description }
        : null,
      // Limpio = ni una señal que preocupe. Las de severidad `baja` son las que
      // CONFIRMAN que algo cuadra («la cuenta es la del negocio»), así que no
      // cuentan como problema.
      limpio: !senales.some(senal => senal.severity !== 'baja'),
    }
  } catch {
    return vacio
  }
}

const database: ReceiptIngestDatabase = require('../db') as unknown as ReceiptIngestDatabase

export const registrarComprobante = crearRegistroDeComprobantes({
  database,
  settings: require('./settings') as { get(key: 'receipt_risk_rules'): Promise<string | null> },
  logger: console,
})

export const cuadreDelComprobante = crearCuadreDelComprobante({
  database,
  settings: require('./settings') as { get(key: 'receipt_risk_rules'): Promise<string | null> },
})
