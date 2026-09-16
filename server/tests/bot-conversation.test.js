import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createBotConversation } = require('../dist/services/bot-conversation')

const business = {
  id: 'business-a',
  name: 'Negocio A',
  bot_active: true,
  suspended: false,
  ai_provider: 'openai',
  takes_orders: true,
}
const product = {
  id: 'product-a',
  name: 'Perfume Floral Intenso',
  brand: 'Aura',
  tags: ['floral'],
  price: '10.00',
  image_url: 'https://cdn.example/floral.jpg',
}

function setup(overrides = {}) {
  const database = {
    getSession: vi.fn().mockResolvedValue(null),
    saveMessage: vi.fn().mockResolvedValue({ error: null }),
    upsertSession: vi.fn().mockResolvedValue({ error: null }),
    getSchedule: vi.fn().mockResolvedValue([]),
    getPolicies: vi.fn().mockResolvedValue({}),
    getContactHistory: vi.fn().mockResolvedValue([]),
    getAvailableSlots: vi.fn().mockResolvedValue(null),
    countProducts: vi.fn().mockResolvedValue(1),
    searchProductsByVector: vi.fn().mockResolvedValue([]),
    getProducts: vi.fn().mockResolvedValue([product]),
    recordConsultations: vi.fn().mockResolvedValue(undefined),
    ...overrides.database,
  }
  const reports = {
    handleOwnerMessage: vi.fn().mockResolvedValue({ handled: false, reply: '' }),
    ...overrides.reports,
  }
  const schedule = {
    isOutsideHours: vi.fn().mockReturnValue(false),
    buildScheduleMessage: vi.fn().mockReturnValue('Horario del negocio'),
    ...overrides.schedule,
  }
  const ai = {
    callAI: vi.fn().mockResolvedValue('Respuesta final'),
    embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
    ...overrides.ai,
  }
  const prompt = {
    buildPrompt: vi.fn().mockReturnValue('PROMPT'),
    ...overrides.prompt,
  }
  const tags = {
    detectMediaRequest: vi.fn().mockReturnValue({ wantsImage: false, wantsVideo: false }),
    isInsultMessage: vi.fn().mockReturnValue(false),
    impersonatesOfficialSummary: vi.fn().mockReturnValue(false),
    parseBotOutput: vi.fn().mockReturnValue({
      finalText: 'Respuesta final',
      orderPayload: null,
      lodgingQuote: null,
      lodgingRequest: null,
      hasSale: false,
      hasHandoffTag: false,
      isUncertain: false,
      hasActionConflict: false,
    }),
    ...overrides.tags,
  }
  // ⚠️ Aquí se montaban `actions` (el ejecutor del pedido por chat), `media`
  // (las fotos del catálogo) y `menuFlow` (el motor del menú). Los tres se
  // retiraron del servidor el 2026-09-16 con el modo menú, que era su único
  // llamador: `bot-conversation` ya no los recibe ni los pide.
  const storefrontLink = {
    issueLink: vi.fn().mockResolvedValue(null),
    storefrontInvite: vi.fn((_business, url) => `🛍️ Nuestra tienda:\n${url}`),
    ...overrides.storefrontLink,
  }
  const logger = { log: vi.fn(), error: vi.fn() }
  const sleep = vi.fn().mockResolvedValue(undefined)
  const now = vi.fn().mockReturnValue(30_000_000)
  const conversation = createBotConversation({
    database, reports, schedule, ai, prompt, tags,
    storefrontLink, logger, sleep, now,
    ...(overrides.priceGuard ? { priceGuard: overrides.priceGuard } : {}),
  })
  const send = vi.fn().mockResolvedValue(undefined)
  const sendImage = vi.fn().mockResolvedValue(undefined)
  const sendTyping = vi.fn().mockResolvedValue(undefined)
  const sendVideo = vi.fn().mockResolvedValue(undefined)
  return {
    conversation, database, reports, schedule, ai, prompt, tags,
    storefrontLink, logger, sleep, now,
    send, sendImage, sendTyping, sendVideo,
  }
}

function input(setupResult, overrides = {}) {
  return {
    business,
    phone: '0990000001',
    text: '¿Tienen Perfume Floral Intenso?',
    send: setupResult.send,
    sendImage: setupResult.sendImage,
    sendTyping: setupResult.sendTyping,
    sendVideo: setupResult.sendVideo,
    ...overrides,
  }
}

describe('orquestación de conversaciones del bot', () => {
  it('corta inmediatamente negocios suspendidos o con bot inactivo', async () => {
    const suspended = setup()
    await suspended.conversation.processMessage(input(suspended, {
      business: { ...business, suspended: true },
    }))
    expect(suspended.send).toHaveBeenCalledWith(expect.stringContaining('pago pendiente'))
    expect(suspended.reports.handleOwnerMessage).not.toHaveBeenCalled()
    expect(suspended.database.getSession).not.toHaveBeenCalled()

    const inactive = setup()
    await inactive.conversation.processMessage(input(inactive, {
      business: { ...business, bot_active: false },
    }))
    expect(inactive.send).not.toHaveBeenCalled()
    expect(inactive.reports.handleOwnerMessage).not.toHaveBeenCalled()
  })


  it('continúa aunque marcar el mensaje como leído falle', async () => {
    // `sendTyping` marca LEÍDO además de pintar «escribiendo…», y va por la
    // API del canal. Si falla justo ahí, el cliente NO puede quedarse sin
    // respuesta: el check azul es best-effort, la respuesta no.
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })
    current.sendTyping.mockRejectedValueOnce(new Error('YCloud no disponible'))

    await current.conversation.processMessage(input(current, {
      business: {
        ...business, chat_mode: 'miniapp', slug: 'negocio-a', storefront_enabled: true,
      },
      text: 'hola',
    }))

    expect(current.sendTyping).toHaveBeenCalledTimes(1)
    expect(current.send.mock.calls.map(call => call[0]).join(''))
      .toContain('https://x.com/t/negocio-a?s=tok')
  })







  it('atiende el reporte del dueño antes de leer una sesión de cliente', async () => {
    const current = setup({
      reports: {
        handleOwnerMessage: vi.fn().mockResolvedValue({
          handled: true, reply: 'Reporte de hoy',
        }),
      },
    })

    await current.conversation.processMessage(input(current))

    expect(current.reports.handleOwnerMessage).toHaveBeenCalledWith(
      business, '0990000001', '¿Tienen Perfume Floral Intenso?',
    )
    expect(current.send).toHaveBeenCalledWith('Reporte de hoy')
    expect(current.database.getSession).not.toHaveBeenCalled()
  })

  it('guarda modo manual exclusivamente dentro del negocio resuelto', async () => {
    const current = setup({
      database: { getSession: vi.fn().mockResolvedValue({ manual_mode: true }) },
    })

    await current.conversation.processMessage(input(current))

    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'user', '¿Tienen Perfume Floral Intenso?',
    )
    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({
        manual_mode: true, unread_owner: true,
      }),
    )
    expect(current.database.upsertSession).not.toHaveBeenCalledWith(
      'business-b', expect.anything(), expect.anything(),
    )
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })


  // Vigilante de precios (regla inviolable #8). Arranca en modo observación a
  // propósito: un falso positivo cortaría la conversación de un cliente real.

  it('deriva insultos sin invocar IA ni consultar el catálogo', async () => {
    const current = setup({
      tags: { isInsultMessage: vi.fn().mockReturnValue(true) },
    })

    await current.conversation.processMessage(input(current, { text: 'Eres un idiota' }))

    expect(current.database.upsertSession).toHaveBeenCalledWith(
      'business-a', '0990000001', expect.objectContaining({ manual_mode: true }),
    )
    expect(current.send).toHaveBeenCalledWith(expect.stringContaining('un asesor'))
    expect(current.database.getSchedule).not.toHaveBeenCalled()
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  it('avisa una sola vez mientras continúa fuera de horario', async () => {
    const current = setup({
      schedule: { isOutsideHours: vi.fn().mockReturnValue(true) },
    })
    const message = input(current)

    await current.conversation.processMessage(message)
    await current.conversation.processMessage(message)

    expect(current.database.getSchedule).toHaveBeenCalledTimes(2)
    expect(current.database.getSchedule).toHaveBeenCalledWith('business-a')
    expect(current.send).toHaveBeenCalledTimes(1)
    expect(current.send).toHaveBeenCalledWith('Horario del negocio')
    expect(current.database.saveMessage).toHaveBeenCalledWith(
      'business-a', '0990000001', 'assistant', 'Horario del negocio',
    )
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  // Antes el hospedaje era una excepción que atendía siempre, y eso convertía
  // el horario del dueño en decoración: no podía apagar el bot ni queriendo.
  // Ahora manda su configuración; para cotizar de madrugada pone 00:00-23:59.




  // ⚠️ Aquí vivían las pruebas del MODO IA: el resumen oficial imitado, el
  // vigilante de precios, el RAG, las etiquetas de pedido del modelo y las
  // confirmaciones antes de validar. Se fueron con la IA el 2026-08-21.
  // Lo que protegían —que ningún monto salga sin pasar por el servidor—
  // ahora es estructural: no queda nada capaz de escribir un precio.



  it('humaniza hasta tres bloques sin esperar en las pruebas', async () => {
    const current = setup()
    await current.conversation.humanizedSend(
      'Uno\n\nDos\n\nTres\n\nCuatro', current.send, current.sendTyping,
    )

    expect(current.send).toHaveBeenNthCalledWith(1, 'Uno\n\nDos')
    expect(current.send).toHaveBeenNthCalledWith(2, 'Tres')
    expect(current.send).toHaveBeenNthCalledWith(3, 'Cuatro')
    expect(current.sleep).toHaveBeenCalledTimes(3)
  })


  it('mantiene conversación y entrada enlazadas directamente', () => {
    const service = fs.readFileSync(new URL('../src/services/bot-conversation.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('database.getSession(business.id, phone)')
    expect(service).not.toContain('@ts-nocheck')
    // ⚠️ El RAG (`searchProductsByVector`) se fue con la IA el 2026-08-21.
    // Se comprueba que NO vuelva: era la vía por la que el catálogo entraba
    // en un prompt.
    expect(service).not.toContain('database.searchProductsByVector(')
    expect(service).not.toMatch(/callAI|buildPrompt/)
    expect(entry).toContain("require('./bot-conversation')")
  })

describe('el enlace de la mini app', () => {
  const conTienda = {
    ...business,
    slug: 'negocio-a',
    storefront_enabled: true,
  }

  // ⚠️ REGRESIÓN REPORTADA: un hostal en modo menú recibía el menú de botones
  // Y el enlace a la vez — dos formas de hacer lo mismo compitiendo en el
  // mismo chat. El enlace pertenece SOLO al modo mini app.


  // En modo IA no hay menú donde colgarlo, así que va como mensaje propio —
  // pero DESPUÉS de que el asistente responda, no antes.
  // Este test decía lo contrario hasta el 2026-08-02: el enlace se mandaba
  // DESPUÉS de que la IA hubiera respondido. Es decir, un negocio que eligió
  // atender por la app pagaba tokens en cada mensaje. Ahora el modo corta
  // antes del modelo y el enlace ES la respuesta.
  // El detalle del modo vive en `miniapp-sin-ia.test.js`.
  it('en modo MINI APP el enlace es la respuesta, sin pasar por la IA', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'miniapp' },
      text: 'hola',
    }))

    const mensajes = current.send.mock.calls.map(call => String(call[0]))
    expect(mensajes.some(m => m.includes('https://x.com/t/'))).toBe(true)
    expect(mensajes.some(m => m.includes('Respuesta final'))).toBe(false)
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  // Modo IA puro = atender y vender por chat. Quien quiera la app se pone en
  // modo 'miniapp'; si no, el enlace aparecería sin haberlo pedido.

  // Antes, una pregunta concreta en modo mini app se respondía por IA y no se
  // mandaba enlace. Eso era exactamente lo que había que quitar: el negocio
  // eligió atender por la app, así que la pregunta tampoco se contesta.
  it('en modo mini app una pregunta concreta tampoco pasa por la IA', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'miniapp' },
      text: '¿tienen pizza sin gluten?',
    }))

    expect(current.ai.callAI).not.toHaveBeenCalled()
    const mensajes = current.send.mock.calls.map(call => String(call[0]))
    expect(mensajes.some(m => m.includes('Respuesta final'))).toBe(false)
  })


  it('un fallo del enlace no tumba la conversación', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockRejectedValue(new Error('base caída')),
      },
    })

    await expect(current.conversation.processMessage(input(current, {
      business: { ...conTienda, chat_mode: 'miniapp' },
      text: 'hola',
    }))).resolves.not.toThrow()

    // ⚠️ Antes aquí se comprobaba que la IA respondía igualmente. Con la IA
    // retirada lo que importa es que el fallo no tumbe el proceso: el cliente
    // se queda sin enlace, pero el error queda registrado y nada revienta.
  })
})

describe('el horario del dueño manda sobre la atención', () => {
  // Estas pruebas nacen de un fallo real: el modo menú salía por su propia
  // rama ANTES de mirar el reloj, así que un negocio con el menú activado
  // atendía domingos y de madrugada aunque su horario dijera lo contrario.
  //
  // ⚠️ El modo menú se retiró el 2026-09-16, pero la comprobación del reloj
  // NO se movió de sitio: sigue delante del despacho, que es lo que impide
  // que un modo futuro vuelva a saltársela. Por eso estas pruebas se
  // reescriben en vez de borrarse.
  it('fuera de horario no se atiende: se manda el horario y se para', async () => {
    const current = setup({
      schedule: {
        isOutsideHours: vi.fn().mockReturnValue(true),
        buildScheduleMessage: vi.fn().mockReturnValue('Atendemos de 09:00 a 18:00'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'miniapp' },
      text: 'hola',
    }))

    expect(current.send).toHaveBeenCalledWith('Atendemos de 09:00 a 18:00')
    expect(current.send).toHaveBeenCalledTimes(1)
  })


  // Fuera de horario tampoco se reparten enlaces: la tienda comprueba el
  // horario igual, así que el cliente abriría una tienda que no acepta pedidos.
  it('fuera de horario no se manda el enlace de la tienda', async () => {
    const current = setup({
      schedule: {
        isOutsideHours: vi.fn().mockReturnValue(true),
        buildScheduleMessage: vi.fn().mockReturnValue('Cerrado'),
      },
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: { ...business, chat_mode: 'miniapp', slug: 'negocio-a', storefront_enabled: true },
      text: 'hola',
    }))

    expect(current.storefrontLink.issueLink).not.toHaveBeenCalled()
  })

  it('dentro de horario se atiende con normalidad', async () => {
    const current = setup({
      storefrontLink: {
        issueLink: vi.fn().mockResolvedValue('https://x.com/t/negocio-a?s=tok'),
      },
    })

    await current.conversation.processMessage(input(current, {
      business: {
        ...business, chat_mode: 'miniapp', slug: 'negocio-a', storefront_enabled: true,
      },
      text: 'hola',
    }))

    expect(current.send.mock.calls.map(call => call[0]).join(''))
      .toContain('https://x.com/t/negocio-a?s=tok')
  })
})
})
