export const WHATSAPP_FLOW_MESSAGE_VERSION = '3' as const

export type WhatsAppFlowAction = 'navigate' | 'data_exchange'
export type FlowData = Record<string, unknown>

interface FlowLaunchBase {
  flowId: string
  flowToken: string
  body: string
  cta: string
  header?: string
  footer?: string
}

export interface NavigateFlowLaunch extends FlowLaunchBase {
  action?: 'navigate'
  screen: string
  data?: FlowData
}

export interface DataExchangeFlowLaunch extends FlowLaunchBase {
  action: 'data_exchange'
  screen?: never
  data?: never
}

/**
 * A published Flow launched inside the customer-service window.
 * `flowToken` must identify one server-side session and must not be reused.
 */
export type WhatsAppFlowLaunch = NavigateFlowLaunch | DataExchangeFlowLaunch

export interface WhatsAppFlowTemplateLaunch {
  templateName: string
  languageCode: string
  flowToken: string
  flowActionData?: FlowData
  buttonIndex?: number
  bodyParameters?: readonly string[]
}

export interface WhatsAppFlowInteractivePayload {
  type: 'flow'
  header?: {
    type: 'text'
    text: string
  }
  body: {
    text: string
  }
  footer?: {
    text: string
  }
  action: {
    name: 'flow'
    parameters: {
      flow_message_version: typeof WHATSAPP_FLOW_MESSAGE_VERSION
      flow_action: WhatsAppFlowAction
      flow_token: string
      flow_id: string
      flow_cta: string
      flow_action_payload?: {
        screen: string
        data: FlowData
      }
    }
  }
}

interface FlowTemplateBodyComponent {
  type: 'body'
  parameters: {
    type: 'text'
    text: string
  }[]
}

interface FlowTemplateButtonComponent {
  type: 'button'
  sub_type: 'flow'
  index: string | number
  parameters: [{
    type: 'action'
    action: {
      flow_token: string
      flow_action_data?: FlowData
    }
  }]
}

export interface WhatsAppFlowTemplatePayload {
  name: string
  language: {
    code: string
  }
  components: (FlowTemplateBodyComponent | FlowTemplateButtonComponent)[]
}

const characterLength = (value: string): number => Array.from(value).length

function requiredText(value: string, field: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${field} es obligatorio para enviar un WhatsApp Flow`)
  return normalized
}

function boundedText(
  value: string | undefined,
  field: string,
  maximum: number,
  required = false,
): string | undefined {
  const normalized = String(value || '').trim()
  if (!normalized) {
    if (required) requiredText(normalized, field)
    return undefined
  }
  if (characterLength(normalized) > maximum) {
    throw new Error(`${field} supera el límite de ${maximum} caracteres de WhatsApp`)
  }
  return normalized
}

function normalizedButtonIndex(value: number | undefined): number {
  const index = value ?? 0
  if (!Number.isInteger(index) || index < 0 || index > 9) {
    throw new Error('buttonIndex debe ser un entero entre 0 y 9')
  }
  return index
}

export function buildWhatsAppFlowInteractive(
  launch: WhatsAppFlowLaunch,
): WhatsAppFlowInteractivePayload {
  const action = launch.action || 'navigate'
  const flowId = requiredText(launch.flowId, 'flowId')
  const flowToken = requiredText(launch.flowToken, 'flowToken')
  const body = boundedText(launch.body, 'body', 1024, true) as string
  const cta = boundedText(launch.cta, 'cta', 20, true) as string
  const header = boundedText(launch.header, 'header', 60)
  const footer = boundedText(launch.footer, 'footer', 60)

  const parameters: WhatsAppFlowInteractivePayload['action']['parameters'] = {
    flow_message_version: WHATSAPP_FLOW_MESSAGE_VERSION,
    flow_action: action,
    flow_token: flowToken,
    flow_id: flowId,
    flow_cta: cta,
  }

  if (launch.action !== 'data_exchange') {
    parameters.flow_action_payload = {
      screen: requiredText(launch.screen, 'screen'),
      data: launch.data || {},
    }
  }

  return {
    type: 'flow',
    ...(header ? { header: { type: 'text', text: header } } : {}),
    body: { text: body },
    ...(footer ? { footer: { text: footer } } : {}),
    action: {
      name: 'flow',
      parameters,
    },
  }
}

export function buildWhatsAppFlowTemplate(
  launch: WhatsAppFlowTemplateLaunch,
  indexFormat: 'string' | 'number' = 'string',
): WhatsAppFlowTemplatePayload {
  const templateName = requiredText(launch.templateName, 'templateName')
  if (!/^[a-z0-9_]+$/.test(templateName)) {
    throw new Error('templateName solo puede contener minúsculas, números y guiones bajos')
  }
  const languageCode = requiredText(launch.languageCode, 'languageCode')
  const flowToken = requiredText(launch.flowToken, 'flowToken')
  const index = normalizedButtonIndex(launch.buttonIndex)
  const components: WhatsAppFlowTemplatePayload['components'] = []

  if (launch.bodyParameters?.length) {
    components.push({
      type: 'body',
      parameters: launch.bodyParameters.map(text => ({
        type: 'text',
        text,
      })),
    })
  }

  components.push({
    type: 'button',
    sub_type: 'flow',
    index: indexFormat === 'number' ? index : String(index),
    parameters: [{
      type: 'action',
      action: {
        flow_token: flowToken,
        ...(launch.flowActionData
          ? { flow_action_data: launch.flowActionData }
          : {}),
      },
    }],
  })

  return {
    name: templateName,
    language: { code: languageCode },
    components,
  }
}
