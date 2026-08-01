import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  DEFAULT_SILENCE_HOURS,
  diagnoseChannels,
  getRecentWebhookFailures,
  recordWebhookFailure,
  resetWebhookFailures,
} = require('../dist/services/channel-health')

const ahora = new Date('2026-08-01T12:00:00.000Z')
const haceHoras = horas => new Date(ahora.getTime() - horas * 3_600_000).toISOString()

const negocio = (extra = {}) => ({
  id: 'biz-1',
  name: 'Hostal Vista Andina',
  active: true,
  suspended: false,
  whatsapp_provider: 'ycloud',
  ...extra,
})

describe('salud del canal de entrada', () => {
  beforeEach(() => resetWebhookFailures())

  it('marca ok cuando entró un mensaje dentro del umbral', () => {
    const report = diagnoseChannels({
      businesses: [negocio()],
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(2) }],
      now: ahora,
    })
    expect(report.businesses[0].status).toBe('ok')
    expect(report.businesses[0].hoursSinceLastInbound).toBe(2)
    expect(report.alert).toBe(false)
  })

  it('alerta cuando el canal lleva más horas de las permitidas en silencio', () => {
    const report = diagnoseChannels({
      businesses: [negocio()],
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(30) }],
      now: ahora,
    })
    expect(report.businesses[0].status).toBe('silencio')
    expect(report.businesses[0].hoursSinceLastInbound).toBe(30)
    expect(report.alert).toBe(true)
  })

  it('usa 12 horas por defecto y respeta el umbral recibido', () => {
    expect(DEFAULT_SILENCE_HOURS).toBe(12)
    const enSilencio = diagnoseChannels({
      businesses: [negocio()],
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(13) }],
      now: ahora,
    })
    expect(enSilencio.businesses[0].status).toBe('silencio')

    const tolerante = diagnoseChannels({
      businesses: [negocio()],
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(13) }],
      now: ahora,
      silenceHours: 24,
    })
    expect(tolerante.businesses[0].status).toBe('ok')
    expect(tolerante.alert).toBe(false)
  })

  it('distingue el negocio que nunca recibió un mensaje', () => {
    const report = diagnoseChannels({
      businesses: [negocio()],
      activity: [{ businessId: 'biz-1', lastInboundAt: null }],
      now: ahora,
    })
    expect(report.businesses[0].status).toBe('nunca_recibio')
    expect(report.alert).toBe(true)
  })

  it('no alerta por negocios sin canal configurado todavía', () => {
    const report = diagnoseChannels({
      businesses: [negocio({ whatsapp_provider: null, telegram_bot_token: null })],
      activity: [],
      now: ahora,
    })
    expect(report.businesses[0].status).toBe('sin_canal')
    expect(report.alert).toBe(false)
  })

  // El listado del panel solo trae `whatsapp_number`. Dar por "sin canal" a un
  // negocio en marcha apagaría la alerta justo para quien más la necesita.
  it('reconoce el canal aunque el listado solo traiga whatsapp_number', () => {
    const report = diagnoseChannels({
      businesses: [{
        id: 'biz-1',
        name: 'Hostal Vista Andina',
        active: true,
        suspended: false,
        whatsapp_number: '+593991716574',
      }],
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(40) }],
      now: ahora,
    })
    expect(report.businesses[0].status).toBe('silencio')
    expect(report.alert).toBe(true)
  })

  it('si ya entró un mensaje, el canal existe aunque no venga ninguna columna', () => {
    const report = diagnoseChannels({
      businesses: [{ id: 'biz-1', name: 'Sin columnas', active: true }],
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(1) }],
      now: ahora,
    })
    expect(report.businesses[0].status).toBe('ok')
  })

  it('alerta si un negocio con número configurado nunca recibió nada', () => {
    const report = diagnoseChannels({
      businesses: [negocio({ whatsapp_number: '+593991716574' })],
      activity: [{ businessId: 'biz-1', lastInboundAt: null }],
      now: ahora,
    })
    expect(report.businesses[0].status).toBe('nunca_recibio')
    expect(report.alert).toBe(true)
  })

  it('omite negocios inactivos o suspendidos: su silencio es esperado', () => {
    const report = diagnoseChannels({
      businesses: [
        negocio({ id: 'biz-inactivo', active: false }),
        negocio({ id: 'biz-suspendido', suspended: true }),
      ],
      activity: [],
      now: ahora,
    })
    expect(report.businesses).toHaveLength(0)
    expect(report.alert).toBe(false)
  })

  it('aísla el diagnóstico de cada negocio por su business_id', () => {
    const report = diagnoseChannels({
      businesses: [negocio({ id: 'biz-a' }), negocio({ id: 'biz-b' })],
      activity: [
        { businessId: 'biz-a', lastInboundAt: haceHoras(1) },
        { businessId: 'biz-b', lastInboundAt: haceHoras(40) },
      ],
      now: ahora,
    })
    const porId = Object.fromEntries(report.businesses.map(b => [b.businessId, b.status]))
    expect(porId['biz-a']).toBe('ok')
    expect(porId['biz-b']).toBe('silencio')
  })

  it('registra los fallos del webhook del más reciente al más antiguo', () => {
    recordWebhookFailure('ycloud', 401, 'Firma inválida')
    recordWebhookFailure('ycloud', 503, 'No se pudo encolar el mensaje')
    const fallos = getRecentWebhookFailures()
    expect(fallos).toHaveLength(2)
    expect(fallos[0].status).toBe(503)
    expect(fallos[0].reason).toContain('encolar')
    expect(fallos[1].status).toBe(401)
  })

  it('no deja crecer el registro de fallos sin límite', () => {
    for (let i = 0; i < 80; i += 1) recordWebhookFailure('ycloud', 503, `fallo ${i}`)
    expect(getRecentWebhookFailures(100).length).toBeLessThanOrEqual(50)
  })

  it('incluye los fallos recientes en el reporte', () => {
    recordWebhookFailure('ycloud', 503, 'No se pudo encolar el mensaje')
    const report = diagnoseChannels({
      businesses: [negocio()],
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(1) }],
      now: ahora,
    })
    expect(report.recentFailures).toHaveLength(1)
    expect(report.recentFailures[0].status).toBe(503)
  })
})
