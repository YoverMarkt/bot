import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createBotConversation } = require('../dist/services/bot-conversation')
const enlace = require('../dist/services/storefront-link')

// ═══════════════════════════════════════════════════════════════════════════
// QUIEN ESCRIBE POR MOLESTAR
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde el 2026-08-12 el modo mini app contesta a CADA mensaje: quien borraba
// el chat se quedaba sin poder pedir. El efecto secundario es que quien
// escribe por molestar recibe una respuesta por mensaje, y desde el 1 de
// octubre de 2026 cada respuesta se paga.
//
// Dos frenos distintos, y la diferencia importa:
//
//   · el TECHO es automático y temporal — un contador no puede condenar a
//     nadie, porque quien escribió doce veces un martes puede ser un cliente
//     agobiado;
//   · el BLOQUEO lo pone el dueño, no caduca y es total.
//
// Lo que se protege aquí es que ninguno de los dos deje sin respuesta a quien
// no lo merece, y que el bloqueo bloquee de verdad.

const NEGOCIO = {
  id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
  phone: '+593991716574',
  chat_mode: 'miniapp', storefront_enabled: true, takes_orders: true,
  bot_active: true, suspended: false,
}
const URL_DEL_ENLACE = 'https://ejemplo.com/s/tok123'

function montar(overrides = {}) {
  const guardados = []
  const sesiones = []
  const enlacesCreados = []
  const database = {
    getSession: async () => ({ manual_mode: false, contact_name: 'Ana' }),
    saveMessage: async (_b, _p, role, content) => { guardados.push({ role, content }) },
    upsertSession: async (_b, _p, data) => { sesiones.push(data); return {} },
    getSchedule: async () => [],
    getPolicies: async () => ({}),
    getContactHistory: async () => [],
    getAvailableSlots: async () => null,
    countProducts: async () => 5,
    searchProductsByVector: async () => [],
    getProducts: async () => [],
    recordConsultations: async () => ({}),
    resolveCustomer: async () => ({ id: 'cust-1' }),
    claimStorefrontLinkSend: async () => true,
    isContactBlocked: async () => false,
    claimMiniappReply: async () => ({ permitido: true, motivo: 'ok', respuestas: 1 }),
    ...overrides,
  }
  const conversation = createBotConversation({
    database,
    ai: { callAI: async () => 'x', embedText: async () => [] },
    storefrontLink: {
      issueLink: async () => { enlacesCreados.push(1); return URL_DEL_ENLACE },
      // Los argumentos se pasan TODOS: un doble que se come el tercero prueba
      // el doble, no el bot.
      storefrontInvite: (...args) => enlace.storefrontInvite(...args),
      storefrontInviteButton: (...args) => enlace.storefrontInviteButton(...args),
    },
    reports: { handleOwnerMessage: async () => ({ handled: false, reply: '' }) },
    schedule: { isOutsideHours: () => false, buildScheduleMessage: () => '' },
    prompt: { buildPrompt: () => 'prompt' },
    tags: {
      detectMediaRequest: () => ({ wantsImage: false, wantsVideo: false }),
      isInsultMessage: () => false,
      impersonatesOfficialSummary: () => false,
      parseBotOutput: () => ({ finalText: 'respuesta del modelo', orderPayload: null }),
    },
    actions: {
      createBookingFromTag: async () => ({}),
      handleConversationOutcome: async () => ({ handled: false }),
      processOrderPayload: async () => false,
    },
    media: { sendRequestedProductMedia: async () => false },
    logger: { log: () => {}, error: () => {} },
    sleep: async () => {},
  })
  return { conversation, guardados, sesiones, enlacesCreados }
}

const procesar = async (montaje, texto = 'hola', business = NEGOCIO) => {
  const enviados = []
  montaje.sendTyping = vi.fn(async () => ({}))
  await montaje.conversation.processMessage({
    business, phone: '593999111222', text: texto,
    send: async t => { enviados.push(t); return {} },
    sendTyping: montaje.sendTyping,
  })
  return enviados
}

describe('el techo de respuestas por hora', () => {
  it('por debajo del aviso, el enlace sale como siempre', async () => {
    const m = montar({
      claimMiniappReply: async () => ({ permitido: true, motivo: 'ok', respuestas: 3 }),
    })
    const enviados = await procesar(m)
    expect(enviados).toHaveLength(1)
    expect(enviados[0]).toContain(URL_DEL_ENLACE)
    expect(enviados[0]).not.toContain('llama al local')
  })

  // ⚠️ Ofrecer el teléfono NO cuesta un mensaje más: es el mismo, con una
  // línea. Quien va por el quinto mensaje o no encuentra lo que busca o no
  // quiere usar la app, y esto es lo único que puede desatascarlo.
  it('a partir del aviso añade el teléfono al MISMO mensaje', async () => {
    const m = montar({
      claimMiniappReply: async () => ({ permitido: true, motivo: 'con_telefono', respuestas: 5 }),
    })
    const enviados = await procesar(m)
    expect(enviados).toHaveLength(1)
    // Un solo mensaje: el enlace y la ayuda viajan juntos.
    expect(enviados[0]).toContain(URL_DEL_ENLACE)
    expect(enviados[0]).toContain('+593991716574')
  })

  it('pasado el tope no se manda NADA, pero el mensaje se guarda', async () => {
    const m = montar({
      claimMiniappReply: async () => ({ permitido: false, motivo: 'silenciado', respuestas: 11 }),
    })
    const enviados = await procesar(m, 'otra vez molestando')

    expect(enviados).toEqual([])
    // El dueño tiene que poder leer qué le escribieron: callar no es dejar de ver.
    expect(m.guardados).toContainEqual({ role: 'user', content: 'otra vez molestando' })
    // Y no se le contesta NI para avisarle de que está callado: quien molesta
    // busca una reacción, y avisar cuesta justo el mensaje que se ahorra.
    expect(m.guardados.filter(g => g.role === 'assistant')).toEqual([])
    // Marcado para que una persona lo mire y decida si lo bloquea.
    expect(m.sesiones.some(s => s.unread_owner === true)).toBe(true)
  })

  // ⚠️ Quien acaba de pagar no es quien molesta. Dejarle sin confirmación
  // después de transferir es el peor momento posible para ahorrar un mensaje.
  it('el comprobante SÍ se contesta aunque esté silenciado', async () => {
    const m = montar({
      claimMiniappReply: async () => ({ permitido: false, motivo: 'silenciado', respuestas: 12 }),
    })
    const enviados = await procesar(m, '[el cliente envió su comprobante de pago del pedido #12]')

    expect(enviados).toHaveLength(1)
    expect(enviados[0]).toContain('Recibimos tu comprobante')
  })

  // ⚠️ La entrada de mensajes es at-least-once: si la confirmación a
  // PostgreSQL no llega, el worker reintenta y el mensaje vuelve a procesarse.
  // El id viaja hasta la RPC para que ese reintento no sume otra respuesta.
  it('el id del mensaje entrante llega hasta el reclamo', async () => {
    const reclamar = vi.fn(async () => ({ permitido: true, motivo: 'ok', respuestas: 1 }))
    const m = montar({ claimMiniappReply: reclamar })
    await m.conversation.processMessage({
      business: NEGOCIO, phone: '593999111222', text: 'hola',
      send: async () => ({}),
      inboundId: 'wamid.ABC123',
    })
    expect(reclamar).toHaveBeenCalledWith('biz-1', 'cust-1', { mensajeId: 'wamid.ABC123' })
  })

  it('sin id del canal se cuenta igual: más vale contar de más que no contar', async () => {
    const reclamar = vi.fn(async () => ({ permitido: true, motivo: 'ok', respuestas: 1 }))
    const m = montar({ claimMiniappReply: reclamar })
    await procesar(m)
    expect(reclamar).toHaveBeenCalledWith('biz-1', 'cust-1', { mensajeId: null })
  })

  // Si la base falla, se contesta. Quedarse mudo por un problema NUESTRO deja
  // sin atender a un cliente de verdad, y eso cuesta más que un mensaje.
  it('si el reclamo revienta, el cliente recibe su enlace igual', async () => {
    const m = montar({
      claimMiniappReply: async () => { throw new Error('base caída') },
    })
    const enviados = await procesar(m)
    expect(enviados[0]).toContain(URL_DEL_ENLACE)
  })

  // ⚠️ Crear el enlace CUESTA: abre una sesión de tienda con su token. Estaba
  // antes del corte, así que un silenciado seguía generando una fila por
  // mensaje — justo la tabla que el techo existe para dejar de llenar.
  it('estando silenciado no se crea ninguna sesión de tienda', async () => {
    const m = montar({
      claimMiniappReply: async () => ({ permitido: false, motivo: 'silenciado', respuestas: 11 }),
    })
    await procesar(m)
    expect(m.enlacesCreados).toEqual([])
  })

  // El doble check azul le dice «te estoy leyendo», que es la reacción que
  // busca quien escribe por molestar. Y es una llamada a la API que se ahorra.
  it('al silenciado no se le marca el mensaje como leído', async () => {
    const m = montar({
      claimMiniappReply: async () => ({ permitido: false, motivo: 'silenciado', respuestas: 11 }),
    })
    await procesar(m)
    expect(m.sendTyping).not.toHaveBeenCalled()
  })

  it('al cliente normal sí se le marca leído, como siempre', async () => {
    const m = montar()
    await procesar(m)
    expect(m.sendTyping).toHaveBeenCalledTimes(1)
  })

  it('el comprobante se marca leído aunque esté silenciado', async () => {
    const m = montar({
      claimMiniappReply: async () => ({ permitido: false, motivo: 'silenciado', respuestas: 12 }),
    })
    await procesar(m, '[el cliente envió su comprobante de pago del pedido #12]')
    expect(m.sendTyping).toHaveBeenCalledTimes(1)
    // Y tampoco por ahí se cuela una sesión de tienda: quien pagó no necesita
    // el enlace del menú.
    expect(m.enlacesCreados).toEqual([])
  })

  it('estando silenciado NO se gasta la ventana de 24 h del enlace', async () => {
    const reclamarEnlace = vi.fn(async () => true)
    const m = montar({
      claimMiniappReply: async () => ({ permitido: false, motivo: 'silenciado', respuestas: 11 }),
      claimStorefrontLinkSend: reclamarEnlace,
    })
    await procesar(m)
    // Gastarla mientras se está callado dejaría al cliente sin enlace justo
    // cuando vuelva a escribir en condiciones.
    expect(reclamarEnlace).not.toHaveBeenCalled()
  })
})

describe('el bloqueo del dueño', () => {
  it('calla al bot y guarda el mensaje, sin avisar al bloqueado', async () => {
    const m = montar({ isContactBlocked: async () => true })
    const enviados = await procesar(m, 'sigo aquí')

    expect(enviados).toEqual([])
    expect(m.guardados).toContainEqual({ role: 'user', content: 'sigo aquí' })
    expect(m.guardados.filter(g => g.role === 'assistant')).toEqual([])
    expect(m.sesiones.some(s => s.unread_owner === true)).toBe(true)
  })

  // ⚠️ En TODOS los modos. Un bloqueo que solo valga en mini app deja al
  // bloqueado conversando con la IA —que además cuesta tokens— o navegando el
  // menú como si nada.
  it('vale igual en modo IA y en modo menú', async () => {
    for (const chat_mode of ['ai', 'menu', 'miniapp']) {
      const m = montar({ isContactBlocked: async () => true })
      const enviados = await procesar(m, 'hola', { ...NEGOCIO, chat_mode })
      expect(enviados, chat_mode).toEqual([])
    }
  })

  // ⚠️ El modo manual se comprueba antes que el bloqueo —tiene que hacerlo,
  // es lo que permite al dueño responder a mano—, así que un bloqueado en modo
  // manual cortaba por esa rama y volvía a encender `unread_owner` con cada
  // mensaje: la alarma sonaba por alguien recién bloqueado. El bloqueo va
  // ahora por delante.
  it('un bloqueado en modo manual tampoco enciende la alarma', async () => {
    const m = montar({
      isContactBlocked: async () => true,
      getSession: async () => ({ manual_mode: true, contact_name: 'Ana' }),
    })
    const enviados = await procesar(m, 'sigo aquí')

    expect(enviados).toEqual([])
    // El mensaje se guarda —callar no es dejar de ver— pero la conversación no
    // vuelve a reclamar atención con `manual_mode` puesto.
    expect(m.guardados).toContainEqual({ role: 'user', content: 'sigo aquí' })
    expect(m.sesiones.every(s => s.manual_mode !== true)).toBe(true)
  })

  it('sin bloqueo, todo sigue exactamente igual', async () => {
    const m = montar({ isContactBlocked: async () => false })
    const enviados = await procesar(m)
    expect(enviados[0]).toContain(URL_DEL_ENLACE)
  })

  // Si la consulta del bloqueo falla se ATIENDE. Callar por un fallo nuestro
  // deja sin servicio a un cliente de verdad; el coste de equivocarse al revés
  // es un mensaje a alguien que molesta.
  it('si la consulta del bloqueo revienta, se atiende', async () => {
    const m = montar({ isContactBlocked: async () => { throw new Error('base caída') } })
    const enviados = await procesar(m)
    expect(enviados[0]).toContain(URL_DEL_ENLACE)
  })

  // La base parcial de un arnés o del simulador no puede tumbar el bot con un
  // «isContactBlocked is not a function»: sin la función, no hay bloqueo, que
  // es como se comportaba antes de que existiera.
  it('una base sin la función no rompe nada', async () => {
    const m = montar({ isContactBlocked: undefined, claimMiniappReply: undefined })
    const enviados = await procesar(m)
    expect(enviados[0]).toContain(URL_DEL_ENLACE)
  })
})
