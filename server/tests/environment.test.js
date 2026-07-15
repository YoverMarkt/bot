import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { assertEnvironment, inspectEnvironment } = require('../dist/config/environment')

const validEnvironment = (overrides = {}) => ({
  SUPABASE_URL: 'https://demo.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  JWT_SECRET: 'j'.repeat(48),
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'a'.repeat(16),
  ...overrides,
})

describe('configuración de entorno', () => {
  it('permite desarrollo sin dominio ni secretos de webhook', () => {
    expect(assertEnvironment(validEnvironment())).toMatchObject({
      production: false,
      missing: [],
      invalid: [],
    })
  })

  it('falla cerrado cuando falta configuración crítica', () => {
    expect(() => assertEnvironment({ NODE_ENV: 'production' })).toThrow(
      /SUPABASE_URL.*JWT_SECRET.*BASE_URL.*WEBHOOK_SECRET/,
    )
  })

  it('exige secretos fuertes, HTTPS y protección de Telegram en producción', () => {
    const status = inspectEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: 'http://example.com',
      WEBHOOK_SECRET: 'corto',
      TELEGRAM_BOT_TOKEN: 'telegram-token-valid',
      TELEGRAM_WEBHOOK_SECRET: 'corto',
    }))

    expect(status.missing).toEqual([])
    expect(status.invalid).toEqual(expect.arrayContaining([
      'BASE_URL (HTTPS obligatorio salvo localhost)',
      'WEBHOOK_SECRET (mínimo 32 caracteres)',
      'TELEGRAM_WEBHOOK_SECRET (mínimo 32 caracteres)',
    ]))
  })

  it('acepta localhost HTTP para smoke tests controlados', () => {
    expect(() => assertEnvironment(validEnvironment({
      BASE_URL: 'http://127.0.0.1:3199',
      WEBHOOK_SECRET: 'w'.repeat(32),
    }))).not.toThrow()
  })
})
