import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import ycloud from '../dist/integrations/ycloud.js'

const require = createRequire(import.meta.url)
const axios = require('axios')

const API_KEY = 'test-api-key'
const FROM = '+593999000001'
const TO = '+593999000002'
const BASE_URL = 'https://api.ycloud.com/v2'
const REQUEST_HEADERS = {
  'X-API-Key': API_KEY,
  'Content-Type': 'application/json',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WhatsApp Flows mediante YCloud', () => {
  it('envía el Flow de sesión directamente con el contrato oficial', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.sendSessionFlow(API_KEY, FROM, TO, {
      flowId: 'flow-1',
      flowToken: 'session-1',
      header: 'Monster Pizza',
      body: 'Arma tu pedido.',
      footer: 'Confirma al finalizar',
      cta: 'Pedir',
      screen: 'ORDER_TYPE',
      data: { draft_id: 'draft-1' },
    })

    expect(post).toHaveBeenCalledWith(
      `${BASE_URL}/whatsapp/messages/sendDirectly`,
      {
        from: FROM,
        to: TO,
        type: 'interactive',
        interactive: {
          type: 'flow',
          header: { type: 'text', text: 'Monster Pizza' },
          body: { text: 'Arma tu pedido.' },
          footer: { text: 'Confirma al finalizar' },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_action: 'navigate',
              flow_token: 'session-1',
              flow_id: 'flow-1',
              flow_cta: 'Pedir',
              flow_action_payload: {
                screen: 'ORDER_TYPE',
                data: { draft_id: 'draft-1' },
              },
            },
          },
        },
      },
      { headers: REQUEST_HEADERS, timeout: 15000 },
    )
  })

  it('envía una plantilla aprobada con botón Flow fuera de la ventana', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({})

    await ycloud.sendFlowTemplate(API_KEY, FROM, TO, {
      templateName: 'retomar_pedido',
      languageCode: 'es',
      flowToken: 'session-2',
      flowActionData: { draft_id: 'draft-2' },
    })

    expect(post).toHaveBeenCalledWith(
      `${BASE_URL}/whatsapp/messages/sendDirectly`,
      {
        from: FROM,
        to: TO,
        type: 'template',
        template: {
          name: 'retomar_pedido',
          language: { code: 'es' },
          components: [{
            type: 'button',
            sub_type: 'flow',
            index: 0,
            parameters: [{
              type: 'action',
              action: {
                flow_token: 'session-2',
                flow_action_data: { draft_id: 'draft-2' },
              },
            }],
          }],
        },
      },
      { headers: REQUEST_HEADERS, timeout: 15000 },
    )
  })

  it('crea, lista y publica Flows sin efectuar transformaciones opacas', async () => {
    const flowJson = {
      version: '7.2',
      screens: [{
        id: 'START',
        terminal: true,
        success: true,
        data: {},
        layout: { type: 'SingleColumnLayout', children: [] },
      }],
    }
    const post = vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: { id: 'flow/created', success: true } })
      .mockResolvedValueOnce({ data: { success: true } })
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        items: [{
          id: 'flow/created',
          name: 'Pedido pizzería',
          status: 'PUBLISHED',
          categories: ['OTHER'],
        }],
      },
    })

    await expect(ycloud.createFlow(API_KEY, {
      wabaId: 'waba-1',
      name: 'Pedido pizzería',
      categories: ['OTHER'],
      flowJson,
      publish: false,
      endpointUri: 'https://bot.example.com/api/flows/exchange',
    })).resolves.toEqual({ id: 'flow/created', success: true })
    await expect(ycloud.listFlows(API_KEY, 'waba-1')).resolves.toEqual({
      items: [{
        id: 'flow/created',
        name: 'Pedido pizzería',
        status: 'PUBLISHED',
        categories: ['OTHER'],
      }],
    })
    await expect(ycloud.publishFlow(API_KEY, 'flow/created'))
      .resolves.toEqual({ success: true })

    expect(post.mock.calls[0]).toEqual([
      `${BASE_URL}/whatsapp/flows`,
      {
        wabaId: 'waba-1',
        name: 'Pedido pizzería',
        categories: ['OTHER'],
        flowJson: JSON.stringify(flowJson),
        publish: false,
        endpointUri: 'https://bot.example.com/api/flows/exchange',
      },
      { headers: REQUEST_HEADERS, timeout: 15000 },
    ])
    expect(get).toHaveBeenCalledWith(`${BASE_URL}/whatsapp/flows`, {
      params: { wabaId: 'waba-1' },
      headers: REQUEST_HEADERS,
      timeout: 15000,
    })
    expect(post.mock.calls[1]).toEqual([
      `${BASE_URL}/whatsapp/flows/flow%2Fcreated/publish`,
      undefined,
      { headers: REQUEST_HEADERS, timeout: 15000 },
    ])
  })

  it('rechaza configuración insegura o JSON inválido antes de llamar a YCloud', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} })

    await expect(ycloud.createFlow(API_KEY, {
      wabaId: 'waba-1',
      name: 'Pedido',
      categories: ['OTHER'],
      flowJson: '{invalid',
    })).rejects.toThrow(/objeto JSON válido/)

    await expect(ycloud.createFlow(API_KEY, {
      wabaId: 'waba-1',
      name: 'Pedido',
      categories: ['OTHER'],
      endpointUri: 'http://localhost:3000/flow',
    })).rejects.toThrow(/URL HTTPS/)

    expect(post).not.toHaveBeenCalled()
  })
})
