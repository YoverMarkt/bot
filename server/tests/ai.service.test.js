import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const settings = require('../dist/services/settings')
const db = require('../dist/db')
const ai = require('../dist/services/ai')
const axios = require('axios')

let originalOpenAiKey
let originalAnthropicKey

beforeEach(() => {
  originalOpenAiKey = process.env.OPENAI_API_KEY
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalOpenAiKey
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey
})

describe('servicio multi-proveedor de IA', () => {
  it('selecciona el motor de audio activo y conserva el orden de respaldo', () => {
    expect(ai.selectTranscriptionEngine('gemini', {
      groq: 'groq-key', gemini: 'gemini-key', openai: 'openai-key',
    })).toBe('gemini')
    expect(ai.selectTranscriptionEngine('claude', {
      groq: 'groq-key', gemini: 'gemini-key', openai: 'openai-key',
    })).toBe('groq')
    expect(ai.selectTranscriptionEngine('groq', {
      groq: null, gemini: 'gemini-key', openai: 'openai-key',
    })).toBe('openai')
    expect(ai.selectTranscriptionEngine('openai', {
      groq: null, gemini: null, openai: null,
    })).toBeNull()
  })

  it('normaliza mensajes del dueño como mensajes del asistente', () => {
    expect(ai.normalizeHistory({ role: 'user', content: 'hola' })).toEqual({
      role: 'user', content: 'hola',
    })
    expect(ai.normalizeHistory({ role: 'owner', content: 'respuesta humana' })).toEqual({
      role: 'assistant', content: 'respuesta humana',
    })
  })

  it('falla antes de llamar servicios externos cuando faltan credenciales', async () => {
    vi.spyOn(settings, 'get').mockResolvedValue(null)

    await expect(ai.transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'No hay una IA con transcripción de audio',
    )
    await expect(ai.identifyImage('data:image/jpeg;base64,AA==')).rejects.toThrow(
      'Falta OpenAI API Key para analizar imágenes',
    )
    await expect(ai.embedText('producto')).rejects.toThrow(
      'Falta OpenAI API Key para generar embeddings',
    )
    await expect(ai.callAI('sistema', [], 'hola')).rejects.toThrow(
      'Falta Anthropic API Key',
    )
  })

  it('respeta el proveedor del negocio antes de la configuración global', async () => {
    const getSetting = vi.spyOn(settings, 'get').mockImplementation(async key => (
      key === 'ai_provider' ? 'openai' : null
    ))

    await expect(ai.callAI('sistema', [], 'hola', 'deepseek')).rejects.toThrow(
      'Falta DeepSeek API Key en Configuración del servidor',
    )
    expect(getSetting).toHaveBeenCalledWith('deepseek_api_key')
    expect(getSetting).not.toHaveBeenCalledWith('ai_provider')
  })

  it('conserva el contrato de Gemini y normaliza al dueño como model', async () => {
    vi.spyOn(settings, 'get').mockImplementation(async key => (
      key === 'gemini_api_key' ? 'gemini-test-key' : null
    ))
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: '  respuesta  ' }] } }] },
    })

    await expect(ai.callAI(
      'prompt del negocio',
      [{ role: 'owner', content: 'mensaje humano' }],
      'hola',
      'gemini',
    )).resolves.toBe('respuesta')

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('gemini-test-key'),
      expect.objectContaining({
        systemInstruction: { parts: [{ text: 'prompt del negocio' }] },
        contents: [
          { role: 'model', parts: [{ text: 'mensaje humano' }] },
          { role: 'user', parts: [{ text: 'hola' }] },
        ],
        generationConfig: { maxOutputTokens: 800 },
      }),
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
    )
  })

  it('no intenta guardar embeddings cuando no pudo generarlos', async () => {
    vi.spyOn(settings, 'get').mockResolvedValue(null)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const setEmbedding = vi.spyOn(db, 'setProductEmbedding')

    await expect(ai.indexProduct({
      id: 'product-a', business_id: 'business-a', name: 'Producto',
    })).resolves.toBe(false)
    expect(setEmbedding).not.toHaveBeenCalled()
  })

  it('mantiene modelos y carga segura de credenciales', () => {
    const service = fs.readFileSync(new URL('../src/services/ai.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain("'llama-3.3-70b-versatile'")
    expect(service).toContain("'deepseek-chat'")
    expect(service).toContain("'gpt-4o-mini'")
    expect(service).toContain("model: 'text-embedding-3-small'")
    expect(service).toContain("settings.get('openai_api_key')")
    expect(service).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/)
    expect(service).not.toContain('@ts-nocheck')
    expect(entry).toContain("require('./ai')")
  })
})
