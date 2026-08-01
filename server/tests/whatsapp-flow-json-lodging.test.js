import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildLodgingFlowJson,
} = require('../dist/services/whatsapp-flow-json-lodging')

describe('JSON publicable del WhatsApp Flow de hospedaje', () => {
  it('recorre fechas, huéspedes, opciones y revisión con data_exchange', () => {
    const flow = buildLodgingFlowJson()

    expect(flow.version).toBe('7.3')
    expect(flow.data_api_version).toBe('3.0')
    expect(flow.screens.map(screen => screen.id)).toEqual([
      'LODGING_DATES',
      'LODGING_GUESTS',
      'LODGING_OPTIONS',
      'LODGING_DETAILS',
      'LODGING_REVIEW',
    ])

    const dates = flow.screens[0]
    const datePickers = dates.layout.children[0].children
      .filter(component => component.type === 'DatePicker')
    expect(datePickers.map(component => component.name)).toEqual([
      'check_in',
      'check_out',
    ])
    expect(datePickers.every(component => (
      component['min-date'] === '${data.min_date}'
      && component['max-date'] === '${data.max_date}'
    ))).toBe(true)

    const serialized = JSON.stringify(flow)
    expect(serialized).not.toContain('"unit_price"')
    expect(serialized).not.toContain('"room_price"')
    expect(serialized).not.toContain('"business_id"')
  })

  it('conserva una habitación elegida sin mostrar otro selector', () => {
    const flow = buildLodgingFlowJson()
    const details = flow.screens.find(
      screen => screen.id === 'LODGING_DETAILS',
    )
    const components = details.layout.children[0].children
    const footer = components.find(component => component.type === 'Footer')

    expect(components.some(component => component.type === 'Dropdown'))
      .toBe(false)
    expect(footer['on-click-action']).toMatchObject({
      name: 'data_exchange',
      payload: {
        intent: 'review_lodging',
        room_type_id: '${data.room_type_id}',
      },
    })
    expect(flow.routing_model.LODGING_GUESTS)
      .toContain('LODGING_DETAILS')
  })

  it('envía al webhook terminal únicamente el token opaco', () => {
    const flow = buildLodgingFlowJson()
    const review = flow.screens.find(screen => screen.id === 'LODGING_REVIEW')
    const footer = review.layout.children.find(
      component => component.type === 'Footer',
    )

    expect(review).toMatchObject({ terminal: true, success: true })
    expect(footer['on-click-action']).toEqual({
      name: 'complete',
      payload: {
        flow_token: '${data.flow_token}',
      },
    })
    expect(Object.keys(footer['on-click-action'].payload)).toEqual([
      'flow_token',
    ])
  })
})
