import axios from 'axios'

const BASE_URL = 'https://api.ycloud.com/v2'
const OUTBOUND_TIMEOUT_MS = 15_000
const INBOUND_ACTION_TIMEOUT_MS = 3_000
const messageUrl = (direct: boolean): string => (
  `${BASE_URL}/whatsapp/messages${direct ? '/sendDirectly' : ''}`
)

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

// ── Botón de enlace (CTA URL) ──────────────────────────────────────────────
//
// Una URL cruda dentro de un mensaje se lee como spam: ocupa tres líneas, se
// parte en pantallas estrechas y la gente no la toca. WhatsApp tiene para esto
// el interactivo `cta_url`, que pinta un botón nativo bajo el texto.
//
// ⚠️ El tope de la etiqueta es de 20 BYTES, no de 20 caracteres, y ahí está la
// trampa: «🛍️ Ver la carta» son 15 caracteres pero 23 bytes, y WhatsApp lo
// rechaza. Por eso se recorta midiendo en bytes y las etiquetas van sin emoji.
//
// ⚠️ Es un mensaje de formato libre, así que vive bajo la MISMA regla que el
// texto que manda hoy el bot: dentro de la ventana de 24 h. No es una
// limitación nueva — el enlace siempre sale respondiendo a un mensaje del
// cliente, que es lo que abre esa ventana.
const CTA_LABEL_MAX_BYTES = 20
const FOOTER_MAX = 60

/** Recorta midiendo BYTES en UTF-8, sin partir un carácter por la mitad. */
const clipBytes = (value: string, maxBytes: number): string => {
  const clean = String(value || '').trim()
  const encoder = new TextEncoder()
  if (encoder.encode(clean).length <= maxBytes) return clean
  let corto = ''
  for (const caracter of clean) {
    if (encoder.encode(corto + caracter).length > maxBytes) break
    corto += caracter
  }
  return corto.trim()
}

export interface CtaUrlMessage {
  body: string
  url: string
  /** La etiqueta del botón. Máximo 20 bytes; sin emoji, que ocupan cuatro. */
  label: string
  footer?: string | null
}

export function buildCtaUrlPayload(input: CtaUrlMessage): Record<string, unknown> | null {
  const url = String(input.url || '').trim()
  const body = clip(input.body, BODY_MAX)
  const label = clipBytes(input.label, CTA_LABEL_MAX_BYTES)
  // Sin URL válida no se manda un botón que no lleva a ninguna parte: quien
  // llama se entera con `null` y cae al texto de siempre.
  if (!/^https?:\/\//i.test(url) || !label || !body) return null
  const footer = clip(input.footer || '', FOOTER_MAX)
  return {
    type: 'cta_url',
    body: { text: body },
    ...(footer ? { footer: { text: footer } } : {}),
    action: {
      name: 'cta_url',
      parameters: { display_text: label, url },
    },
  }
}

export async function sendCtaUrl(
  apiKey: string,
  fromNumber: string,
  to: string,
  message: CtaUrlMessage,
  direct = false,
): Promise<boolean> {
  const interactive = buildCtaUrlPayload(message)
  if (!interactive) return false
  await axios.post(messageUrl(direct), {
    from: fromNumber,
    to,
    type: 'interactive',
    interactive,
  }, { headers: headers(apiKey), timeout: OUTBOUND_TIMEOUT_MS })
  return true
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
