import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import axios from 'axios'

type SettingKey = 'ai_provider' | 'groq_api_key' | 'gemini_api_key'
  | 'openai_api_key' | 'anthropic_api_key' | 'deepseek_api_key'
type TranscriptionEngine = 'groq' | 'gemini' | 'openai'

interface SettingsService {
  get(key: SettingKey): Promise<string | null>
}

interface EmbeddingResult {
  error?: { message?: string } | null
}

interface DatabaseService {
  setProductEmbedding(
    businessId: string,
    productId: string,
    embedding: number[],
  ): Promise<EmbeddingResult>
}

export interface HistoryMessage {
  role: string
  content: string
}

export interface ProductForIndex {
  id: string
  business_id: string
  name?: string | null
  brand?: string | null
  description?: string | null
  tags?: string[] | null
}

interface TranscriptionKeys {
  groq: string | null
  gemini: string | null
  openai: string | null
}

const settings = require('./settings') as SettingsService
const db = require('../db') as DatabaseService

function selectTranscriptionEngine(
  provider: string | null,
  keys: TranscriptionKeys,
): TranscriptionEngine | null {
  let engine: TranscriptionEngine | null = (
    provider === 'groq' || provider === 'gemini' || provider === 'openai'
      ? provider
      : null
  )
  if (engine === 'groq' && !keys.groq) engine = null
  if (engine === 'gemini' && !keys.gemini) engine = null
  if (engine === 'openai' && !keys.openai) engine = null
  if (!engine) engine = keys.groq ? 'groq' : keys.openai ? 'openai' : keys.gemini ? 'gemini' : null
  return engine
}

// Claude no transcribe audio: se elige automáticamente un proveedor compatible.
async function transcribeAudio(buffer: Buffer, filename = 'audio.ogg'): Promise<string> {
  const provider = await settings.get('ai_provider') || 'openai'
  const groqKey = await settings.get('groq_api_key')
  const geminiKey = await settings.get('gemini_api_key')
  const openaiKey = await settings.get('openai_api_key') || process.env.OPENAI_API_KEY || null
  const engine = selectTranscriptionEngine(provider, {
    groq: groqKey,
    gemini: geminiKey,
    openai: openaiKey,
  })
  if (!engine) {
    throw new Error('No hay una IA con transcripción de audio (configura Groq, OpenAI o Gemini)')
  }

  if (engine === 'groq') {
    const groq = new OpenAI({ apiKey: groqKey as string, baseURL: 'https://api.groq.com/openai/v1' })
    const file = await OpenAI.toFile(buffer, filename)
    const response = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      language: 'es',
    })
    return response.text?.trim() || ''
  }

  if (engine === 'gemini') {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      { contents: [{ parts: [
        { text: 'Transcribe este audio a texto en español. Devuelve SOLO la transcripción, sin comentarios ni comillas.' },
        { inline_data: { mime_type: 'audio/ogg', data: buffer.toString('base64') } },
      ] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
    )
    return (response.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
  }

  const openai = new OpenAI({ apiKey: openaiKey as string })
  const file = await OpenAI.toFile(buffer, filename)
  const response = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'es',
  })
  return response.text?.trim() || ''
}

async function identifyImage(dataUrl: string): Promise<string> {
  const provider = await settings.get('ai_provider') || 'openai'
  const prompt = 'Eres experto en productos (perfumes, ropa, artículos). Identifica el producto principal de la imagen. Responde SOLO con la marca y el nombre (ejemplos: "Dior Sauvage", "Carolina Herrera 212 VIP", "Nike Air Force 1"). Si no puedes identificarlo con razonable certeza, responde EXACTAMENTE: NO_IDENTIFICADO'

  if (provider === 'groq') {
    const apiKey = await settings.get('groq_api_key')
    if (!apiKey) throw new Error('Falta Groq API Key para analizar imágenes')
    const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' })
    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 60,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }],
    })
    return (response.choices[0].message.content || '').trim()
  }

  if (provider === 'gemini') {
    const apiKey = await settings.get('gemini_api_key')
    if (!apiKey) throw new Error('Falta Gemini API Key para analizar imágenes')
    const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) || []
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: match[1] || 'image/jpeg', data: match[2] || '' } },
      ] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
    )
    return (response.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
  }

  if (provider === 'claude') {
    const apiKey = await settings.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Falta Anthropic API Key para analizar imágenes')
    const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) || []
    const mediaType = (match[1] || 'image/jpeg') as 'image/jpeg'
    const claude = new Anthropic({ apiKey })
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] || '' } },
      ] }],
    })
    const block = response.content[0]
    return (block && 'text' in block ? block.text : '').trim()
  }

  const apiKey = await settings.get('openai_api_key') || process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Falta OpenAI API Key para analizar imágenes')
  const openai = new OpenAI({ apiKey })
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 60,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }],
  })
  return (response.choices[0].message.content || '').trim()
}

async function embedText(text: string): Promise<number[]> {
  const apiKey = await settings.get('openai_api_key') || process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Falta OpenAI API Key para generar embeddings')
  const openai = new OpenAI({ apiKey })
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000),
  })
  return response.data[0].embedding
}

function productText(product: ProductForIndex): string {
  return [
    product.name,
    product.brand,
    product.description,
    (product.tags || []).join(' '),
  ].filter(Boolean).join(' — ')
}

async function indexProduct(product: ProductForIndex): Promise<boolean> {
  try {
    const embedding = await embedText(productText(product))
    const { error } = await db.setProductEmbedding(product.business_id, product.id, embedding)
    if (error) throw new Error(error.message || 'No se pudo guardar el embedding')
    return true
  } catch (error) {
    console.error('❌ indexProduct:', error instanceof Error ? error.message : error)
    return false
  }
}

function normalizeHistory(message: HistoryMessage): ChatCompletionMessageParam {
  return {
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
  }
}

async function callAI(
  systemPrompt: string,
  history: HistoryMessage[],
  userMessage: string,
  businessProvider: string | null = null,
): Promise<string | null> {
  const provider = businessProvider || await settings.get('ai_provider') || 'claude'

  if (provider === 'groq' || provider === 'deepseek' || provider === 'openai') {
    const keyName = provider === 'groq'
      ? 'groq_api_key'
      : provider === 'deepseek' ? 'deepseek_api_key' : 'openai_api_key'
    const apiKey = await settings.get(keyName)
    const providerName = provider === 'groq' ? 'Groq' : provider === 'deepseek' ? 'DeepSeek' : 'OpenAI'
    if (!apiKey) throw new Error(`Falta ${providerName} API Key en Configuración del servidor`)
    const client = new OpenAI({
      apiKey,
      ...(provider === 'groq' ? { baseURL: 'https://api.groq.com/openai/v1' } : {}),
      ...(provider === 'deepseek' ? { baseURL: 'https://api.deepseek.com' } : {}),
    })
    const model = provider === 'groq'
      ? 'llama-3.3-70b-versatile'
      : provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'
    const response = await client.chat.completions.create({
      model,
      max_tokens: provider === 'openai' ? 500 : 800,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map(normalizeHistory),
        { role: 'user', content: userMessage },
      ],
    })
    return response.choices[0].message.content
  }

  if (provider === 'gemini') {
    const apiKey = await settings.get('gemini_api_key')
    if (!apiKey) throw new Error('Falta Gemini API Key en Configuración del servidor')
    const contents = [
      ...history.map(message => ({
        role: message.role === 'user' ? 'user' : 'model',
        parts: [{ text: message.content }],
      })),
      { role: 'user', parts: [{ text: userMessage }] },
    ]
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 800 },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
    )
    return (response.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
  }

  const apiKey = await settings.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('Falta Anthropic API Key')
  const claude = new Anthropic({ apiKey })
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: [
      ...history.map(message => ({
        role: message.role === 'user' ? 'user' as const : 'assistant' as const,
        content: message.content,
      })),
      { role: 'user', content: userMessage },
    ],
  })
  const block = response.content[0]
  return block && 'text' in block ? block.text : ''
}

export {
  callAI,
  embedText,
  identifyImage,
  indexProduct,
  normalizeHistory,
  selectTranscriptionEngine,
  transcribeAudio,
}
