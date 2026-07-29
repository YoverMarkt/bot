import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  WHATSAPP_FLOW_MESSAGE_VERSION,
  buildWhatsAppFlowInteractive,
  buildWhatsAppFlowTemplate,
} = require('../dist/integrations/whatsapp-flow')

describe('contratos de transporte para WhatsApp Flows', () => {
  it('arma un Flow publicado que navega a una pantalla con datos iniciales', () => {
    expect(buildWhatsAppFlowInteractive({
      flowId: 'flow-pizzeria',
      flowToken: 'session-token-1',
      header: 'Monster Pizza',
      body: 'Arma tu pedido sin salir de WhatsApp.',
      footer: 'Precios y disponibilidad actuales',
      cta: 'Armar pedido',
      screen: 'ORDER_TYPE',
      data: { business_id: 'business-a' },
    })).toEqual({
      type: 'flow',
      header: { type: 'text', text: 'Monster Pizza' },
      body: { text: 'Arma tu pedido sin salir de WhatsApp.' },
      footer: { text: 'Precios y disponibilidad actuales' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_action: 'navigate',
          flow_token: 'session-token-1',
          flow_id: 'flow-pizzeria',
          flow_cta: 'Armar pedido',
          flow_action_payload: {
            screen: 'ORDER_TYPE',
            data: { business_id: 'business-a' },
          },
        },
      },
    })
    expect(WHATSAPP_FLOW_MESSAGE_VERSION).toBe('3')
  })

  it('arma un Flow dinámico sin inventar una pantalla inicial', () => {
    const payload = buildWhatsAppFlowInteractive({
      flowId: 'flow-dynamic',
      flowToken: 'session-token-2',
      body: 'Comienza tu solicitud.',
      cta: 'Comenzar',
      action: 'data_exchange',
    })

    expect(payload.action.parameters.flow_action).toBe('data_exchange')
    expect(payload.action.parameters).not.toHaveProperty('flow_action_payload')
    expect(payload).not.toHaveProperty('header')
    expect(payload).not.toHaveProperty('footer')
  })

  it('arma la plantilla Flow con variables y formato de índice por proveedor', () => {
    const launch = {
      templateName: 'retomar_pedido',
      languageCode: 'es',
      flowToken: 'session-token-3',
      flowActionData: { draft_id: 'draft-a' },
      buttonIndex: 1,
      bodyParameters: ['Andrea', 'Monster Pizza'],
    }

    const meta = buildWhatsAppFlowTemplate(launch)
    const ycloud = buildWhatsAppFlowTemplate(launch, 'number')

    expect(meta).toEqual({
      name: 'retomar_pedido',
      language: { code: 'es' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Andrea' },
            { type: 'text', text: 'Monster Pizza' },
          ],
        },
        {
          type: 'button',
          sub_type: 'flow',
          index: '1',
          parameters: [{
            type: 'action',
            action: {
              flow_token: 'session-token-3',
              flow_action_data: { draft_id: 'draft-a' },
            },
          }],
        },
      ],
    })
    expect(ycloud.components[1].index).toBe(1)
  })

  it('falla antes de llamar al proveedor si el CTA o la navegación son inválidos', () => {
    expect(() => buildWhatsAppFlowInteractive({
      flowId: 'flow-a',
      flowToken: 'token-a',
      body: 'Hola',
      cta: 'x'.repeat(21),
      screen: 'START',
    })).toThrow(/límite de 20/)

    expect(() => buildWhatsAppFlowInteractive({
      flowId: 'flow-a',
      flowToken: 'token-a',
      body: 'Hola',
      cta: 'Abrir',
      screen: '   ',
    })).toThrow(/screen es obligatorio/)

    expect(() => buildWhatsAppFlowTemplate({
      templateName: 'Nombre Inválido',
      languageCode: 'es',
      flowToken: 'token-a',
    })).toThrow(/minúsculas/)
  })
})
