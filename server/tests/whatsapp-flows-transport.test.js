import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const axios = require('axios')
const ycloud = require('../dist/integrations/ycloud')
const whatsapp = require('../dist/integrations/whatsapp')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('transporte multi-proveedor de WhatsApp Flows', () => {
  it('envía un Flow de sesión por Meta y conserva el contrato de consumo actual', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await whatsapp.sendSessionFlow({
      whatsapp_provider: 'meta',
      meta_phone_id: 'phone-a',
      meta_token: 'meta-token-a',
    }, '593990000001', {
      flowId: 'flow-a',
      flowToken: 'session-a',
      body: 'Arma tu pedido.',
      cta: 'Pedir',
      screen: 'START',
    })

    expect(post).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/phone-a/messages',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '593990000001',
        type: 'interactive',
        interactive: {
          type: 'flow',
          body: { text: 'Arma tu pedido.' },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_action: 'navigate',
              flow_token: 'session-a',
              flow_id: 'flow-a',
              flow_cta: 'Pedir',
              flow_action_payload: {
                screen: 'START',
                data: {},
              },
            },
          },
        },
      },
      {
        headers: {
          Authorization: 'Bearer meta-token-a',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    )
  })

  it('envía la plantilla Flow por Meta con índice de botón como string', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await whatsapp.sendFlowTemplate({
      whatsapp_provider: 'meta',
      meta_phone_id: 'phone-a',
      meta_token: 'meta-token-a',
    }, '593990000001', {
      templateName: 'retomar_pedido',
      languageCode: 'es',
      flowToken: 'session-b',
      flowActionData: { draft_id: 'draft-b' },
    })

    expect(post).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/phone-a/messages',
      {
        messaging_product: 'whatsapp',
        to: '593990000001',
        type: 'template',
        template: {
          name: 'retomar_pedido',
          language: { code: 'es' },
          components: [{
            type: 'button',
            sub_type: 'flow',
            index: '0',
            parameters: [{
              type: 'action',
              action: {
                flow_token: 'session-b',
                flow_action_data: { draft_id: 'draft-b' },
              },
            }],
          }],
        },
      },
      {
        headers: {
          Authorization: 'Bearer meta-token-a',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    )
  })

  it('delega ambos transportes a YCloud con las credenciales del negocio', async () => {
    const sendSessionFlow = vi.spyOn(ycloud, 'sendSessionFlow').mockResolvedValue(undefined)
    const sendFlowTemplate = vi.spyOn(ycloud, 'sendFlowTemplate').mockResolvedValue(undefined)
    const business = {
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'ycloud-business-key',
      ycloud_number: '+593990000010',
    }
    const sessionLaunch = {
      flowId: 'flow-y',
      flowToken: 'session-y',
      body: 'Arma tu pedido.',
      cta: 'Pedir',
      action: 'data_exchange',
    }
    const templateLaunch = {
      templateName: 'retomar_pedido',
      languageCode: 'es',
      flowToken: 'session-template-y',
    }

    await whatsapp.sendSessionFlow(
      business,
      '+593990000001',
      sessionLaunch,
      'queued',
    )
    await whatsapp.sendFlowTemplate(
      business,
      '+593990000001',
      templateLaunch,
    )

    expect(sendSessionFlow).toHaveBeenCalledWith(
      'ycloud-business-key',
      '+593990000010',
      '+593990000001',
      sessionLaunch,
      false,
    )
    expect(sendFlowTemplate).toHaveBeenCalledWith(
      'ycloud-business-key',
      '+593990000010',
      '+593990000001',
      templateLaunch,
      true,
    )
  })
})
