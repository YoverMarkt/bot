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
      /SUPABASE_URL.*JWT_SECRET.*BASE_URL/,
    )
  })

  it('exige secretos fuertes, HTTPS y protección de Telegram en producción', () => {
    const status = inspectEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: 'http://example.com',
      YCLOUD_WEBHOOK_SECRET: 'corto',
      TELEGRAM_BOT_TOKEN: 'telegram-token-valid',
      TELEGRAM_WEBHOOK_SECRET: 'corto',
    }))

    expect(status.missing).toEqual([])
    expect(status.invalid).toEqual(expect.arrayContaining([
      'BASE_URL (HTTPS obligatorio salvo localhost)',
      'YCLOUD_WEBHOOK_SECRET (mínimo 32 caracteres)',
      'TELEGRAM_WEBHOOK_SECRET (mínimo 32 caracteres)',
    ]))
  })

  it('acepta localhost HTTP sin exigir un secreto global de YCloud', () => {
    expect(() => assertEnvironment(validEnvironment({
      BASE_URL: 'http://127.0.0.1:3199',
    }))).not.toThrow()
  })

  it('acepta el fallback global opcional de YCloud cuando es fuerte', () => {
    expect(() => assertEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: 'https://bot.example.com',
      YCLOUD_WEBHOOK_ENDPOINT_ID: 'endpoint-global',
      YCLOUD_WEBHOOK_SECRET: 'y'.repeat(32),
    }))).not.toThrow()
  })

  it('rechaza un fallback global YCloud incompleto', () => {
    const status = inspectEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: 'https://bot.example.com',
      YCLOUD_WEBHOOK_SECRET: 'y'.repeat(32),
    }))

    expect(status.invalid).toContain(
      'YCLOUD_WEBHOOK_ENDPOINT_ID y YCLOUD_WEBHOOK_SECRET deben configurarse juntos',
    )
  })

  it('valida el formato de una versión Meta configurada manualmente', () => {
    expect(inspectEnvironment(validEnvironment({
      META_GRAPH_API_VERSION: 'v25.0/../../host',
    })).invalid).toContain('META_GRAPH_API_VERSION (formato vN.0)')

    expect(inspectEnvironment(validEnvironment({
      META_GRAPH_API_VERSION: 'v25.0',
    })).invalid).not.toContain('META_GRAPH_API_VERSION (formato vN.0)')
  })
})
