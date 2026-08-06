import { clearToken, deviceId, readToken } from './session'
import type {
  Address, BankAccount, Catalog, Business, CartLine,
  Fulfillment, Me, OrderResult, PaymentMethod, StayQuote, StayRequest, StoreStatus,
} from './types'

/**
 * Error del servidor con la forma que la app necesita para reaccionar:
 * `reason` distingue "enlace de otro teléfono" de "enlace vencido", y eso
 * cambia por completo lo que se le dice al cliente.
 */
export class ApiError extends Error {
  readonly status: number
  readonly reason: string | null
  readonly code: string | null

  constructor(status: number, message: string, reason?: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason || null
    this.code = code || null
  }
}

/** ¿Este fallo significa que el enlace no sirve para este teléfono? */
export const isLinkProblem = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401

const request = async <T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const response = await fetch(`/api/store${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-storefront-token': readToken(),
      'x-storefront-device': deviceId(),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  let payload: Record<string, unknown> = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  if (!response.ok) {
    // Un 401 quiere decir que el token guardado ya no vale para nada. Se borra
    // para que un reintento no lo vuelva a mandar.
    //
    // Salvo 'necesita_telefono': ahí el token está PERFECTO, solo falta que
    // esta persona demuestre que el número es suyo. Borrarlo dejaba al cliente
    // legítimo sin enlace justo cuando iba a confirmarlo — entraba el número
    // correcto y aun así acababa en «Necesitas tu propio enlace».
    const soloFaltaElNumero = payload.reason === 'necesita_telefono'
    if (response.status === 401 && !soloFaltaElNumero) clearToken()
    throw new ApiError(
      response.status,
      String(payload.error || 'No pudimos completar la operación'),
      typeof payload.reason === 'string' ? payload.reason : undefined,
      typeof payload.code === 'string' ? payload.code : undefined,
    )
  }
  return payload as T
}

/** Portada. Es lo ÚNICO que responde sin enlace válido. */
export const getStore = (slug: string) =>
  request<{ business: Business; status: StoreStatus; canOrder: boolean }>(`/${slug}`)

export const getCatalog = (slug: string) => request<Catalog>(`/${slug}/catalog`)

export const getMe = (slug: string) => request<Me>(`/${slug}/me`)

export const getPaymentInfo = (slug: string) => request<BankAccount>(`/${slug}/payment-info`)

export const createAddress = (slug: string, body: {
  label: string; address: string; reference?: string; isDefault?: boolean
}) => request<Address>(`/${slug}/addresses`, { method: 'POST', body })

/**
 * Manda SOLO ids y cantidades. Ningún importe viaja desde el teléfono: el
 * total lo calcula la base contra su propio catálogo (regla inviolable #8).
 *
 * `idempotencyKey` la genera quien llama al abrir el checkout y la REPITE si
 * hay que reintentar. Sin ella, un doble toque en «Confirmar» —o un reintento
 * tras un corte de red— creaba dos comandas en la cocina y un cliente pagando
 * dos veces.
 */
export const createOrder = (slug: string, input: {
  lines: CartLine[]
  name?: string
  addressId?: string | null
  fulfillment: Fulfillment
  paymentMethod?: PaymentMethod | null
  idempotencyKey?: string
  /** Para cuándo lo quiere. Sin esto, lo antes posible. */
  scheduledFor?: string | null
}) => request<OrderResult>(`/${slug}/orders`, {
  method: 'POST',
  body: {
    name: input.name,
    addressId: input.addressId,
    fulfillment: input.fulfillment,
    idempotencyKey: input.idempotencyKey,
    scheduledFor: input.scheduledFor || null,
    paymentMethod: input.paymentMethod || null,
    items: input.lines.map(linea => ({
      productId: linea.product.id,
      variantId: linea.variant?.id || null,
      extraIds: linea.extras.map(extra => extra.id),
      // Solo id y cantidad: el recargo lo recalcula la base contra su propio
      // catálogo, nunca se envía desde aquí (regla inviolable #8).
      options: linea.options.map(opcion => ({
        optionId: opcion.optionId,
        quantity: opcion.quantity,
      })),
      quantity: linea.quantity,
      note: linea.note || null,
    })),
  },
})

/**
 * Comprobante de la transferencia. Va aparte del pedido y DESPUÉS de crearlo,
 * a propósito: el pedido ya está a salvo, así que si la subida falla —o el
 * cliente no encuentra la foto— no se pierde nada. Por eso no usa `request`:
 * viaja como multipart, no como JSON.
 */
export const uploadPaymentProof = async (slug: string, orderId: string, file: File) => {
  const cuerpo = new FormData()
  cuerpo.append('file', file)
  const response = await fetch(`/api/store/${slug}/orders/${orderId}/proof`, {
    method: 'POST',
    headers: {
      'x-storefront-token': readToken(),
      'x-storefront-device': deviceId(),
    },
    body: cuerpo,
  })
  let payload: Record<string, unknown> = {}
  try { payload = await response.json() } catch { payload = {} }
  if (!response.ok) {
    if (response.status === 401) clearToken()
    throw new ApiError(response.status, String(payload.error || 'No pudimos subir el comprobante'))
  }
  return payload as { ok: boolean; url: string }
}

// ── Hospedaje ──────────────────────────────────────────────────────────────

export const quoteStay = (slug: string, input: {
  checkIn: string; checkOut: string; adults: number; children: number; rooms: number
}) => request<StayQuote>(`/${slug}/stay/quote`, { method: 'POST', body: input })

export const requestStay = (slug: string, input: {
  roomTypeId: string; name: string; notes?: string
}) => request<StayRequest>(`/${slug}/stay/request`, { method: 'POST', body: input })

/**
 * Confirma el número de WhatsApp y ata la sesión a ESTE teléfono.
 *
 * Devuelve null si entró, o el texto a mostrar si no. No lanza: un número que
 * no coincide es lo esperado aquí —le pasa a todo el que reciba el enlace de
 * otra persona— y tratarlo como una excepción llenaría el registro de errores
 * de ruido.
 */
export async function confirmarTelefono(
  slug: string,
  telefono: string,
): Promise<string | null> {
  try {
    const respuesta = await fetch(`/api/store/${encodeURIComponent(slug)}/session/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-storefront-token': readToken(),
        'x-storefront-device': deviceId(),
      },
      body: JSON.stringify({ phone: telefono }),
    })
    if (respuesta.ok) return null
    const cuerpo = await respuesta.json().catch(() => ({}))
    if (respuesta.status === 429) {
      return 'Demasiados intentos. Espera un minuto y vuelve a probar.'
    }
    return String(
      (cuerpo as { error?: unknown }).error
      || 'Ese número no coincide con este enlace.',
    )
  } catch {
    return 'No pudimos comprobarlo. Revisa tu conexión e inténtalo otra vez.'
  }
}
