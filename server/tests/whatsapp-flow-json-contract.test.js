import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildOrderFlowJson } = require('../dist/services/whatsapp-flow-json')
const {
  buildAppointmentFlowJson,
} = require('../dist/services/whatsapp-flow-json-appointment')
const {
  buildLodgingFlowJson,
} = require('../dist/services/whatsapp-flow-json-lodging')
const { buildLeadFlowJson } = require(
  '../dist/services/whatsapp-flow-json-lead',
)

const BUILDERS = {
  order: buildOrderFlowJson,
  appointment: buildAppointmentFlowJson,
  lodging: buildLodgingFlowJson,
  lead: buildLeadFlowJson,
}

const LABEL_LIMITS = {
  TextInput: 20,
  TextArea: 20,
  CheckboxGroup: 30,
  RadioButtonsGroup: 30,
  Dropdown: 30,
  DatePicker: 40,
  Footer: 35,
}

const TEXT_LIMITS = {
  TextHeading: 80,
  TextSubheading: 80,
  TextBody: 4096,
  TextCaption: 4096,
}

function visit(value, path, callback) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, callback))
    return
  }
  if (!value || typeof value !== 'object') return
  callback(value, path)
  for (const [key, child] of Object.entries(value)) {
    visit(child, `${path}.${key}`, callback)
  }
}

function expectValidFlowContract(flow, name) {
  expect(flow.version, `${name}: Flow JSON`).toBe('7.3')
  expect(flow.data_api_version, `${name}: Data API`).toBe('3.0')

  const ids = flow.screens.map(screen => screen.id)
  expect(new Set(ids).size, `${name}: screen IDs únicos`).toBe(ids.length)
  for (const id of ids) {
    expect(id, `${name}: screen ID ${id}`).toMatch(/^[A-Za-z_]+$/)
    expect(id, `${name}: SUCCESS es reservado`).not.toBe('SUCCESS')
  }

  expect(Object.keys(flow.routing_model).sort()).toEqual([...ids].sort())
  for (const [source, targets] of Object.entries(flow.routing_model)) {
    expect(ids, `${name}: origen ${source}`).toContain(source)
    for (const target of targets) {
      expect(ids, `${name}: destino ${source} -> ${target}`).toContain(target)
    }
  }

  for (const screen of flow.screens) {
    if (screen.terminal) {
      let hasFooter = false
      visit(screen.layout, screen.id, (component) => {
        if (component.type === 'Footer') hasFooter = true
      })
      expect(hasFooter, `${name}: terminal ${screen.id} necesita Footer`).toBe(true)
    }
  }

  visit(flow, name, (value, path) => {
    const labelLimit = LABEL_LIMITS[value.type]
    if (labelLimit && typeof value.label === 'string') {
      expect(
        [...value.label].length,
        `${path}.label excede ${labelLimit}: "${value.label}"`,
      ).toBeLessThanOrEqual(labelLimit)
    }

    const textLimit = TEXT_LIMITS[value.type]
    if (textLimit
      && typeof value.text === 'string'
      && !value.text.includes('${')) {
      expect(
        [...value.text].length,
        `${path}.text excede ${textLimit}`,
      ).toBeLessThanOrEqual(textLimit)
    }

    const sources = [
      Array.isArray(value['data-source']) ? value['data-source'] : [],
      Array.isArray(value.__example__) ? value.__example__ : [],
    ].flat()
    const sourceIds = sources.flatMap(option => (
      option && typeof option === 'object' && typeof option.id === 'string'
        ? [option.id]
        : []
    ))
    expect(
      new Set(sourceIds).size,
      `${path}: IDs repetidos en data-source`,
    ).toBe(sourceIds.length)
    for (const option of sources) {
      if (option && typeof option === 'object' && typeof option.title === 'string') {
        expect(
          [...option.title].length,
          `${path}: opción excede 30: "${option.title}"`,
        ).toBeLessThanOrEqual(30)
      }
    }
  })
}

describe('contrato publicable de los WhatsApp Flows', () => {
  for (const [name, build] of Object.entries(BUILDERS)) {
    it(`${name} respeta Flow JSON 7.3 y los límites estructurales`, () => {
      expectValidFlowContract(build(), name)
    })
  }
})
