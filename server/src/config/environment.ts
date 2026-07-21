import { validMetaGraphApiVersion } from './meta-graph'

export interface EnvironmentStatus {
  production: boolean
  missing: string[]
  invalid: string[]
  recommendedMissing: string[]
}

const ALWAYS_REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'JWT_SECRET',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
] as const

const PRODUCTION_REQUIRED = ['BASE_URL'] as const

const hasValue = (env: NodeJS.ProcessEnv, key: string): boolean => (
  typeof env[key] === 'string' && Boolean(env[key]?.trim())
)

export function isProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production'
    || hasValue(env, 'BASE_URL')
    || hasValue(env, 'RAILWAY_ENVIRONMENT')
    || hasValue(env, 'RAILWAY_ENVIRONMENT_NAME')
}

function validBaseUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value || '')
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    return url.protocol === 'https:' || (local && url.protocol === 'http:')
  } catch {
    return false
  }
}

export function inspectEnvironment(env: NodeJS.ProcessEnv): EnvironmentStatus {
  const production = isProductionEnvironment(env)
  const required: string[] = [...ALWAYS_REQUIRED]
  if (production) required.push(...PRODUCTION_REQUIRED)
  if (production && hasValue(env, 'TELEGRAM_BOT_TOKEN')) {
    required.push('TELEGRAM_WEBHOOK_SECRET')
  }

  const missing = required.filter(key => !hasValue(env, key))
  const invalid: string[] = []
  if (hasValue(env, 'JWT_SECRET') && (env.JWT_SECRET?.trim().length || 0) < 32) {
    invalid.push('JWT_SECRET (mínimo 32 caracteres)')
  }
  if (hasValue(env, 'ADMIN_EMAIL') && !/^\S+@\S+\.\S+$/.test(env.ADMIN_EMAIL || '')) {
    invalid.push('ADMIN_EMAIL (correo inválido)')
  }
  if (hasValue(env, 'ADMIN_PASSWORD') && (env.ADMIN_PASSWORD?.length || 0) < 12) {
    invalid.push('ADMIN_PASSWORD (mínimo 12 caracteres)')
  }
  if (production && hasValue(env, 'BASE_URL') && !validBaseUrl(env.BASE_URL)) {
    invalid.push('BASE_URL (HTTPS obligatorio salvo localhost)')
  }
  if (hasValue(env, 'META_GRAPH_API_VERSION')
    && !validMetaGraphApiVersion(env.META_GRAPH_API_VERSION)) {
    invalid.push('META_GRAPH_API_VERSION (formato vN.0)')
  }
  if (production && hasValue(env, 'YCLOUD_WEBHOOK_SECRET')
    && (env.YCLOUD_WEBHOOK_SECRET?.length || 0) < 32) {
    invalid.push('YCLOUD_WEBHOOK_SECRET (mínimo 32 caracteres)')
  }
  if (production && hasValue(env, 'YCLOUD_WEBHOOK_ENDPOINT_ID')
    !== hasValue(env, 'YCLOUD_WEBHOOK_SECRET')) {
    invalid.push('YCLOUD_WEBHOOK_ENDPOINT_ID y YCLOUD_WEBHOOK_SECRET deben configurarse juntos')
  }
  if (production && hasValue(env, 'TELEGRAM_WEBHOOK_SECRET')
    && (env.TELEGRAM_WEBHOOK_SECRET?.length || 0) < 32) {
    invalid.push('TELEGRAM_WEBHOOK_SECRET (mínimo 32 caracteres)')
  }

  const recommended = production
    ? ['META_VERIFY_TOKEN', 'META_APP_SECRET']
    : ['BASE_URL']

  return {
    production,
    missing,
    invalid,
    recommendedMissing: recommended.filter(key => !hasValue(env, key)),
  }
}

export function assertEnvironment(env: NodeJS.ProcessEnv): EnvironmentStatus {
  const status = inspectEnvironment(env)
  if (status.missing.length || status.invalid.length) {
    const details = [
      status.missing.length ? `faltan: ${status.missing.join(', ')}` : '',
      status.invalid.length ? `inválidas: ${status.invalid.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    throw new Error(`Configuración de entorno insegura — ${details}`)
  }
  return status
}
