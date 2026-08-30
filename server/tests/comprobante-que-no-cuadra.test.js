import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { crearCuadreDelComprobante } = require('../dist/services/receipt-ingest')
const {
  RESPUESTA_COMPROBANTE, RESPUESTA_COMPROBANTE_CUADRA,
  comprobanteCuadra, esComprobante, esComprobanteQueNoCuadra,
  motivoDelDescuadre, respuestaComprobanteNoCuadra,
  textoDeComprobanteQueNoCuadra, textoDelComprobante,
  textoDelComprobanteQueCuadra,
} = require('../dist/services/payment-proof-inbox')

// ═══════════════════════════════════════════════════════════════════════════
// «¿ES UN PAGO?» Y «¿ES ESTE PAGO?» SON DOS PREGUNTAS
// ═══════════════════════════════════════════════════════════════════════════
//
// Petición del dueño (2026-08-30): que el rechazo por datos que no cuadran sea
// automático, para no estar pendiente de bromas. Aceptada con un límite que él
// aprobó: **el nombre de quien paga NO rechaza**. La gente transfiere desde la
// cuenta de su pareja, de su madre o del negocio, y rechazar por eso tiraría
// pagos buenos — el propio análisis ya había decidido no marcar el beneficiario
// por ese mismo motivo.
//
// Lo que sí corta son las señales CRÍTICAS: el dinero fue a otra cuenta, o es
// menos de lo que cuesta el pedido.

const CUENTA = {
  account_number: '2202980129',
  holder_name: 'Cedeño Chila Nadia Alexandra',
  bank_name: 'Banco Pichincha',
}

const armar = (cuenta = CUENTA) => crearCuadreDelComprobante({
  database: { getBusinessBankAccount: vi.fn().mockResolvedValue(cuenta) },
  settings: { get: vi.fn().mockResolvedValue(null) },
})

const analisis = (datos) => ({ ok: true, esComprobante: true, datos })

const PAGO_BUENO = {
  bank_name: 'Banco Pichincha',
  amount: 14.09,
  currency: 'USD',
  destination_account: '2202980129',
  beneficiary_name: 'Cedeño Chila Nadia Alexandra',
  transaction_date: '2026-08-30',
  reference_number: '76428463',
}

const PEDIDO = { total: 14.09, createdAt: '2026-08-30T00:00:00Z' }

describe('lo que CORTA es la cuenta y el monto', () => {
  it('el dinero que fue a OTRA cuenta se rechaza solo', async () => {
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, destination_account: '9999999999' }),
      esperado: PEDIDO,
    })
    expect(r.critica).not.toBeNull()
    expect(r.critica.flag_type).toBe('cuenta_incorrecta')
    expect(r.limpio).toBe(false)
  })

  it('pagar MENOS de lo que cuesta se rechaza solo', async () => {
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, amount: 5 }),
      esperado: PEDIDO,
    })
    expect(r.critica?.flag_type).toBe('monto_menor')
  })
})

describe('lo que NO corta, y es deliberado', () => {
  it('que pague OTRA PERSONA no rechaza nada', async () => {
    // El caso real: se paga desde la cuenta de la esposa, del papá o del
    // negocio. Rechazar aquí tiraría pagos buenos todos los días.
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, payer_name: 'Otra Persona Distinta' }),
      esperado: PEDIDO,
    })
    expect(r.critica).toBeNull()
  })

  it('que el beneficiario se escriba distinto tampoco', async () => {
    // El titular legal y el nombre comercial casi nunca coinciden: «Monster
    // Pizza» contra «Juan Pérez Loor». La CUENTA es lo que identifica el
    // destino, y esa sí se comprueba.
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, beneficiary_name: 'MONSTER PIZZA' }),
      esperado: PEDIDO,
    })
    expect(r.critica).toBeNull()
  })

  it('pagar de MÁS no rechaza: quien paga de más no está estafando', async () => {
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, amount: 20 }),
      esperado: PEDIDO,
    })
    expect(r.critica).toBeNull()
  })
})

describe('falla hacia NO cortar, siempre', () => {
  it('sin cuenta bancaria cargada no rechaza a nadie', async () => {
    // Un local que no cargó su cuenta no puede dejar sin pedir a sus clientes.
    const cuadre = armar(null)
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, destination_account: '9999999999' }),
      esperado: PEDIDO,
    })
    expect(r.critica).toBeNull()
  })

  it('con el análisis apagado no rechaza a nadie', async () => {
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: { ok: false, motivo: 'apagado' },
      esperado: PEDIDO,
    })
    expect(r).toEqual({ critica: null, limpio: false })
  })

  it('si la consulta de la cuenta revienta, tampoco', async () => {
    const cuadre = crearCuadreDelComprobante({
      database: { getBusinessBankAccount: vi.fn().mockRejectedValue(new Error('caída')) },
      settings: { get: vi.fn().mockResolvedValue(null) },
    })
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, destination_account: '9999999999' }),
      esperado: PEDIDO,
    })
    expect(r.critica).toBeNull()
  })
})

describe('cuando TODO cuadra', () => {
  it('lo dice, para que el cliente se quede tranquilo', async () => {
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1', analisis: analisis(PAGO_BUENO), esperado: PEDIDO,
    })
    expect(r.critica).toBeNull()
    expect(r.limpio).toBe(true)
  })

  it('una señal MEDIA basta para no prometer que cuadra', async () => {
    // Sin referencia no se rechaza —se adjunta y decide el dueño— pero tampoco
    // se le dice al cliente que sus datos coinciden. Prometer de más es la
    // única forma de que este mensaje haga daño.
    const cuadre = armar()
    const r = await cuadre({
      businessId: 'biz-1',
      analisis: analisis({ ...PAGO_BUENO, reference_number: '' }),
      esperado: PEDIDO,
    })
    expect(r.critica).toBeNull()
    expect(r.limpio).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LOS MARCADORES NO SE PUEDEN CONFUNDIR
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ El error caro de este archivo es decirle «recibimos tu comprobante» a
// quien pagó a otra cuenta: se iría a esperar una comida que nadie va a
// preparar. Los marcadores viajan como texto por la conversación, así que la
// separación entre ellos es lo único que lo impide.

describe('los cuatro marcadores', () => {
  it('el que NO cuadra no se lee como un comprobante aceptado', () => {
    const marca = textoDeComprobanteQueNoCuadra('La cuenta no es la del negocio')
    expect(esComprobanteQueNoCuadra(marca)).toBe(true)
    expect(esComprobante(marca)).toBe(false)
  })

  it('el aceptado no se lee como uno rechazado', () => {
    const marca = textoDelComprobante(75)
    expect(esComprobante(marca)).toBe(true)
    expect(esComprobanteQueNoCuadra(marca)).toBe(false)
    expect(comprobanteCuadra(marca)).toBe(false)
  })

  it('el que cuadra sigue siendo un comprobante aceptado', () => {
    const marca = textoDelComprobanteQueCuadra(75)
    expect(esComprobante(marca)).toBe(true)
    expect(comprobanteCuadra(marca)).toBe(true)
    expect(esComprobanteQueNoCuadra(marca)).toBe(false)
  })

  it('el motivo viaja dentro y llega al cliente', () => {
    const marca = textoDeComprobanteQueNoCuadra('La cuenta de destino NO es la del negocio')
    expect(motivoDelDescuadre(marca)).toContain('NO es la del negocio')
    expect(respuestaComprobanteNoCuadra(motivoDelDescuadre(marca)))
      .toContain('NO es la del negocio')
  })

  it('sin motivo se responde lo genérico, no un texto a medias', () => {
    expect(motivoDelDescuadre(textoDeComprobanteQueNoCuadra())).toBeNull()
    expect(respuestaComprobanteNoCuadra(null)).toMatch(/no corresponde a este pedido/i)
  })
})

describe('los dos acuses', () => {
  it('el que cuadra NO promete que el pago esté confirmado', () => {
    // Regla dura del proyecto: ningún estado del comprobante confirma un pago.
    // Una imagen se puede editar, generar o reutilizar.
    expect(RESPUESTA_COMPROBANTE_CUADRA).toMatch(/coinciden/i)
    expect(RESPUESTA_COMPROBANTE_CUADRA).not.toMatch(/confirmad|acreditad|recibimos el pago/i)
    // Y sigue diciendo que el local lo revisa: la decisión no cambió de dueño.
    expect(RESPUESTA_COMPROBANTE_CUADRA).toMatch(/revisa/i)
  })

  it('el de siempre sigue intacto para cuando no se pudo comparar', () => {
    expect(RESPUESTA_COMPROBANTE).toMatch(/revisando/i)
  })
})
