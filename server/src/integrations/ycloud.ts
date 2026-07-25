import axios from 'axios'

const BASE_URL = 'https://api.ycloud.com/v2'
const OUTBOUND_TIMEOUT_MS = 15_000
const INBOUND_ACTION_TIMEOUT_MS = 3_000

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
): Promise<boolean> {
  const interactive = buildInteractivePayload(body, options, listButtonText)
  if (!interactive) return false
  await axios.post(`${BASE_URL}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'interactive',
    interactive,
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
  return true
}

export async function sendImage(
  apiKey: string,
  fromNumber: string,
  to: string,
  imageUrl: string,
  caption = '',
): Promise<void> {
  await axios.post(`${BASE_URL}/whatsapp/messages`, {
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
): Promise<void> {
  await axios.post(`${BASE_URL}/whatsapp/messages`, {
    from: fromNumber,
    to,
    type: 'video',
    video: { link: videoUrl, caption },
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
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
