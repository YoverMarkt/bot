import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

// Se carga el COMPILADO (`dist`), como el resto de las pruebas del servidor:
// es exactamente el código que corre en producción.
const require_ = createRequire(import.meta.url)
const {
  crearAvisoDeComprobante,
  textoPideComprobante,
} = require_('../dist/services/payment-request-notice.js')

// ── EL AVISO QUE CIERRA EL CICLO MINI APP → WHATSAPP ───────────────────────
//
// Quien pide por la mini app está en un navegador: a su WhatsApp no le llega
// nada, y el comprobante tiene UNA sola vía desde el 2026-08-12, que es el
// chat. Sin este mensaje, cierra la pestaña para ir al banco y vuelve sin
// ninguna conversación a la que responder con la foto.
//
// ⚠️ Cada mensaje se PAGA (Meta los cobra desde octubre de 2026), así que lo
// que se fija aquí no es estética: es cuántos salen y en qué casos.

const PEDIDO = {
  id: 'o1',
  order_number: 42,
  status: 'esperando_pago',
  contact_phone: '593999111222',
  total: 10.3,
  currency: 'USD',
}

const NEGOCIO = { id: 'b1', name: 'Monster Pizza' }

const armar = (ajustes = {}) => {
  const enviar = ajustes.enviar || vi.fn().mockResolvedValue(undefined)
  const completeOutboxEvent = vi.fn().mockResolvedValue(undefined)
  const enqueueOutboxEvent = ajustes.enqueueOutboxEvent
    || vi.fn().mockResolvedValue({ id: 'ev1' })
  const claimOrderNotification = ajustes.claimOrderNotification
    || vi.fn().mockResolvedValue(ajustes.pedido === undefined ? PEDIDO : ajustes.pedido)
  const avisar = crearAvisoDeComprobante({
    claimOrderNotification,
    getBusinessById: ajustes.getBusinessById || vi.fn().mockResolvedValue(NEGOCIO),
    enqueueOutboxEvent,
    completeOutboxEvent,
    enviar,
  })
  return { avisar, enviar, claimOrderNotification, enqueueOutboxEvent, completeOutboxEvent }
}

describe('el aviso «manda tu comprobante»', () => {
  it('se manda cuando el pedido nace esperando pago', async () => {
    const { avisar, enviar } = armar()
    await expect(avisar('b1', 'o1')).resolves.toBe(true)
    expect(enviar).toHaveBeenCalledTimes(1)
    const [negocio, telefono, texto] = enviar.mock.calls[0]
    expect(negocio.id).toBe('b1')
    expect(telefono).toBe('593999111222')
    expect(texto).toContain('#42')
    expect(texto).toContain('Monster Pizza')
  })

  // ⚠️ El reclamo es lo único que impide pagar dos veces por lo mismo. Un
  // pedido repetido con la misma `idempotency_key` devuelve el MISMO pedido y
  // vuelve a recorrer la ruta entera.
  it('NO se manda dos veces: sin reclamo, no hay mensaje', async () => {
    const { avisar, enviar } = armar({
      claimOrderNotification: vi.fn().mockResolvedValue(null),
    })
    await expect(avisar('b1', 'o1')).resolves.toBe(false)
    expect(enviar).not.toHaveBeenCalled()
  })

  // Un pedido en efectivo no debe recibir una petición de transferencia. El
  // reclamo no comprueba el estado —su trabajo es otro—, así que se comprueba
  // aquí: si no, bastaría un fallo de quien llama para pedirle a alguien una
  // transferencia que nadie le pidió.
  it('NO se manda si el pedido no espera pago', async () => {
    for (const status of ['pendiente', 'preparacion', 'completado', 'cancelado']) {
      const { avisar, enviar } = armar({ pedido: { ...PEDIDO, status } })
      await expect(avisar('b1', 'o1')).resolves.toBe(false)
      expect(enviar).not.toHaveBeenCalled()
    }
  })

  // El pedido de mostrador lo teclea el dueño con la persona delante: no hay
  // a quién escribirle.
  it('NO se manda a un pedido de mostrador ni sin teléfono', async () => {
    for (const contact_phone of ['mostrador', '', '   ', null]) {
      const { avisar, enviar } = armar({ pedido: { ...PEDIDO, contact_phone } })
      await expect(avisar('b1', 'o1')).resolves.toBe(false)
      expect(enviar).not.toHaveBeenCalled()
    }
  })

  // ⚠️ NUNCA lanza. El pedido ya está creado: un error aquí le haría creer al
  // cliente que su pedido no entró — y volvería a pedirlo, que es justo el
  // duplicado que toda esta arquitectura evita.
  it('un fallo del canal no rompe nada y no lanza', async () => {
    const { avisar } = armar({
      enviar: vi.fn().mockRejectedValue(new Error('sin saldo en YCloud')),
    })
    await expect(avisar('b1', 'o1')).resolves.toBe(false)
  })

  it('un fallo de la base tampoco lanza', async () => {
    const { avisar } = armar({
      claimOrderNotification: vi.fn().mockRejectedValue(new Error('base caída')),
    })
    await expect(avisar('b1', 'o1')).resolves.toBe(false)
  })

  // Se encola ANTES de enviar: si el proceso muriera entre el reclamo y el
  // envío, ese aviso no volvería a intentarse nunca.
  it('encola antes de enviar y cierra el evento al salir', async () => {
    const orden = []
    const { avisar } = armar({
      enqueueOutboxEvent: vi.fn(async () => { orden.push('encolar'); return { id: 'ev1' } }),
      enviar: vi.fn(async () => { orden.push('enviar') }),
    })
    await avisar('b1', 'o1')
    expect(orden).toEqual(['encolar', 'enviar'])
  })

  // Encolar no puede impedir el aviso: si la cola falla, se envía igual y
  // simplemente no habrá reintento.
  it('si la cola falla, el mensaje sale igual', async () => {
    const { avisar, enviar } = armar({
      enqueueOutboxEvent: vi.fn().mockRejectedValue(new Error('cola caída')),
    })
    await expect(avisar('b1', 'o1')).resolves.toBe(true)
    expect(enviar).toHaveBeenCalledTimes(1)
  })
})

describe('el texto del aviso', () => {
  it('dice el local, el número y el importe', () => {
    const texto = textoPideComprobante({
      negocio: 'Monster Pizza', orderNumber: 42, total: 10.3, moneda: 'USD',
    })
    expect(texto).toContain('Monster Pizza')
    expect(texto).toContain('#42')
    expect(texto).toContain('$10.30')
  })

  // ⚠️ «responde a este mensaje», NO un número que copiar: el cliente ya está
  // en la conversación correcta, y darle el +593… lo mandaría a abrir un chat
  // nuevo con el mismo destinatario.
  it('pide responder AHÍ, sin dar ningún número', () => {
    const texto = textoPideComprobante({ negocio: 'X', orderNumber: 1, total: 5 })
    expect(texto.toLowerCase()).toContain('responde a este mensaje')
    expect(texto).not.toMatch(/\+?593\d{6,}/)
  })

  // Un pedido sin número o sin total es raro pero existe, y el mensaje tiene
  // que leerse bien igual — nada de «pedido #null» ni «por $NaN».
  it('sin número ni total, no escribe ni «#» ni un importe roto', () => {
    for (const vacio of [null, undefined, 0, '', 'abc']) {
      const texto = textoPideComprobante({ negocio: 'X', orderNumber: vacio, total: vacio })
      expect(texto).not.toContain('#')
      expect(texto).not.toContain('NaN')
      expect(texto).not.toContain('undefined')
      expect(texto).not.toContain('null')
    }
  })
})
