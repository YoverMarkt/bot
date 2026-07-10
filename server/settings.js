// @ts-check
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY)

// Claves válidas que se pueden guardar desde el admin
const ALLOWED_KEYS = [
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'groq_api_key',
  'deepseek_api_key',
  'ai_provider',        // 'claude' | 'openai' | 'gemini' | 'groq' | 'deepseek'
  'telegram_bot_token',
  'ycloud_verify_token',
  'retell_api_key',
  // Cloudinary — media (imágenes + videos) de productos. Una sola cuenta para todo el SaaS.
  'cloudinary_cloud_name',
  'cloudinary_api_key',
  'cloudinary_api_secret',
]

// Cache en memoria para no ir a la BD en cada mensaje
let cache = {}
let cacheAt = 0
const CACHE_TTL = 60_000 // 1 minuto

async function loadAll() {
  if (Date.now() - cacheAt < CACHE_TTL) return cache
  const { data } = await sb.from('server_settings').select('key, value')
  cache = {}
  if (data) data.forEach(r => { cache[r.key] = r.value })
  cacheAt = Date.now()
  return cache
}

async function get(key) {
  const all = await loadAll()
  // DB tiene prioridad; si no hay, usa .env como fallback
  return all[key] || process.env[key.toUpperCase()] || null
}

async function setMany(pairs) {
  const rows = Object.entries(pairs)
    .filter(([k]) => ALLOWED_KEYS.includes(k))
    .map(([key, value]) => ({ key, value: value || null, updated_at: new Date().toISOString() }))

  if (!rows.length) return
  await sb.from('server_settings').upsert(rows, { onConflict: 'key' })
  cacheAt = 0 // invalidar cache
}

async function getAll() {
  return loadAll()
}

module.exports = { get, setMany, getAll, ALLOWED_KEYS }
