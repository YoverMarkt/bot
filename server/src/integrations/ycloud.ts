import axios from 'axios'
import {
  buildWhatsAppFlowInteractive,
  buildWhatsAppFlowTemplate,
  type FlowData,
  type WhatsAppFlowLaunch,
  type WhatsAppFlowTemplateLaunch,
} from './whatsapp-flow'

const BASE_URL = 'https://api.ycloud.com/v2'
const OUTBOUND_TIMEOUT_MS = 15_000
const INBOUND_ACTION_TIMEOUT_MS = 3_000
const messageUrl = (direct: boolean): string => (
  `${BASE_URL}/whatsapp/messages${direct ? '/sendDirectly' : ''}`
)
const flowUrl = (flowId?: string, action?: 'publish'): string => {
  const path = flowId
    ? `/whatsapp/flows/${encodeURIComponent(flowId)}`
    : '/whatsapp/flows'
  return `${BASE_URL}${path}${action ? `/${action}` : ''}`
}

function headers(apiKey: string) {
  return { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }
}

export async function sendText(
  apiKey: string,
  fromNumber: string,
  to: string,
  text: string,
): Promise<void> {
  await axios.post(`${BASE_URL}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'text',
    text: { body: text },
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

// ── Mensajes interactivos (botones y listas) ────────────────────────
// Límites de WhatsApp: hasta 3 botones de respuesta; si hay más opciones va
// una lista de hasta 10 filas. El `id` de cada opción es su NÚMERO, para que
// la respuesta no dependa del título (que WhatsApp trunca).
export interface InteractiveOption {
  id: string
  title: string
  description?: string
}

const MAX_BUTTONS = 3
export const MAX_LIST_ROWS = 10
const BUTTON_TITLE_MAX = 20
const ROW_TITLE_MAX = 24
const ROW_DESCRIPTION_MAX = 72
const BODY_MAX = 1024

const clip = (value: string, max: number): string => {
  const clean = String(value || '').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

export function buildInteractivePayload(
  body: string,
  options: InteractiveOption[],
  listButtonText = 'Ver opciones',
): Record<string, unknown> | null {
  const rows = options.slice(0, MAX_LIST_ROWS)
  if (!rows.length) return null
  const text = clip(body || 'Elige una opción', BODY_MAX)
  if (rows.length <= MAX_BUTTONS && rows.every(option => !option.description)) {
    return {
      type: 'button',
      body: { text },
      action: {
        buttons: rows.map(option => ({
          type: 'reply',
          reply: { id: option.id, title: clip(option.title, BUTTON_TITLE_MAX) },
        })),
      },
    }
  }
  return {
    type: 'list',
    body: { text },
    action: {
      button: clip(listButtonText, BUTTON_TITLE_MAX),
      sections: [{
        rows: rows.map(option => ({
          id: option.id,
          title: clip(option.title, ROW_TITLE_MAX),
          ...(option.description
            ? { description: clip(option.description, ROW_DESCRIPTION_MAX) }
            : {}),
        })),
      }],
    },
  }
}

export async function sendInteractive(
  apiKey: string,
  fromNumber: string,
  to: string,
  body: string,
  options: InteractiveOption[],
  listButtonText?: string,
  direct = false,
): Promise<boolean> {
  const interactive = buildInteractivePayload(body, options, listButtonText)
  if (!interactive) return false
  await axios.post(messageUrl(direct), {
    from: fromNumber,
    to,
    type: 'interactive',
    interactive,
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
  return true
}

// Un Flow interactivo es un mensaje libre: el llamador debe usarlo solamente
// dentro de la ventana de atención de 24 horas. Por defecto se envía de forma
// directa para conocer la aceptación del proveedor antes de continuar el flujo.
export async function sendSessionFlow(
  apiKey: string,
  fromNumber: string,
  to: string,
  launch: WhatsAppFlowLaunch,
  direct = true,
): Promise<void> {
  await axios.post(messageUrl(direct), {
    from: fromNumber,
    to,
    type: 'interactive',
    interactive: buildWhatsAppFlowInteractive(launch),
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

// Las plantillas con botón Flow permiten abrir el mismo formulario fuera de la
// ventana de 24 horas, siempre que Meta haya aprobado el nombre y el idioma.
export async function sendFlowTemplate(
  apiKey: string,
  fromNumber: string,
  to: string,
  launch: WhatsAppFlowTemplateLaunch,
  direct = true,
): Promise<void> {
  await axios.post(messageUrl(direct), {
    from: fromNumber,
    to,
    type: 'template',
    template: buildWhatsAppFlowTemplate(launch, 'number'),
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

export async function sendImage(
  apiKey: string,
  fromNumber: string,
  to: string,
  imageUrl: string,
  caption = '',
  direct = false,
): Promise<void> {
  await axios.post(messageUrl(direct), {
    from: fromNumber,
    to,
    type: 'image',
    image: { link: imageUrl, caption },
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

export async function sendVideo(
  apiKey: string,
  fromNumber: string,
  to: string,
  videoUrl: string,
  caption = '',
  direct = false,
): Promise<void> {
  await axios.post(messageUrl(direct), {
    from: fromNumber,
    to,
    type: 'video',
    video: { link: videoUrl, caption },
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
}

export type YCloudFlowCategory =
  | 'SIGN_UP'
  | 'SIGN_IN'
  | 'APPOINTMENT_BOOKING'
  | 'LEAD_GENERATION'
  | 'CONTACT_US'
  | 'CUSTOMER_SUPPORT'
  | 'SURVEY'
  | 'OTHER'

export type YCloudFlowStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'DEPRECATED'
  | 'BLOCKED'
  | 'THROTTLED'

export interface YCloudFlowValidationError {
  error?: string
  errorType?: string
  message?: string
  lineStart?: number
  lineEnd?: number
  columnStart?: number
  columnEnd?: number
  pointers?: {
    path?: string
    lineStart?: number
    lineEnd?: number
    columnStart?: number
    columnEnd?: number
  }[]
}

export interface YCloudFlowListItem {
  id?: string
  name?: string
  status?: YCloudFlowStatus
  categories?: YCloudFlowCategory[]
  validationErrors?: YCloudFlowValidationError[]
  jsonVersion?: string | null
  dataApiVersion?: string | null
  endpointUrl?: string | null
}

export interface YCloudFlowList {
  items?: YCloudFlowListItem[]
}

export interface YCloudFlowCreate {
  wabaId: string
  name: string
  categories: YCloudFlowCategory[]
  flowJson?: string | FlowData
  publish?: boolean
  cloneFlowId?: string
  endpointUri?: string
}

export interface YCloudFlowCreateResult {
  id?: string
  success?: boolean
}

export interface YCloudFlowOperationResult {
  success?: boolean
}

function requiredFlowValue(value: string, field: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${field} es obligatorio para administrar un Flow`)
  return normalized
}

function serializedFlowJson(value: string | FlowData): string {
  if (typeof value !== 'string') return JSON.stringify(value)
  const normalized = value.trim()
  if (!normalized) throw new Error('flowJson no puede estar vacío')
  try {
    const parsed = JSON.parse(normalized) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid')
    }
  } catch {
    throw new Error('flowJson debe contener un objeto JSON válido')
  }
  return normalized
}

function validEndpointUri(value: string): string {
  const normalized = requiredFlowValue(value, 'endpointUri')
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'https:') throw new Error('invalid')
  } catch {
    throw new Error('endpointUri debe ser una URL HTTPS válida')
  }
  return normalized
}

/**
 * Creates a Flow owned by the supplied WABA. This is intentionally separate
 * from message sending so provisioning can be authorized from an admin path.
 */
export async function createFlow(
  apiKey: string,
  input: YCloudFlowCreate,
): Promise<YCloudFlowCreateResult> {
  if (!input.categories?.length) {
    throw new Error('categories debe incluir al menos una categoría de Flow')
  }
  const payload = {
    wabaId: requiredFlowValue(input.wabaId, 'wabaId'),
    name: requiredFlowValue(input.name, 'name'),
    categories: input.categories,
    ...(input.flowJson !== undefined
      ? { flowJson: serializedFlowJson(input.flowJson) }
      : {}),
    ...(input.publish !== undefined ? { publish: input.publish } : {}),
    ...(input.cloneFlowId
      ? { cloneFlowId: requiredFlowValue(input.cloneFlowId, 'cloneFlowId') }
      : {}),
    ...(input.endpointUri
      ? { endpointUri: validEndpointUri(input.endpointUri) }
      : {}),
  }
  const response = await axios.post<YCloudFlowCreateResult>(
    flowUrl(),
    payload,
    { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS },
  )
  return response.data
}

export async function listFlows(
  apiKey: string,
  wabaId: string,
): Promise<YCloudFlowList> {
  const response = await axios.get<YCloudFlowList>(flowUrl(), {
    params: { wabaId: requiredFlowValue(wabaId, 'wabaId') },
    headers: headers(apiKey),
    timeout: OUTBOUND_TIMEOUT_MS,
  })
  return response.data
}

export async function retrieveFlow(
  apiKey: string,
  flowId: string,
): Promise<YCloudFlowListItem> {
  const response = await axios.get<YCloudFlowListItem>(
    flowUrl(requiredFlowValue(flowId, 'flowId')),
    {
      headers: headers(apiKey),
      timeout: OUTBOUND_TIMEOUT_MS,
    },
  )
  return response.data
}

export async function publishFlow(
  apiKey: string,
  flowId: string,
): Promise<YCloudFlowOperationResult> {
  const response = await axios.post<YCloudFlowOperationResult>(
    flowUrl(requiredFlowValue(flowId, 'flowId'), 'publish'),
    undefined,
    { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS },
  )
  return response.data
}

function inboundActionUrl(
  inboundMessageId: string,
  action: 'markAsRead' | 'typingIndicator',
): string {
  return `${BASE_URL}/whatsapp/inboundMessages/${encodeURIComponent(inboundMessageId)}/${action}`
}

// Marca explícitamente el mensaje entrante como leído (✓✓ azul).
// YCloud acepta tanto el `id` propio del inbound como su `wamid`.
export async function markAsRead(
  apiKey: string,
  inboundMessageId?: string | null,
): Promise<void> {
  const id = String(inboundMessageId || '').trim()
  if (!id) return
  await axios.post(
    inboundActionUrl(id, 'markAsRead'),
    {},
    { headers: headers(apiKey), timeout: INBOUND_ACTION_TIMEOUT_MS },
  )
}

// Muestra "escribiendo…"; este endpoint también marca leído, por lo que sirve
// como respaldo si YCloud rechaza temporalmente la operación explícita.
export async function showTyping(
  apiKey: string,
  inboundMessageId?: string | null,
): Promise<void> {
  const id = String(inboundMessageId || '').trim()
  if (!id) return
  await axios.post(
    inboundActionUrl(id, 'typingIndicator'),
    {},
    { headers: headers(apiKey), timeout: INBOUND_ACTION_TIMEOUT_MS },
  )
}
