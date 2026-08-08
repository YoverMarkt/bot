import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  crearNotificadorDePedidos,
  textoPedidoEnPreparacion,
} = require('../dist/services/order-notify')

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO AL CLIENTE CUANDO SU PEDIDO ARRANCA
// ═══════════════════════════════════════════════════════════════════════════
//
// El cliente que pide por la mini app no se entera de nada si cerró el
// navegador —y lo normal es cerrarlo—. Este es el ÚNICO mensaje saliente del
// pedido: desde el 1 de octubre de 2026 Meta cobra cada mensaje de servicio,
// así que avisar en cada estado triplicaría el costo por pedido para repetir
// cosas que ya están en la pantalla de seguimiento.

const NEGOCIO = { id: 'negocio-a', name: 'Monster Pizza' }

const PEDIDO = {
  order_number: 23,
  contact_phone: '593990978367',
  contact_name: 'Yover',
  total: '12.50',
  order_items: [
    { product_name: 'Pizza', variant_name: 'Familiar', quantity: 1 },
    { product_name: 'Coca-Cola', variant_name: null, quantity: 2 },
  ],
}

describe('el texto del aviso', () => {
  it('dice el número, el negocio, qué pidió y cuánto es', () => {
    const texto = textoPedidoEnPreparacion(NEGOCIO, PEDIDO)

    expect(texto).toContain('#23')
    expect(texto).toContain('Monster Pizza')
    expect(texto).toContain('1× Pizza (Familiar)')
    expect(texto).toContain('2× Coca-Cola')
    expect(texto).toContain('$12.50')
  })

  // La variante va pegada al nombre porque «Pizza» y «Pizza Familiar» son
  // cosas distintas, y el cliente comprueba aquí que le entendieron bien.
  it('no inventa un paréntesis vacío cuando no hay variante', () => {
    const texto = textoPedidoEnPreparacion(NEGOCIO, PEDIDO)
    expect(texto).toContain('2× Coca-Cola\n')
    expect(texto).not.toContain('()')
  })

  // Regla inviolable #8: el importe llega tal como lo dejó PostgreSQL. Aquí
  // solo se le da formato — si este archivo sumara algo, sería un segundo
  // motor de dinero.
  it('formatea el total sin recalcular nada', () => {
    expect(textoPedidoEnPreparacion(NEGOCIO, { ...PEDIDO, total: 7 })).toContain('$7.00')
    expect(textoPedidoEnPreparacion(NEGOCIO, { ...PEDIDO, total: '3.5' })).toContain('$3.50')
  })

  it('se aguanta sin líneas y sin total', () => {
    const texto = textoPedidoEnPreparacion(NEGOCIO, { order_number: 9 })
    expect(texto).toContain('#9')
    expect(texto).toContain('Monster Pizza')
    expect(texto).not.toContain('$')
  })
})

describe('a quién se le avisa', () => {
  const montar = (envio = vi.fn().mockResolvedValue(undefined)) => {
    const registrarError = vi.fn().mockResolvedValue(undefined)
    const notificar = crearNotificadorDePedidos({ enviar: envio, registrarError })
    return { notificar, envio, registrarError }
  }

  it('le manda el aviso al teléfono del pedido', async () => {
    const { notificar, envio } = montar()

    await expect(notificar(NEGOCIO, PEDIDO)).resolves.toBe(true)
    expect(envio).toHaveBeenCalledWith(NEGOCIO, '593990978367', expect.stringContaining('#23'))
  })

  // El pedido de mostrador guarda el literal «mostrador» donde iría el
  // teléfono: quien compra en el local está delante del dueño. Mandarle un
  // WhatsApp a ese texto gastaría dinero por un mensaje que no llega.
  it('no le escribe a un pedido de mostrador', async () => {
    const { notificar, envio } = montar()

    await expect(notificar(NEGOCIO, { ...PEDIDO, contact_phone: 'mostrador' })).resolves.toBe(false)
    expect(envio).not.toHaveBeenCalled()
  })

  it('no le escribe a un teléfono que no lo es', async () => {
    const { notificar, envio } = montar()

    for (const contact_phone of ['', '   ', '123', null, undefined]) {
      await expect(notificar(NEGOCIO, { ...PEDIDO, contact_phone })).resolves.toBe(false)
    }
    expect(envio).not.toHaveBeenCalled()
  })

  it('sí le escribe por Telegram, que viaja como tg_<chatId>', async () => {
    const { notificar, envio } = montar()

    await expect(notificar(NEGOCIO, { ...PEDIDO, contact_phone: 'tg_12345' })).resolves.toBe(true)
    expect(envio.mock.calls[0][1]).toBe('tg_12345')
  })
})

describe('cuando el envío falla', () => {
  // El pedido YA está en la cocina cuando esto corre. Si el aviso revienta
  // —fuera de la ventana de 24 h, sin saldo, canal caído— el dueño no puede
  // recibir un error: creería que su pedido no arrancó.
  it('no lanza: el pedido ya avanzó', async () => {
    const envio = vi.fn().mockRejectedValue(new Error('YCloud sin saldo'))
    const registrarError = vi.fn().mockResolvedValue(undefined)
    const notificar = crearNotificadorDePedidos({ enviar: envio, registrarError })

    await expect(notificar(NEGOCIO, PEDIDO)).resolves.toBe(false)
  })

  // Pero tampoco se puede perder en silencio: si el dueño cree que su cliente
  // fue avisado y no lo fue, es peor que no haber avisado nunca.
  it('lo registra con el negocio y el pedido', async () => {
    const envio = vi.fn().mockRejectedValue(new Error('YCloud sin saldo'))
    const registrarError = vi.fn().mockResolvedValue(undefined)
    const notificar = crearNotificadorDePedidos({ enviar: envio, registrarError })

    await notificar(NEGOCIO, PEDIDO)

    expect(registrarError).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'negocio-a',
      category: 'envio',
      context: expect.objectContaining({ pedido: 23 }),
    }))
  })

  it('un fallo al REGISTRAR el fallo tampoco lanza', async () => {
    const envio = vi.fn().mockRejectedValue(new Error('YCloud sin saldo'))
    const registrarError = vi.fn().mockRejectedValue(new Error('registro caído'))
    const notificar = crearNotificadorDePedidos({ enviar: envio, registrarError })

    await expect(notificar(NEGOCIO, PEDIDO)).resolves.toBe(false)
  })
})
