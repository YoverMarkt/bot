import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildInteractivePayload } = require('../dist/integrations/ycloud')

describe('mensajes interactivos de WhatsApp', () => {
  it('usa botones cuando hay 3 opciones simples o menos', () => {
    const payload = buildInteractivePayload('¿Confirmamos?', [
      { id: '1', title: '✅ Confirmar pedido' },
      { id: '2', title: '🗑️ Vaciar carrito' },
    ])

    expect(payload.type).toBe('button')
    expect(payload.action.buttons).toHaveLength(2)
    // El id es el NÚMERO de la opción: el menú ya entiende números, así que
    // la respuesta no depende del título (que WhatsApp trunca)
    expect(payload.action.buttons[0].reply).toEqual({ id: '1', title: '✅ Confirmar pedido' })
  })

  it('usa lista cuando hay más de 3 opciones o alguna trae descripción', () => {
    const conDescripcion = buildInteractivePayload('Habitaciones', [
      { id: '1', title: 'Matrimonial', description: '$35.00/noche' },
      { id: '2', title: 'Familiar' },
    ])
    expect(conDescripcion.type).toBe('list')

    const muchas = buildInteractivePayload('Elige', [
      { id: '1', title: 'A' }, { id: '2', title: 'B' },
      { id: '3', title: 'C' }, { id: '4', title: 'D' },
    ])
    expect(muchas.type).toBe('list')
    expect(muchas.action.sections[0].rows).toHaveLength(4)
  })

  it('respeta los topes de WhatsApp: 10 filas y títulos/descripciones cortos', () => {
    const options = Array.from({ length: 15 }, (_, index) => ({
      id: String(index + 1),
      title: `Habitación con un nombre larguísimo número ${index}`,
      description: 'Una descripción muy larga que supera con creces los setenta y dos caracteres permitidos por WhatsApp para la fila',
    }))
    const payload = buildInteractivePayload('x'.repeat(2000), options)
    const rows = payload.action.sections[0].rows

    expect(rows).toHaveLength(10)
    for (const row of rows) {
      expect(row.title.length).toBeLessThanOrEqual(24)
      expect(row.description.length).toBeLessThanOrEqual(72)
    }
    expect(payload.body.text.length).toBeLessThanOrEqual(1024)
  })

  it('no arma nada sin opciones (el llamador cae a texto)', () => {
    expect(buildInteractivePayload('Hola', [])).toBeNull()
  })
})
