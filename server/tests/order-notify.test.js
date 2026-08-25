import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  crearNotificadorDePedidos,
  textoDelAviso,
  seAvisa,
  HITOS_QUE_SE_AVISAN,
} = require('../dist/services/order-notify')

// ═══════════════════════════════════════════════════════════════════════════
// LOS AVISOS AL CLIENTE MIENTRAS SU PEDIDO AVANZA
// ═══════════════════════════════════════════════════════════════════════════
//
// El cliente que pide por la mini app no se entera de nada si cerró el
// navegador —y lo normal es cerrarlo—. Se le avisa en los momentos en que
// mira el teléfono: cuando su pedido arranca, cuando sale (o queda listo para
// retirar) y cuando se entrega.
//
// ⚠️ Cada hito es un mensaje, y desde el 1 de octubre de 2026 Meta cobra cada
// mensaje de servicio. Se empezó con uno solo por ese costo; el dueño decidió
// los tres el 2026-08-08 sabiendo lo que valen. Por eso la lista de hitos
// tiene su propia prueba: añadir uno multiplica el gasto de todos los
// negocios del SaaS, y no puede colarse sin que alguien lo decida.

const NEGOCIO = { id: 'negocio-a', name: 'Monster Pizza' }

const PEDIDO = {
  order_number: 23,
  contact_phone: '593990978367',
  contact_name: 'Yover',
  total: '12.50',
  order_items: [
    {
      product_name: 'Pizza',
      variant_name: 'Familiar',
      quantity: 1,
      order_item_options: [
        { option_group_name: 'Masa', option_name: 'Tradicional', quantity: 1 },
        { option_group_name: 'Sabor', option_name: 'Criolla', quantity: 1 },
        { option_group_name: 'Sabor', option_name: 'Monster', quantity: 1 },
        { option_group_name: 'Retira ingredientes', option_name: 'Sin ají', quantity: 1 },
      ],
    },
    { product_name: 'Coca-Cola', variant_name: null, quantity: 2 },
  ],
}

describe('qué estados se avisan', () => {
  // Esta lista decide CUÁNTO cuesta cada pedido en mensajes. Añadir un hito
  // multiplica el gasto de todos los negocios del SaaS, así que el número
  // está aquí escrito a propósito: que cambiarlo obligue a tocar la prueba.
  // Eran cuatro; son SEIS desde el 2026-08-13, cuando el dueño decidió avisar
  // también los dos finales que dejan al cliente esperando de balde. Este test
  // no impide que la lista crezca: impide que crezca sin que alguien lo decida
  // y lo escriba, porque cada hito es dinero en todos los negocios del SaaS.
  it('son siete, y ni uno más sin decidirlo', () => {
    expect([...HITOS_QUE_SE_AVISAN]).toEqual([
      'preparacion', 'en_camino', 'listo_para_retiro', 'completado',
      'cancelado', 'rechazado', 'expirado',
    ])
  })

  // `aceptado` y `confirmado` no le dicen nada al cliente que no diga «en
  // preparación»; `esperando_pago` y `pago_en_revision` son cosas que él mismo
  // acaba de hacer. Pagar por contárselas sería pagar por ruido.
  it('los estados intermedios no gastan un mensaje', () => {
    for (const status of [
      'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado',
      'aceptado',
    ]) {
      expect(seAvisa(status), `${status} no debería avisarse`).toBe(false)
      expect(textoDelAviso(NEGOCIO, PEDIDO, status)).toBeNull()
    }
  })

  // ⚠️ Esta prueba decía lo CONTRARIO hasta el 2026-08-28: «expirado no avisa,
  // hoy nadie lo escribe». Ya lo escribe `services/order-expiry.ts`, y el
  // riesgo que la nota temía —dispararse sobre cien pedidos de golpe— no se
  // conjura prohibiéndolo sino con frenos que sí se pueden comprobar: tope de
  // 20 por tanda, ventana superior de 24 h e interruptor por negocio. Están
  // en `pedidos-que-caducan.test.js` y en `verificar-esquema.sql`.
  //
  // Y no es un gasto nuevo: hoy el dueño cancelaba esos pedidos a mano, y
  // `cancelado` ya avisaba.
  it('expirado avisa, y su texto no suena a reproche', () => {
    expect(seAvisa('expirado')).toBe(true)
    const texto = textoDelAviso(NEGOCIO, PEDIDO, 'expirado')
    expect(texto).toMatch(/comprobante/i)
    // Se cuenta DISTINTO de `cancelado`: el cliente no hizo nada malo, se le
    // pasó el tiempo, y lo que se quiere es que vuelva a pedir.
    expect(texto).not.toBe(textoDelAviso(NEGOCIO, PEDIDO, 'cancelado'))
  })
})

// El cliente esperando algo que no va a llegar es el que no vuelve a pedir.
describe('el aviso de cancelación', () => {
  it('cancelado y rechazado dicen lo MISMO', () => {
    const cancelado = textoDelAviso(NEGOCIO, PEDIDO, 'cancelado')
    const rechazado = textoDelAviso(NEGOCIO, PEDIDO, 'rechazado')
    // Para el cliente son la misma noticia. La diferencia entre «lo cancelé» y
    // «no lo acepté» es de gestión interna, y contársela solo le haría
    // preguntarse qué hizo mal.
    expect(cancelado).toBe(rechazado)
    expect(cancelado).toContain('fue cancelado')
  })

  it('da el teléfono del local, que es lo único útil en ese momento', () => {
    const texto = textoDelAviso({ ...NEGOCIO, phone: '+593991716574' }, PEDIDO, 'cancelado')
    expect(texto).toContain('+593991716574')
    expect(texto).toContain('llámalos')
  })

  it('sin teléfono cargado no deja la frase coja', () => {
    const texto = textoDelAviso({ ...NEGOCIO, phone: null }, PEDIDO, 'cancelado')
    expect(texto).not.toContain('llámalos al')
    expect(texto).toContain('escríbeles por aquí')
  })

  // No hay ningún campo donde el dueño escriba el motivo, y uno inventado es
  // peor que ninguno.
  it('no inventa un motivo', () => {
    const texto = textoDelAviso(NEGOCIO, PEDIDO, 'cancelado')
    expect(texto).not.toMatch(/porque|motivo|falta de|sin stock/i)
  })

  // El detalle de lo pedido va solo en el aviso de preparación: repetirlo aquí
  // sería recitarle lo que no va a comer.
  it('no repite el detalle del pedido', () => {
    const texto = textoDelAviso(NEGOCIO, PEDIDO, 'cancelado')
    // Ojo con comprobar el nombre de un producto: el negocio se llama «Monster
    // Pizza», así que buscar «Pizza» da un falso positivo. Lo que distingue al
    // detalle son sus viñetas y el total.
    expect(texto).not.toContain('•')
    expect(texto).not.toContain('Total:')
  })
})

describe('el texto de cada aviso', () => {
  it('en preparación dice el número, el negocio, qué pidió y cuánto es', () => {
    const texto = textoDelAviso(NEGOCIO, PEDIDO, 'preparacion')

    expect(texto).toContain('#23')
    expect(texto).toContain('Monster Pizza')
    expect(texto).toContain('1× Pizza (Familiar)')
    expect(texto).toContain('2× Coca-Cola')
    expect(texto).toContain('$12.50')
  })

  // Antes decía «1× Pizza (Familiar)» y se acababa ahí: el cliente no podía
  // comprobar nada, que es justo para lo que sirve este mensaje. Meta cobra por
  // MENSAJE, no por carácter, así que contarlo entero no cuesta un centavo más.
  it('cuenta lo que el cliente eligió, agrupado y entero', () => {
    const texto = textoDelAviso(NEGOCIO, PEDIDO, 'preparacion')

    expect(texto).toContain('Masa: Tradicional')
    // La mitad y mitad se lee como lo que es: dos sabores de una pizza.
    expect(texto).toContain('Sabor: Criolla, Monster')
    // Y un retiro se distingue de un añadido, que en la lista plana no se podía.
    expect(texto).toContain('Retira ingredientes: Sin ají')
  })

  // En un pedido de tres platos, sin sangría no se sabe de cuál es cada cosa.
  it('el detalle va sangrado bajo su producto', () => {
    const lineas = textoDelAviso(NEGOCIO, PEDIDO, 'preparacion').split('\n')
    const masa = lineas.find(linea => linea.includes('Masa:'))
    expect(masa.startsWith('   ')).toBe(true)
    expect(lineas.find(linea => linea.includes('1× Pizza')).startsWith('•')).toBe(true)
  })

  // Los pedidos anteriores al motor de opciones no tienen grupos, solo la
  // lista suelta. Tienen que seguir contándose, aunque se cuenten peor.
  it('un pedido viejo cae a extras_names en vez de callarse', () => {
    const viejo = {
      ...PEDIDO,
      order_items: [{
        product_name: 'Pizza', variant_name: 'Personal', quantity: 1,
        extras_names: ['Tradicional', 'Extra queso'],
      }],
    }
    expect(textoDelAviso(NEGOCIO, viejo, 'preparacion'))
      .toContain('Tradicional · Extra queso')
  })

  // El detalle va SOLO en el primero. Repetirlo alargaría tres mensajes para
  // decir lo mismo, y su valor está en ese momento: es cuando el cliente
  // comprueba que le entendieron bien y todavía se puede corregir.
  it('el detalle no se repite en los avisos siguientes', () => {
    for (const status of ['en_camino', 'listo_para_retiro', 'completado']) {
      const texto = textoDelAviso(NEGOCIO, PEDIDO, status)
      expect(texto, status).not.toContain('Coca-Cola')
      expect(texto, status).toContain('#23')
    }
  })

  // «En camino» y «listo para retirar» son el MISMO paso contado de dos
  // maneras: a quien le llevan el pedido le importa que salió; a quien lo
  // recoge, que ya puede pasar. Decirle «va en camino» a quien tiene que ir
  // a buscarlo lo deja esperando en casa.
  it('distingue al que espera en casa del que va a recogerlo', () => {
    expect(textoDelAviso(NEGOCIO, PEDIDO, 'en_camino')).toContain('camino')
    const retiro = textoDelAviso(NEGOCIO, PEDIDO, 'listo_para_retiro')
    expect(retiro).toContain('retirarlo')
    expect(retiro).toContain('Monster Pizza')
    expect(retiro).not.toContain('camino')
  })

  it('el entregado agradece y anuncia Umbani', () => {
    const texto = textoDelAviso(NEGOCIO, PEDIDO, 'completado')
    expect(texto).toContain('Gracias por preferirnos')
    expect(texto).toContain('Umbani')
  })

  // La variante va pegada al nombre porque «Pizza» y «Pizza Familiar» son
  // cosas distintas, y el cliente comprueba aquí que le entendieron bien.
  it('no inventa un paréntesis vacío cuando no hay variante', () => {
    const texto = textoDelAviso(NEGOCIO, PEDIDO, 'preparacion')
    expect(texto).toContain('2× Coca-Cola\n')
    expect(texto).not.toContain('()')
  })

  // Regla inviolable #8: el importe llega tal como lo dejó PostgreSQL. Aquí
  // solo se le da formato — si este archivo sumara algo, sería un segundo
  // motor de dinero.
  it('formatea el total sin recalcular nada', () => {
    expect(textoDelAviso(NEGOCIO, { ...PEDIDO, total: 7 }, 'preparacion')).toContain('$7.00')
    expect(textoDelAviso(NEGOCIO, { ...PEDIDO, total: '3.5' }, 'preparacion')).toContain('$3.50')
  })

  it('se aguanta sin líneas y sin total', () => {
    const texto = textoDelAviso(NEGOCIO, { order_number: 9 }, 'preparacion')
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

    await expect(notificar(NEGOCIO, PEDIDO, 'preparacion')).resolves.toBe(true)
    expect(envio).toHaveBeenCalledWith(NEGOCIO, '593990978367', expect.stringContaining('#23'))
  })

  // El pedido de mostrador guarda el literal «mostrador» donde iría el
  // teléfono: quien compra en el local está delante del dueño. Mandarle un
  // WhatsApp a ese texto gastaría dinero por un mensaje que no llega.
  it('no le escribe a un pedido de mostrador', async () => {
    const { notificar, envio } = montar()

    await expect(notificar(NEGOCIO, { ...PEDIDO, contact_phone: 'mostrador' }, 'preparacion')).resolves.toBe(false)
    expect(envio).not.toHaveBeenCalled()
  })

  it('no le escribe a un teléfono que no lo es', async () => {
    const { notificar, envio } = montar()

    for (const contact_phone of ['', '   ', '123', null, undefined]) {
      await expect(notificar(NEGOCIO, { ...PEDIDO, contact_phone }, 'preparacion')).resolves.toBe(false)
    }
    expect(envio).not.toHaveBeenCalled()
  })

  it('sí le escribe por Telegram, que viaja como tg_<chatId>', async () => {
    const { notificar, envio } = montar()

    await expect(notificar(NEGOCIO, { ...PEDIDO, contact_phone: 'tg_12345' }, 'preparacion')).resolves.toBe(true)
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

    await expect(notificar(NEGOCIO, PEDIDO, 'preparacion')).resolves.toBe(false)
  })

  // Pero tampoco se puede perder en silencio: si el dueño cree que su cliente
  // fue avisado y no lo fue, es peor que no haber avisado nunca.
  it('lo registra con el negocio y el pedido', async () => {
    const envio = vi.fn().mockRejectedValue(new Error('YCloud sin saldo'))
    const registrarError = vi.fn().mockResolvedValue(undefined)
    const notificar = crearNotificadorDePedidos({ enviar: envio, registrarError })

    await notificar(NEGOCIO, PEDIDO, 'preparacion')

    expect(registrarError).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'negocio-a',
      category: 'envio',
      context: expect.objectContaining({ pedido: 23, motivo: 'aviso de pedido: preparacion' }),
    }))
  })

  it('un fallo al REGISTRAR el fallo tampoco lanza', async () => {
    const envio = vi.fn().mockRejectedValue(new Error('YCloud sin saldo'))
    const registrarError = vi.fn().mockRejectedValue(new Error('registro caído'))
    const notificar = crearNotificadorDePedidos({ enviar: envio, registrarError })

    await expect(notificar(NEGOCIO, PEDIDO, 'preparacion')).resolves.toBe(false)
  })
})
