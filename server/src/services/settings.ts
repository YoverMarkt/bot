import { createClient } from '@supabase/supabase-js'
import path from 'node:path'

require('dotenv').config({ path: path.join(__dirname, '../../.env') })

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY) as string,
)

export const ALLOWED_KEYS = [
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'groq_api_key',
  'deepseek_api_key',
  'ai_provider',
  'telegram_bot_token',
  'cloudinary_cloud_name',
  'cloudinary_api_key',
  'cloudinary_api_secret',
  // ── El número de la plataforma (Umbani) ──────────────────────────────
  // Con un solo número para todo el marketplace, estas credenciales NO
  // pueden vivir en la ficha de un negocio: el número no es de ningún
  // local. Guardarlo en uno obligaría a elegir a dedo un negocio
  // «portador», y el enrutado dependería de a cuál se mire primero —
  // que es justo lo que `businesses_marketplace_sin_canal_check`
  // prohíbe desde el 2026-08-20.
  //
  // ⚠️ `platform_webhook_secret` es lo que valida la firma de un mensaje
  // que llega SIN negocio que resolver. Sin él, ese camino no tendría con
  // qué comprobar la firma, y aceptar sin comprobar convertiría el webhook
  // en un buzón abierto.
  'platform_ycloud_api_key',
  'platform_ycloud_number',
  'platform_webhook_secret',
  'platform_webhook_endpoint_id',
] as const

type AllowedKey = typeof ALLOWED_KEYS[number]
type SettingsRecord = Partial<Record<AllowedKey, string | null>>

let cache: SettingsRecord = {}
let cacheAt = 0
const CACHE_TTL = 60_000

async function loadAll(): Promise<SettingsRecord> {
  if (Date.now() - cacheAt < CACHE_TTL) return cache
  const { data, error } = await supabase.from('server_settings').select('key, value')
  if (error) throw new Error(error.message)

  const loaded: SettingsRecord = {}
  for (const row of data || []) {
    if (ALLOWED_KEYS.includes(row.key as AllowedKey)) {
      loaded[row.key as AllowedKey] = row.value
    }
  }
  cache = loaded
  cacheAt = Date.now()
  return cache
}

export async function get(key: AllowedKey): Promise<string | null> {
  const all = await loadAll()
  return all[key] || process.env[key.toUpperCase()] || null
}

export async function setMany(pairs: Record<string, unknown>): Promise<void> {
  const rows = Object.entries(pairs)
    .filter(([key]) => ALLOWED_KEYS.includes(key as AllowedKey))
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string' && value ? value : null,
      updated_at: new Date().toISOString(),
    }))

  if (!rows.length) return
  const { error } = await supabase
    .from('server_settings')
    .upsert(rows, { onConflict: 'key' })
  if (error) throw new Error(error.message)
  cacheAt = 0
}

export async function getAll(): Promise<SettingsRecord> {
  return loadAll()
}
