import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  crearBuzonDeComprobantes, esperaComprobante,
} = require('../dist/services/payment-proof-inbox')

// La mayoría de la gente transfiere desde la app de su banco y manda la captura
// POR EL CHAT. Hasta hoy esa foto se perdía para el pedido: el dueño la veía en
// su WhatsApp, el panel nunca activaba «Ver comprobante», y el cliente se
// quedaba atascado en la pantalla de pago.

const PEDIDO_ESPERANDO = {
  id: 'pedido-1',
  order_number: 43,
  status: 'esperando_pago',
  payment_proof_url: null,
  payment_confirmed_at: null,
  // Como lo guarda la mini app: solo dígitos, sin el «+».
  contact_phone: '593990978367',
}

const FOTO = Buffer.from('una captura del banco')

/** Un buzón con todo funcionando, y los espías a mano para comprobarlos. */
const montar = (pedido = PEDIDO_ESPERANDO) => {
  const espias = {
    ultimoPedido: vi.fn().mockResolvedValue(pedido),
    subirPrivado: vi.fn().mockResolvedValue({ url: 'https://nube/x.jpg', public_id: 'x' }),
    adjuntar: vi.fn().mockResolvedValue({ data: {}, error: null }),
    registrarError: vi.fn().mockResolvedValue(undefined),
  }
  return { adjuntar: crearBuzonDeComprobantes(espias), espias }
}

describe('esperaComprobante', () => {
  it('sí cuando el pedido está esperando el pago y no tiene comprobante', () => {
    expect(esperaComprobante(PEDIDO_ESPERANDO)).toBe(true)
  })

  // Quien sube por la app y luego manda la misma foto por el chat no puede
  // pisar el primero: el pedido ya avanzó y el dueño puede estar mirándolo.
  it('no si ya tiene comprobante', () => {
    expect(esperaComprobante({ ...PEDIDO_ESPERANDO, payment_proof_url: 'https://x' })).toBe(false)
  })

  it('no si el dueño ya dio el pago por bueno', () => {
    expect(esperaComprobante({
      ...PEDIDO_ESPERANDO, payment_confirmed_at: '2026-08-12T00:00:00Z',
    })).toBe(false)
  })

  // Una foto sobre un pedido ya entregado no es un comprobante de nada.
  it('no en ningún otro estado', () => {
    for (const status of [
      'pendiente', 'pago_en_revision', 'preparacion', 'en_camino',
      'completado', 'cancelado', 'rechazado', 'expirado',
    ]) {
      expect(esperaComprobante({ ...PEDIDO_ESPERANDO, status }), status).toBe(false)
    }
  })

  it('no si no hay pedido', () => {
    expect(esperaComprobante(null)).toBe(false)
    expect(esperaComprobante({})).toBe(false)
  })
})

describe('adjuntar el comprobante que llegó por el chat', () => {
  it('lo sube en privado y lo engancha al pedido', async () => {
    const { adjuntar, espias } = montar()

    // Llega CON el «+», como lo manda WhatsApp.
    const resultado = await adjuntar('negocio-a', '+593990978367', FOTO)

    expect(resultado).toEqual({ adjuntado: true, orderNumber: 43 })
    expect(espias.subirPrivado).toHaveBeenCalledWith(FOTO, 'negocio-a')
    // La MISMA puerta que usa la mini app: mismo estado, misma alarma, mismo
    // «Ver comprobante» con firma temporal.
    expect(espias.adjuntar).toHaveBeenCalledWith({
      businessId: 'negocio-a',
      orderId: 'pedido-1',
      // ⚠️ El del PEDIDO, SIN el «+». La RPC compara exacto: mandarle el del
      // canal la haría rechazar un comprobante legítimo. Fue el segundo tramo
      // del mismo bug del 2026-08-12.
      contactPhone: '593990978367',
      url: 'https://nube/x.jpg',
      publicId: 'x',
    })
  })

  // ⚠️ Sin pedido esperando pago NO se toca Cloudinary: el negocio no puede
  // pagar almacenamiento por cada foto que le manden sus clientes.
  it('sin pedido esperando pago no sube ni un byte', async () => {
    for (const pedido of [null, { ...PEDIDO_ESPERANDO, status: 'completado' }]) {
      const { adjuntar, espias } = montar(pedido)
      const resultado = await adjuntar('negocio-a', '593999', FOTO)

      expect(resultado.adjuntado).toBe(false)
      expect(espias.subirPrivado).not.toHaveBeenCalled()
      expect(espias.adjuntar).not.toHaveBeenCalled()
    }
  })

  // Esto corre dentro del camino de un mensaje entrante: si Cloudinary está
  // caído, el cliente tiene que recibir su respuesta igual.
  it('un fallo al subir no lanza: se registra y la conversación sigue', async () => {
    const { adjuntar, espias } = montar()
    espias.subirPrivado.mockRejectedValue(new Error('Cloudinary caído'))

    const resultado = await adjuntar('negocio-a', '593999', FOTO)

    expect(resultado.adjuntado).toBe(false)
    expect(espias.registrarError).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'negocio-a',
      category: 'servidor',
    }))
  })

  // Callarlo sería peor que el fallo: el dueño creería tener un comprobante
  // que nunca llegó, y el cliente creería haberlo mandado.
  it('un rechazo de la base también se registra', async () => {
    const { adjuntar, espias } = montar()
    espias.adjuntar.mockResolvedValue({ data: null, error: { message: 'no cuadra' } })

    const resultado = await adjuntar('negocio-a', '593999', FOTO)

    expect(resultado.adjuntado).toBe(false)
    expect(espias.registrarError).toHaveBeenCalled()
  })

  it('ni siquiera un fallo del registro de errores rompe el mensaje', async () => {
    const { adjuntar, espias } = montar()
    espias.subirPrivado.mockRejectedValue(new Error('caído'))
    espias.registrarError.mockRejectedValue(new Error('el registro también'))

    await expect(adjuntar('negocio-a', '593999', FOTO)).resolves.toEqual({ adjuntado: false })
  })
})

// ── Lo que se escribe y lo que se responde ─────────────────────────────────

describe('el texto del comprobante', () => {
  const {
    MARCA_COMPROBANTE, RESPUESTA_COMPROBANTE, esComprobante, textoDelComprobante,
  } = require('../dist/services/payment-proof-inbox')

  // No es un marcador técnico escondido: es lo que el DUEÑO lee en su panel al
  // abrir ese chat, donde antes había una imagen sin explicación.
  it('nombra el pedido, para que el dueño sepa de cuál habla', () => {
    expect(textoDelComprobante(43)).toBe('[el cliente envió su comprobante de pago del pedido #43]')
  })

  it('sin número sigue siendo legible', () => {
    expect(textoDelComprobante(null)).toBe('[el cliente envió su comprobante de pago]')
    expect(textoDelComprobante()).toContain(MARCA_COMPROBANTE)
  })

  it('se reconoce a sí mismo, y no a otros mensajes', () => {
    expect(esComprobante(textoDelComprobante(43))).toBe(true)
    expect(esComprobante(textoDelComprobante(null))).toBe(true)
    expect(esComprobante('[el cliente envió una imagen: NO_IDENTIFICADO]')).toBe(false)
    expect(esComprobante('hola quiero una pizza')).toBe(false)
    expect(esComprobante('')).toBe(false)
  })

  // ⚠️ La respuesta NO lleva el enlace de la tienda. Era el fallo entero: el
  // cliente mandaba su captura y el bot le contestaba «aquí tienes el menú»,
  // como si no hubiera pedido ni pagado.
  it('la respuesta no le manda el menú a quien acaba de pagar', () => {
    expect(RESPUESTA_COMPROBANTE).toContain('Recibimos tu comprobante')
    expect(RESPUESTA_COMPROBANTE.toLowerCase()).not.toContain('menú')
    expect(RESPUESTA_COMPROBANTE).not.toContain('http')
  })
})
