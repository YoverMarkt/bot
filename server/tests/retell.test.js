import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createRetellIntegration, buildVoicePrompt, cleanVoiceContent } = require('../dist/integrations/retell')

const business = {
  id: 'business-a',
  name: 'Negocio A',
  type: 'perfumería',
  hours: '09:00-18:00',
  address: 'Quito',
  payment_methods: 'Transferencia',
  ai_provider: 'groq',
  suspended: false,
}
const products = [{
  name: 'Perfume Floral', brand: 'Aura', price: '12.50', stock: 'Disponible',
}]

function setup(overrides = {}) {
  const database = {
    getBusinessByPhone: vi.fn().mockResolvedValue(business),
    getProducts: vi.fn().mockResolvedValue(products),
    getPolicies: vi.fn().mockResolvedValue({ bot_instructions: 'Sé amable.' }),
    saveMessage: vi.fn().mockResolvedValue({ error: null }),
    ...overrides.database,
  }
  const settings = {
    get: vi.fn().mockResolvedValue('retell-api-key'),
    ...overrides.settings,
  }
  const ai = {
    callAI: vi.fn().mockResolvedValue('**Respuesta** _limpia_ ##BOOKING##'),
    ...overrides.ai,
  }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const env = {
    NODE_ENV: 'production',
    BASE_URL: 'https://bot.example.com',
    RETELL_LLM_SECRET: 'llm-secret',
    ...overrides.env,
  }
  const now = vi.fn().mockReturnValue(1_750_000_000_000)
  const integration = createRetellIntegration({
    database, settings, ai, logger, env, now,
  })
  return { integration, database, settings, ai, logger, env, now }
}

function responseMock() {
  const response = {
    statusCode: 200,
    body: undefined,
    status: vi.fn(code => {
      response.statusCode = code
      return response
    }),
    json: vi.fn(body => {
      response.body = body
      return response
    }),
  }
  return response
}

function signature(body, key, timestamp) {
  const digest = crypto.createHmac('sha256', key)
    .update(body + timestamp).digest('hex')
  return `v=${timestamp},d=${digest}`
}

describe('integración Retell', () => {
  it('falla cerrado en producción si falta la API key', async () => {
    const current = setup({ settings: { get: vi.fn().mockResolvedValue(null) } })
    const response = responseMock()
    const next = vi.fn()

    await current.integration.verifyRetellRequest(
      { rawBody: Buffer.from('{}'), headers: {} }, response, next,
    )

    expect(response.statusCode).toBe(503)
    expect(response.body).toEqual({ error: 'Retell no configurado' })
    expect(next).not.toHaveBeenCalled()
  })

  it('valida HMAC reciente y rechaza firma inválida sin registrar secretos', async () => {
    const current = setup()
    const rawBody = '{"event":"call_ended"}'
    const next = vi.fn()
    const validResponse = responseMock()

    await current.integration.verifyRetellRequest({
      rawBody: Buffer.from(rawBody),
      headers: {
        'x-retell-signature': signature(rawBody, 'retell-api-key', current.now()),
      },
    }, validResponse, next)
    expect(next).toHaveBeenCalledTimes(1)

    const invalidResponse = responseMock()
    await current.integration.verifyRetellRequest({
      rawBody: Buffer.from(rawBody),
      headers: { 'x-retell-signature': 'v=1,d=00' },
    }, invalidResponse, vi.fn())
    expect(invalidResponse.statusCode).toBe(401)
    expect(current.logger.warn).toHaveBeenCalledWith(
      '⚠️  Retell: firma inválida — solicitud rechazada',
    )
    expect(JSON.stringify(current.logger.warn.mock.calls)).not.toContain('retell-api-key')
  })

  it('acepta el secreto LLM por query o header y rechaza longitudes distintas', () => {
    const current = setup()
    const queryNext = vi.fn()
    current.integration.verifyRetellLLMRequest({
      query: { secret: 'llm-secret' }, headers: {},
    }, responseMock(), queryNext)
    expect(queryNext).toHaveBeenCalled()

    const headerNext = vi.fn()
    current.integration.verifyRetellLLMRequest({
      query: {}, headers: { 'x-retell-llm-secret': 'llm-secret' },
    }, responseMock(), headerNext)
    expect(headerNext).toHaveBeenCalled()

    const rejected = responseMock()
    current.integration.verifyRetellLLMRequest({
      query: { secret: 'x' }, headers: {},
    }, rejected, vi.fn())
    expect(rejected.statusCode).toBe(401)
  })

  it('responde ping sin consultar datos ni IA', async () => {
    const current = setup()
    const response = responseMock()

    await current.integration.handleRetellLLM({
      body: { interaction_type: 'ping_pong' },
    }, response)

    expect(response.body).toEqual({
      response_type: 'ping_pong', timestamp: current.now(),
    })
    expect(current.database.getBusinessByPhone).not.toHaveBeenCalled()
    expect(current.ai.callAI).not.toHaveBeenCalled()
  })

  it('resuelve la llamada por número destino y mantiene todas las lecturas en ese tenant', async () => {
    const current = setup()
    const response = responseMock()
    const transcript = [
      { role: 'agent', content: '¿Cómo puedo ayudar?' },
      { role: 'user', content: 'Quiero un perfume' },
    ]

    await current.integration.handleRetellLLM({ body: {
      response_id: 7,
      call: { to_number: '+593 999 999 999', from_number: '+593 990 000 001' },
      transcript,
    } }, response)

    expect(current.database.getBusinessByPhone).toHaveBeenCalledWith('593999999999')
    expect(current.database.getProducts).toHaveBeenCalledWith('business-a')
    expect(current.database.getPolicies).toHaveBeenCalledWith('business-a')
    expect(current.ai.callAI).toHaveBeenCalledWith(
      expect.stringContaining('asistente telefónico de "Negocio A"'),
      [{ role: 'assistant', content: '¿Cómo puedo ayudar?' }],
      'Quiero un perfume',
      'groq',
    )
    expect(current.database.saveMessage).toHaveBeenNthCalledWith(
      1, 'business-a', 'voice_593990000001', 'user', 'Quiero un perfume',
    )
    expect(current.database.saveMessage).toHaveBeenNthCalledWith(
      2, 'business-a', 'voice_593990000001', 'assistant', 'Respuesta limpia',
    )
    expect(response.body).toEqual({
      response_type: 'response',
      response_id: 7,
      content: 'Respuesta limpia',
      content_complete: true,
    })
  })

  it('no carga catálogo si el negocio no existe o está suspendido', async () => {
    const missing = setup({
      database: { getBusinessByPhone: vi.fn().mockResolvedValue(null) },
    })
    const missingResponse = responseMock()
    await missing.integration.handleRetellLLM({
      body: { call: { to_number: '+593999999999' } },
    }, missingResponse)
    expect(missing.database.getProducts).not.toHaveBeenCalled()
    expect(missingResponse.body.content).toContain('no pude identificar el negocio')

    const suspended = setup({
      database: {
        getBusinessByPhone: vi.fn().mockResolvedValue({ ...business, suspended: true }),
      },
    })
    const suspendedResponse = responseMock()
    await suspended.integration.handleRetellLLM({
      body: { call: { to_number: '+593999999999' } },
    }, suspendedResponse)
    expect(suspended.database.getProducts).not.toHaveBeenCalled()
    expect(suspendedResponse.body.content).toContain('pago pendiente')
  })

  it('devuelve respuesta segura si falla el proveedor de IA', async () => {
    const current = setup({
      ai: { callAI: vi.fn().mockRejectedValue(new Error('proveedor caído')) },
    })
    const response = responseMock()

    await current.integration.handleRetellLLM({ body: {
      call: { to_number: '+593999999999', from_number: '+593990000001' },
      transcript: [{ role: 'user', content: 'Hola' }],
    } }, response)

    expect(response.body.content).toBe(
      'Disculpa el inconveniente. ¿Puedes repetir tu consulta?',
    )
    expect(current.logger.error).toHaveBeenCalledWith(
      '❌ Retell LLM:', 'proveedor caído',
    )
  })

  it('registra eventos sin exponer el payload completo', () => {
    const current = setup()
    const response = responseMock()

    current.integration.handleRetellCallEvent({ body: {
      event: 'call_ended',
      call: { call_id: 'call-a', call_duration: 42 },
    } }, response)

    expect(response.body).toEqual({ ok: true })
    expect(current.logger.log).toHaveBeenCalledWith(
      '📞 [Retell] Evento: call_ended — call-a',
    )
    expect(current.logger.log).toHaveBeenCalledWith(
      '📞 [Retell] Llamada terminada: duración 42s',
    )
  })

  it('conserva prompt y limpieza de voz sin etiquetas internas', () => {
    expect(buildVoicePrompt(business, products, { bot_instructions: 'Sé amable.' }))
      .toContain('Perfume Floral (Aura): $12.50')
    expect(cleanVoiceContent('**Hola** _mundo_ ##BOOKING##')).toBe('Hola mundo')
  })

  it('enlaza Retell directamente con servicios tipados', () => {
    const service = fs.readFileSync(new URL('../src/integrations/retell.ts', import.meta.url), 'utf8')

    expect(service).toContain("database: require('../db')")
    expect(service).toContain("ai: require('../services/ai')")
    expect(service).not.toContain("require('./bot')")
    expect(service).not.toContain('@ts-nocheck')
    expect(service).not.toMatch(/retell[_-](api[_-])?key\s*[:=]\s*['"][^'"]+['"]/i)
  })
})
