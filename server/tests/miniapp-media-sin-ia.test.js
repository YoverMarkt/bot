import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createInboundWebhookProcessor } = require('../dist/services/inbound-webhook')

// ═══════════════════════════════════════════════════════════════════════════
// EN MODO MINI APP, LA MEDIA NI SE BAJA NI SE MIRA
// ═══════════════════════════════════════════════════════════════════════════
//
// El corte de `bot-conversation` llega tarde para esto. Cuando una foto o una
// nota de voz entra por el webhook, ANTES de llegar a la conversación ya se ha
// descargado el archivo y se ha pasado por OpenAI —visión para la imagen,
// Whisper para el audio—, que son las dos llamadas más caras del sistema.
//
// Y en modo mini app ese resultado no se usa para nada: la respuesta va a ser
// el enlace o el recordatorio mandes lo que mandes. Era pagar dos veces por
// nada: el tráfico de bajar el archivo y la llamada al modelo.
//
// Salió probando de verdad desde el móvil: se mandó una foto a un negocio en
// modo mini app y el bot contestó «no pude identificar el producto de la
// foto» — o sea, había pagado la visión para no usarla.

const canal = { provider: 'ycloud', identifierType: 'phone', identifier: '593999000001' }

function carga(kind) {
  return {
    version: 1, provider: 'ycloud', businessId: 'business-a',
    from: '+593988000001', inboundId: `inbound-${kind}`,
    channelAddress: canal,
    content: { kind, media: { id: 'm1', url: `https://x/archivo.${kind}` } },
  }
}

function montar(chatMode) {
  const database = {
    getBusinessByChannel: vi.fn().mockResolvedValue({
      id: 'business-a', name: 'Monster Pizza', chat_mode: chatMode,
      meta_token: 'meta-token-a', ycloud_api_key: 'ycloud-key-a',
    }),
  }
  const bot = {
    handleMessage: vi.fn().mockResolvedValue(undefined),
    handleImage: vi.fn().mockResolvedValue(undefined),
    transcribeAudio: vi.fn().mockResolvedValue('Audio transcrito'),
  }
  const http = { get: vi.fn().mockResolvedValue({ data: Buffer.from('x'), headers: {} }) }
  const logger = { log: vi.fn(), error: vi.fn() }
  return {
    bot, http, database,
    procesar: createInboundWebhookProcessor({ database, bot, http, logger }),
  }
}

describe('media entrante en modo mini app', () => {
  for (const kind of ['image', 'audio']) {
    const nombre = kind === 'image' ? 'foto' : 'nota de voz'
    it(`una ${nombre} NO se descarga ni pasa por OpenAI`, async () => {
      const m = montar('miniapp')

      await m.procesar(carga(kind))

      // Lo que cuesta dinero:
      expect(m.bot.transcribeAudio, 'Whisper').not.toHaveBeenCalled()
      // Lo que cuesta tráfico:
      expect(m.http.get, 'descarga del archivo').not.toHaveBeenCalled()
      // Y aun así al cliente se le responde: entra en el flujo normal, que
      // corta más abajo y le manda el enlace.
      expect(m.bot.handleMessage).toHaveBeenCalledTimes(1)
    })
  }

  it('la media llega como texto legible, para que el dueño lo lea en su panel', async () => {
    const m = montar('miniapp')
    await m.procesar(carga('image'))
    expect(m.bot.handleMessage.mock.calls[0][1]).toBe('[foto]')

    const n = montar('miniapp')
    await n.procesar(carga('audio'))
    expect(n.bot.handleMessage.mock.calls[0][1]).toBe('[nota de voz]')
  })

  it('un negocio en modo ai NO toma el atajo: sigue su camino de siempre', async () => {
    const m = montar('ai')
    // Puede fallar más adelante al simular la descarga; da igual. Lo que se
    // comprueba es que NO entró por el atajo del modo mini app.
    await m.procesar(carga('audio')).catch(() => {})

    const porElAtajo = m.bot.handleMessage.mock.calls
      .some(([, texto]) => texto === '[nota de voz]' || texto === '[foto]')
    expect(porElAtajo, 'el modo ai no debe saltarse el procesado').toBe(false)
  })
})
