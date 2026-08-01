import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildLeadFlowJson } = require(
  '../dist/services/whatsapp-flow-json-lead',
)

function formChildren(screen) {
  return screen.layout.children[0].children
}

describe('JSON del WhatsApp Flow de solicitudes', () => {
  it('define el recorrido DETAILS → REVIEW y finaliza con complete', () => {
    const json = buildLeadFlowJson()

    expect(json).toMatchObject({
      version: '7.3',
      data_api_version: '3.0',
      routing_model: {
        LEAD_DETAILS: ['LEAD_REVIEW'],
        LEAD_REVIEW: [],
      },
    })
    expect(json.screens.map(screen => screen.id)).toEqual([
      'LEAD_DETAILS',
      'LEAD_REVIEW',
    ])

    const review = json.screens[1]
    expect(review).toMatchObject({ terminal: true, success: true })
    const footer = review.layout.children.find(child => child.type === 'Footer')
    expect(footer['on-click-action']).toMatchObject({
      name: 'complete',
      payload: {
        flow_token: '${data.flow_token}',
        topic_id: '${data.topic_id}',
      },
    })
  })

  it('exige nombre, tema y detalle; correo y horario son opcionales', () => {
    const details = buildLeadFlowJson().screens[0]
    const fields = new Map(
      formChildren(details)
        .filter(child => child.name)
        .map(child => [child.name, child]),
    )

    expect(fields.get('contact_name')).toMatchObject({
      type: 'TextInput',
      required: true,
      'max-chars': 120,
    })
    expect(fields.get('topic_id')).toMatchObject({
      type: 'Dropdown',
      required: true,
      'data-source': '${data.topics}',
    })
    expect(fields.get('details')).toMatchObject({
      type: 'TextArea',
      required: true,
      'max-length': 1000,
    })
    expect(fields.get('email')).toMatchObject({
      'input-type': 'email',
      required: false,
      'max-chars': 254,
    })
    expect(fields.get('preferred_time')).toMatchObject({
      required: false,
      'max-chars': 120,
    })
  })

  it('no incrusta datos de un tenant y obtiene nombre/temas dinámicamente', () => {
    const json = buildLeadFlowJson()
    const serialized = JSON.stringify(json)

    expect(serialized).toContain('${data.business_name}')
    expect(serialized).toContain('${data.topics}')
    expect(serialized).not.toContain('Monster Pizza')
    expect(serialized).not.toContain('Hostal Vista Andina')
    expect(serialized).not.toContain('business_id')
  })
})
