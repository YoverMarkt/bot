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
  // ⚠️ Desde el 2026-08-21 la búsqueda es por CLIENTE y devuelve una lista: el
  // local sale del pedido, no del número al que llegó la foto.
  const pedidos = pedido ? [{ ...pedido, business_id: 'negocio-1', businesses: { name: 'El Puerto' } }] : []
  const espias = {
    pedidosEsperando: vi.fn().mockResolvedValue(
      pedidos.filter(p => esperaComprobante(p)),
    ),
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
    // ⚠️ El local sale del PEDIDO ('negocio-1'), no del canal por el que llegó
    // la foto ('negocio-a'). Con un solo número para todo el marketplace, ese
    // canal no dice de quién es el pago.
    expect(espias.subirPrivado).toHaveBeenCalledWith(FOTO, 'negocio-1')
    // La MISMA puerta que usa la mini app: mismo estado, misma alarma, mismo
    // «Ver comprobante» con firma temporal.
    expect(espias.adjuntar).toHaveBeenCalledWith({
      businessId: 'negocio-1',
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

// ═══════════════════════════════════════════════════════════════════════════
// CUANDO NO SE SABE DE QUÉ LOCAL ES EL PAGO
//
// Con un solo número para todo el marketplace, el teléfono ya no dice de quién
// es un comprobante. Y el mismo cliente puede tener pedidos abiertos en dos
// locales a la vez. Adjuntarlo al más reciente sería dar por cobrado a uno lo
// que pagó el otro: el dueño equivocado prepara sin haber cobrado, y el cliente
// que sí pagó sigue viendo la pantalla de espera.
// ═══════════════════════════════════════════════════════════════════════════

const dosLocales = () => {
  const espias = {
    pedidosEsperando: vi.fn().mockResolvedValue([
      {
        id: 'pedido-puerto', business_id: 'negocio-puerto', order_number: 43,
        contact_phone: '593990978367', businesses: { name: 'Cevichería El Puerto' },
      },
      {
        id: 'pedido-pizza', business_id: 'negocio-pizza', order_number: 12,
        contact_phone: '593990978367', businesses: { name: 'Pizza Uno' },
      },
    ]),
    subirPrivado: vi.fn().mockResolvedValue({ url: 'https://nube/x.jpg', public_id: 'x' }),
    adjuntar: vi.fn().mockResolvedValue({ data: {}, error: null }),
    registrarError: vi.fn().mockResolvedValue(undefined),
  }
  return { adjuntar: crearBuzonDeComprobantes(espias), espias }
}

describe('un comprobante con pagos pendientes en dos locales', () => {
  it('NO lo adjunta a ninguno ni sube la foto', async () => {
    const { adjuntar, espias } = dosLocales()

    const resultado = await adjuntar('negocio-a', '+593990978367', FOTO)

    expect(resultado.adjuntado).toBe(false)
    // Ni un byte a Cloudinary hasta saber de quién es el pago: se cobraría
    // almacenamiento por una foto que puede acabar en otro local.
    expect(espias.subirPrivado).not.toHaveBeenCalled()
    expect(espias.adjuntar).not.toHaveBeenCalled()
  })

  it('devuelve los locales para poder preguntar cuál es', async () => {
    const { adjuntar } = dosLocales()

    const resultado = await adjuntar('negocio-a', '+593990978367', FOTO)

    expect(resultado.ambiguos).toEqual([
      { orderId: 'pedido-puerto', orderNumber: 43, businessName: 'Cevichería El Puerto' },
      { orderId: 'pedido-pizza', orderNumber: 12, businessName: 'Pizza Uno' },
    ])
  })

  it('la pregunta nombra los locales y no pide datos técnicos', async () => {
    const { preguntaDeQueLocal } = require('../dist/services/payment-proof-inbox')
    const texto = preguntaDeQueLocal([
      { orderId: 'a', orderNumber: 43, businessName: 'Cevichería El Puerto' },
      { orderId: 'b', orderNumber: null, businessName: 'Pizza Uno' },
    ])

    expect(texto).toContain('Cevichería El Puerto')
    expect(texto).toContain('#43')
    expect(texto).toContain('Pizza Uno')
    // Sin número de pedido no se escribe un «#» huérfano.
    expect(texto).not.toMatch(/Pizza Uno\* \(pedido #\)/)
    // Nada de ids internos ni jerga: lo lee un cliente.
    expect(texto).not.toMatch(/business_id|order_id|pedido-/)
  })

  it('el marcador viaja con los nombres y se reconoce', async () => {
    const {
      textoDelComprobanteAmbiguo, esComprobanteAmbiguo, esComprobante,
    } = require('../dist/services/payment-proof-inbox')
    const marca = textoDelComprobanteAmbiguo([
      { orderId: 'a', orderNumber: 43, businessName: 'Cevichería El Puerto' },
      { orderId: 'b', orderNumber: 12, businessName: 'Pizza Uno' },
    ])

    expect(esComprobanteAmbiguo(marca)).toBe(true)
    expect(marca).toContain('Cevichería El Puerto / Pizza Uno')
    // No puede confundirse con el comprobante que SÍ se adjuntó: la respuesta
    // es distinta y mezclarlas le diría al cliente que su pago quedó registrado.
    expect(esComprobante(marca)).toBe(false)
    expect(esComprobanteAmbiguo('[foto]')).toBe(false)
  })
})
