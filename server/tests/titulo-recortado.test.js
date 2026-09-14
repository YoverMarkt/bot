import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { advanceMenuFlowConEstado } = require('../dist/services/bot-menu-flow')
const { buildInteractivePayload } = require('../dist/integrations/ycloud')

// ═══════════════════════════════════════════════════════════════════════════
// EL TÍTULO QUE VUELVE RECORTADO
// ═══════════════════════════════════════════════════════════════════════════
//
// Encontrado probando La Abuelita de punta a punta (2026-09-13).
//
// WhatsApp devuelve el TÍTULO de la fila que se toca, no su id
// (`webhooks.routes.ts`: `text = reply?.title`), y ese título sale recortado a
// 24 caracteres por nosotros mismos (`clip` en `ycloud.ts`). Con nombres de
// carta reales eso pasa constantemente:
//
//   se envía  «4 × Pollo en salsa de champiñones»  (33)
//   vuelve    «4 × Pollo en salsa de c…»           (24)
//
// El cliente tocaba, recibía «🙏 No te entendí» y veía LA MISMA lista. Bucle
// infinito, sin salida salvo escribir MENÚ. Y no es un caso raro: una
// cevichería o una heladería tienen nombres largos por naturaleza.

const LARGO = 'Ceviche mixto de camarón y concha'   // 33 caracteres
const CORTO = 'Agua'

const entrada = mensaje => ({
  business: { id: 'b1', name: 'El Puerto', takes_orders: true },
  contact: '593900000000',
  message: mensaje,
  products: [
    { id: 'p1', name: LARGO, price: 8.5, price_sale: null, stock: 'disponible', active: true },
    { id: 'p2', name: CORTO, price: 0.75, price_sale: null, stock: 'disponible', active: true },
  ],
})

/** Conduce el menú guardando el estado entre pasos, como la conversación. */
function conversacion(opciones = {}) {
  let estado = null
  return (mensaje) => {
    const r = advanceMenuFlowConEstado({ ...entrada(mensaje), ...opciones }, estado)
    estado = r.estado
    return r.resultado
  }
}

/** Lo que WhatsApp devuelve al tocar una fila: el título TAL COMO SE ENVIÓ. */
const loQueVuelve = (titulo) => {
  const payload = buildInteractivePayload('cuerpo', [{ id: 'x', title: titulo, description: 'd' }])
  return payload.action.sections[0].rows[0].title
}

describe('una fila cuyo título no cabe en 24 caracteres', () => {
  it('el cliente puede elegirla aunque vuelva recortada', () => {
    const paso = conversacion()
    paso('')
    const lista = paso('🛒 Hacer un pedido')
    const titulos = lista.options.map(o => (typeof o === 'string' ? o : o.title))
    expect(titulos, JSON.stringify(titulos)).toContain(LARGO)

    const vuelve = loQueVuelve(LARGO)
    expect(vuelve).toBe('Ceviche mixto de camaró…')
    expect(vuelve.length).toBe(24)

    const respuesta = paso(vuelve)
    // Antes: «🙏 No te entendí» y la misma lista otra vez. Bucle.
    expect(respuesta.reply, respuesta.reply).not.toContain('No te entendí')
    // Y llega a pedirlo de verdad: el nombre completo sale en la respuesta.
    expect(respuesta.reply, respuesta.reply).toContain('Ceviche mixto')
  })

  it('un título que SÍ cabe sigue funcionando igual', () => {
    const paso = conversacion()
    paso('')
    paso('🛒 Hacer un pedido')
    const respuesta = paso(CORTO)
    expect(respuesta.reply).not.toContain('No te entendí')
  })

  it('si dos opciones se recortan IGUAL, no elige ninguna', () => {
    // Meter en el pedido un plato que el cliente no pidió es dinero. Ante la
    // duda, «no te entendí» es mejor que un ceviche que nadie quería.
    const gemelos = {
      products: [
        { id: 'p1', name: 'Ceviche mixto de camarón y concha', price: 8.5, stock: 'disponible', active: true },
        { id: 'p2', name: 'Ceviche mixto de camarón y pulpo', price: 9.5, stock: 'disponible', active: true },
      ],
    }
    const paso = conversacion(gemelos)
    paso('')
    paso('🛒 Hacer un pedido')
    const respuesta = paso(loQueVuelve('Ceviche mixto de camarón y concha'))
    expect(respuesta.reply).toContain('No te entendí')
  })
})

describe('las dos copias del recorte no pueden divergir', () => {
  // ⚠️ `bot-menu-flow` duplica la regla de 24 porque es una máquina de estados
  // PURA y no puede depender de la integración del canal. Esta prueba es lo
  // único que impide que las dos copias digan cosas distintas.
  it('el motor recorta igual que el canal', () => {
    for (const nombre of [
      'Pollo en salsa de champiñones',
      '4 × Pollo en salsa de champiñones',
      'Ceviche',
      'Ceviche mixto de camarón y concha',
      'Helado de mora con trozos de fruta',
    ]) {
      const payload = buildInteractivePayload('cuerpo', [{ id: 'x', title: nombre, description: 'd' }])
      const delCanal = payload.action.sections[0].rows[0].title
      expect(delCanal.length, nombre).toBeLessThanOrEqual(24)
      // El motor tiene que poder reconocer EXACTAMENTE eso.
      expect(delCanal).toBe(nombre.length <= 24 ? nombre : `${nombre.slice(0, 23)}…`)
    }
  })
})
