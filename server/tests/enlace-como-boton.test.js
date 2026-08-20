import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildCtaUrlPayload } = require('../dist/integrations/ycloud')
const { storefrontInvite, storefrontInviteButton } = require('../dist/services/storefront-link')
const { createBotConversation } = require('../dist/services/bot-conversation')

// ═══════════════════════════════════════════════════════════════════════════
// EL ENLACE DE LA TIENDA VA COMO BOTÓN, NO COMO URL CRUDA
// ═══════════════════════════════════════════════════════════════════════════
//
// Una URL pegada en el chat ocupa tres líneas, se parte en pantallas estrechas
// y se lee como publicidad. WhatsApp tiene para esto el interactivo `cta_url`.
//
// Lo que se protege aquí NO es el aspecto —eso se ve en el teléfono—, son las
// dos cosas que pueden dejar a un cliente sin poder pedir:
//
//   1. Que el botón se arme mal y WhatsApp lo rechace (la etiqueta se mide en
//      BYTES, no en caracteres: un emoji gasta cuatro).
//   2. Que al fallar el botón, el enlace NO salga por ningún lado.

const bytes = texto => new TextEncoder().encode(texto).length

describe('el mensaje con botón de enlace (cta_url)', () => {
  it('arma la forma exacta que espera WhatsApp', () => {
    const payload = buildCtaUrlPayload({
      body: '🛍️ Mira la carta y pide desde aquí 👇',
      url: 'https://ejemplo.com/s/tok123',
      label: 'Ver la carta',
      footer: 'Tu enlace personal · guárdalo, no vence',
    })

    expect(payload.type).toBe('cta_url')
    expect(payload.body.text).toBe('🛍️ Mira la carta y pide desde aquí 👇')
    expect(payload.footer.text).toBe('Tu enlace personal · guárdalo, no vence')
    // `action.name` va repetido dentro del action a propósito: es lo que pide
    // la API, no una redundancia nuestra.
    expect(payload.action).toEqual({
      name: 'cta_url',
      parameters: { display_text: 'Ver la carta', url: 'https://ejemplo.com/s/tok123' },
    })
  })

  // ⚠️ El tope de WhatsApp es de 20 BYTES. «🛍️ Ver la carta» son 15 caracteres
  // y 23 bytes: recortando por longitud pasaría el filtro y lo rechazaría el
  // canal, que es el peor sitio donde enterarse.
  it('recorta la etiqueta por BYTES y sin partir un carácter', () => {
    const payload = buildCtaUrlPayload({
      body: 'cuerpo',
      url: 'https://ejemplo.com/s/tok',
      label: '🛍️ Ver la carta completa del local',
    })
    const etiqueta = payload.action.parameters.display_text
    expect(bytes(etiqueta)).toBeLessThanOrEqual(20)
    // Ni un carácter partido por la mitad: lo que sale se puede volver a leer.
    expect(etiqueta).toBe(new TextDecoder().decode(new TextEncoder().encode(etiqueta)))
  })

  it('sin URL válida devuelve null en vez de un botón que no lleva a ningún sitio', () => {
    const base = { body: 'cuerpo', label: 'Ver la carta' }
    expect(buildCtaUrlPayload({ ...base, url: '' })).toBeNull()
    expect(buildCtaUrlPayload({ ...base, url: 'ejemplo.com/s/tok' })).toBeNull()
    expect(buildCtaUrlPayload({ ...base, url: 'javascript:alert(1)' })).toBeNull()
    expect(buildCtaUrlPayload({ ...base, url: 'https://ok.com', label: '' })).toBeNull()
  })

  it('sin pie no manda un footer vacío', () => {
    const payload = buildCtaUrlPayload({
      body: 'cuerpo', url: 'https://ejemplo.com/s/tok', label: 'Ver la carta',
    })
    expect(payload.footer).toBeUndefined()
  })
})

describe('lo que redacta el servicio del enlace', () => {
  const tienda = { takes_orders: true }

  it('la etiqueta cabe en los 20 bytes de WhatsApp', () => {
    const boton = storefrontInviteButton(tienda, 'https://ejemplo.com/s/tok')
    expect(bytes(boton.label), boton.label).toBeLessThanOrEqual(20)
    // Sin emoji en la etiqueta: cada uno gasta cuatro de esos veinte bytes.
    expect(boton.label).toMatch(/^[\w áéíóúñÁÉÍÓÚÑ]+$/)
    expect(buildCtaUrlPayload(boton)).not.toBeNull()
  })

  it('el botón y el texto dicen lo mismo, y el pie es el mismo en los dos', () => {
    const boton = storefrontInviteButton(tienda, 'https://ejemplo.com/s/tok')
    const texto = storefrontInvite(tienda, 'https://ejemplo.com/s/tok')
    expect(boton.body).toContain('Mira la carta')
    expect(texto).toContain('Mira la carta')
    // El cliente puede recibir uno u otro según el canal: no puede leer dos
    // promesas distintas del mismo negocio.
    expect(texto).toContain(boton.footer)
  })
})

// ── El enlace SIEMPRE sale ─────────────────────────────────────────────────

const negocioMiniapp = {
  id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
  chat_mode: 'miniapp', storefront_enabled: true, takes_orders: true,
  bot_active: true, suspended: false,
}
const URL_DEL_ENLACE = 'https://ejemplo.com/s/tok123'

function montar(yaSeLeMando = false) {
  const guardados = []
  const database = {
    getSession: async () => ({ manual_mode: false, contact_name: 'Ana' }),
    saveMessage: async (_b, _p, role, content) => { guardados.push({ role, content }) },
    upsertSession: async () => ({}),
    getSchedule: async () => [],
    getPolicies: async () => ({}),
    getContactHistory: async () => [],
    getAvailableSlots: async () => null,
    countProducts: async () => 5,
    searchProductsByVector: async () => [],
    getProducts: async () => [],
    recordConsultations: async () => ({}),
    resolveCustomer: async () => ({ id: 'cust-1' }),
    claimStorefrontLinkSend: async () => !yaSeLeMando,
  }
  const conversation = createBotConversation({
    database,
    ai: { callAI: async () => 'x', embedText: async () => [] },
    storefrontLink: {
      issueLink: async () => URL_DEL_ENLACE,
      // ⚠️ Se pasan TODOS los argumentos, no los dos primeros: un doble que
      // se come el tercero (`repetido`) prueba el doble, no el bot. Pasó.
      storefrontInvite: (...args) => storefrontInvite(...args),
      storefrontInviteButton: (...args) => storefrontInviteButton(...args),
    },
    reports: { handleOwnerMessage: async () => ({ handled: false, reply: '' }) },
    schedule: { isOutsideHours: () => false, buildScheduleMessage: () => '' },
    prompt: { buildPrompt: () => 'prompt' },
    tags: {
      detectMediaRequest: () => ({ wantsImage: false, wantsVideo: false }),
      isInsultMessage: () => false,
      impersonatesOfficialSummary: () => false,
      parseBotOutput: () => ({ finalText: 'x', orderPayload: null }),
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
  return { conversation, guardados }
}

const procesar = async (sendLink, yaSeLeMando = false) => {
  const montaje = montar(yaSeLeMando)
  const enviados = []
  await montaje.conversation.processMessage({
    business: negocioMiniapp,
    phone: '593999111222',
    text: 'hola',
    send: async t => { enviados.push(t); return {} },
    sendLink,
  })
  return { enviados, guardados: montaje.guardados }
}

describe('el enlace sale por el mejor formato del canal, pero SALE', () => {
  it('con botón disponible no se manda además la URL en texto', async () => {
    const sendLink = vi.fn(async () => true)
    const { enviados } = await procesar(sendLink)

    expect(sendLink).toHaveBeenCalledTimes(1)
    expect(sendLink.mock.calls[0][0].url).toBe(URL_DEL_ENLACE)
    // Nada de texto con el enlace dentro: sería el mismo mensaje dos veces.
    expect(enviados.join('\n')).not.toContain(URL_DEL_ENLACE)
  })

  it('aunque vaya como botón, el historial guarda el enlace escrito', async () => {
    const { guardados } = await procesar(vi.fn(async () => true))
    const delBot = guardados.filter(m => m.role === 'assistant')
    // El dueño abre su panel para saber qué recibió su cliente. «Botón» no le
    // dice a dónde apuntaba.
    expect(delBot.some(m => m.content.includes(URL_DEL_ENLACE))).toBe(true)
  })

  it('si el canal no admite botones, el enlace sale como texto', async () => {
    const { enviados, guardados } = await procesar(vi.fn(async () => false))
    expect(enviados.join('\n')).toContain(URL_DEL_ENLACE)
    expect(guardados.some(m => m.content.includes(URL_DEL_ENLACE))).toBe(true)
  })

  // ⚠️ El caso que de verdad importa: YCloud contesta un 400 raro, o la cuenta
  // no admite interactivos. En modo mini app el enlace es lo ÚNICO que permite
  // pedir, así que un botón fallido no puede convertirse en silencio.
  it('si el botón revienta, el cliente recibe el enlace igual', async () => {
    const sendLink = vi.fn(async () => { throw new Error('YCloud dijo que no') })
    const { enviados, guardados } = await procesar(sendLink)
    expect(enviados.join('\n')).toContain(URL_DEL_ENLACE)
    expect(guardados.some(m => m.content.includes(URL_DEL_ENLACE))).toBe(true)
  })

  // ⚠️ El caso que motivó todo esto: el cliente borró el chat y vuelve a
  // escribir el mismo día. Antes recibía «usa el enlace que te envié» y se
  // quedaba sin poder pedir.
  it('quien ya recibió el enlace hoy lo recibe otra vez, en el botón', async () => {
    const sendLink = vi.fn(async () => true)
    await procesar(sendLink, true)

    expect(sendLink).toHaveBeenCalledTimes(1)
    const mensaje = sendLink.mock.calls[0][0]
    expect(mensaje.url).toBe(URL_DEL_ENLACE)
    expect(mensaje.body).toContain('otra vez')
    // La etiqueta no cambia: sigue siendo el mismo sitio al que va.
    expect(mensaje.label).toBe('Ver la carta')
  })

  it('sin canal con botones (Telegram, simulador) todo sigue como antes', async () => {
    const { enviados } = await procesar(undefined)
    expect(enviados.join('\n')).toContain(URL_DEL_ENLACE)
  })
})
