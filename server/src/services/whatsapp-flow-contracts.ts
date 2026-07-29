export interface OrderFlowItem {
  productId: string
  quantity: number
  modifierIds: string[]
  note: string | null
}
export interface OrderFlowSubmission {
  flowToken: string
  fulfillment: 'delivery' | 'pickup' | 'onsite'
  contactName: string
  items: OrderFlowItem[]
  address: string | null
  addressReference: string | null
  paymentMethod: string | null
  requestedFor: string | null
  notes: string | null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ITEMS = 20
const MAX_MODIFIERS_PER_ITEM = 12

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function textValue(
  value: unknown,
  maximum: number,
  required = false,
): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error('Falta un campo obligatorio del pedido')
    return null
  }
  if (typeof value !== 'string') throw new Error('El pedido contiene un campo inválido')
  const clean = value.trim()
  if ((!clean && required) || clean.length > maximum) {
    throw new Error('El pedido contiene un campo inválido')
  }
  return clean || null
}

function parseItems(value: unknown): unknown[] {
  let source = value
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > 32 * 1024) {
      throw new Error('El carrito del Flow es demasiado grande')
    }
    try {
      source = JSON.parse(source) as unknown
    } catch {
      throw new Error('El carrito del Flow no es JSON válido')
    }
  }
  if (!Array.isArray(source) || source.length < 1 || source.length > MAX_ITEMS) {
    throw new Error('El pedido necesita entre 1 y 20 ítems')
  }
  return source
}

function parseModifierIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_MODIFIERS_PER_ITEM) {
    throw new Error('Los modificadores del pedido son inválidos')
  }
  const ids = value.map((item) => {
    if (typeof item !== 'string' || !UUID_PATTERN.test(item)) {
      throw new Error('Los modificadores del pedido son inválidos')
    }
    return item.toLowerCase()
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error('El pedido contiene modificadores repetidos')
  }
  return ids
}

export function parseOrderFlowSubmission(
  value: unknown,
): OrderFlowSubmission {
  const source = recordValue(value)
  if (!source) throw new Error('Respuesta de pedido inválida')
  const flowToken = textValue(source.flow_token, 512, true) as string
  const fulfillment = textValue(source.fulfillment, 20, true)
  if (fulfillment !== 'delivery'
    && fulfillment !== 'pickup'
    && fulfillment !== 'onsite') {
    throw new Error('La modalidad de entrega es inválida')
  }

  const items = parseItems(source.items ?? source.items_json).map((raw) => {
    const item = recordValue(raw)
    const productId = textValue(item?.product_id, 64, true)
    const quantity = Number(item?.quantity)
    if (!productId || !UUID_PATTERN.test(productId)
      || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Error('El pedido contiene un producto o cantidad inválidos')
    }
    return {
      productId: productId.toLowerCase(),
      quantity,
      modifierIds: parseModifierIds(item?.modifier_ids),
      note: textValue(item?.note, 240),
    }
  })

  const address = textValue(source.address, 500)
  if (fulfillment === 'delivery' && !address) {
    throw new Error('La dirección es obligatoria para una entrega')
  }

  return {
    flowToken,
    fulfillment,
    contactName: textValue(source.contact_name, 120, true) as string,
    items,
    address,
    addressReference: textValue(source.address_reference, 500),
    paymentMethod: textValue(source.payment_method, 120),
    requestedFor: textValue(source.requested_for, 80),
    notes: textValue(source.notes, 1000),
  }
}
