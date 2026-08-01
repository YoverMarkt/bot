import { clearToken, deviceId, readToken } from './session'
import type {
  Address, BankAccount, Catalog, Business, CartLine,
  Fulfillment, Me, OrderResult, StayQuote, StayRequest, StoreStatus,
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
    if (response.status === 401) clearToken()
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
 */
export const createOrder = (slug: string, input: {
  lines: CartLine[]
  name?: string
  addressId?: string | null
  fulfillment: Fulfillment
}) => request<OrderResult>(`/${slug}/orders`, {
  method: 'POST',
  body: {
    name: input.name,
    addressId: input.addressId,
    fulfillment: input.fulfillment,
    items: input.lines.map(linea => ({
      productId: linea.product.id,
      variantId: linea.variant?.id || null,
      extraIds: linea.extras.map(extra => extra.id),
      quantity: linea.quantity,
      note: linea.note || null,
    })),
  },
})

// ── Hospedaje ──────────────────────────────────────────────────────────────

export const quoteStay = (slug: string, input: {
  checkIn: string; checkOut: string; adults: number; children: number; rooms: number
}) => request<StayQuote>(`/${slug}/stay/quote`, { method: 'POST', body: input })

export const requestStay = (slug: string, input: {
  roomTypeId: string; name: string; notes?: string
}) => request<StayRequest>(`/${slug}/stay/request`, { method: 'POST', body: input })
