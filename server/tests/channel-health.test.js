import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  DEFAULT_SILENCE_HOURS,
  diagnoseChannels,
  diagnosePlatformChannel,
  getRecentWebhookFailures,
  recordWebhookFailure,
  resetWebhookFailures,
  tieneCanalPropio,
} = require('../dist/services/channel-health')

const ahora = new Date('2026-08-01T12:00:00.000Z')
const haceHoras = horas => new Date(ahora.getTime() - horas * 3_600_000).toISOString()

// ⚠️ `whatsapp_provider: 'ycloud'` = canal PROPIO. El semáforo por negocio
// sigue existiendo para quien lo tenga, así que estas pruebas siguen fijando lo
// mismo que fijaban. Un local del marketplace se diagnostica aparte: ver el
// bloque «el número de la plataforma» al final.
const negocio = (extra = {}) => ({
  id: 'biz-1',
  name: 'Hostal Vista Andina',
  active: true,
  suspended: false,
  whatsapp_provider: 'ycloud',
  ...extra,
})

/** Un canal de plataforma sano, para que no interfiera con lo que se mide. */
const plataformaSana = { configured: true, lastInboundAt: '2026-08-01T11:30:00.000Z' }

describe('salud del canal de entrada', () => {
  beforeEach(() => resetWebhookFailures())

  it('marca ok cuando entró un mensaje dentro del umbral', () => {
    const report = diagnoseChannels({
      businesses: [negocio()],
      platform: plataformaSana,
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
      platform: plataformaSana,
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
      platform: plataformaSana,
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(13) }],
      now: ahora,
    })
    expect(enSilencio.businesses[0].status).toBe('silencio')

    const tolerante = diagnoseChannels({
      businesses: [negocio()],
      platform: plataformaSana,
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
      platform: plataformaSana,
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
      platform: plataformaSana,
      activity: [{ businessId: 'biz-1', lastInboundAt: haceHoras(1) }],
      now: ahora,
    })
    expect(report.recentFailures).toHaveLength(1)
    expect(report.recentFailures[0].status).toBe(503)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL NÚMERO DE LA PLATAFORMA
// ═══════════════════════════════════════════════════════════════════════════
//
// Fija la corrección del 2026-08-23, y sustituye a la decisión anterior: un
// semáforo POR LOCAL. Con un solo número esa pregunta no tiene respuesta en la
// cola —los entrantes del marketplace se guardan con `business_id` NULL—, así
// que cada local se congelaba en su último mensaje y a las 12 h gritaba
// «silencio» para siempre. La alarma que grita siempre no la mira nadie.

describe('el número de la plataforma', () => {
  beforeEach(() => resetWebhookFailures())

  it('está ok mientras siga entrando algo', () => {
    const estado = diagnosePlatformChannel(
      { configured: true, lastInboundAt: haceHoras(2) }, ahora, DEFAULT_SILENCE_HOURS,
    )
    expect(estado.status).toBe('ok')
    expect(estado.hoursSinceLastInbound).toBe(2)
  })

  it('cae en silencio pasadas las horas del umbral', () => {
    const estado = diagnosePlatformChannel(
      { configured: true, lastInboundAt: haceHoras(13) }, ahora, DEFAULT_SILENCE_HOURS,
    )
    expect(estado.status).toBe('silencio')
  })

  it('distingue el que nunca recibió del que no está configurado', () => {
    expect(diagnosePlatformChannel(
      { configured: true, lastInboundAt: null }, ahora, DEFAULT_SILENCE_HOURS,
    ).status).toBe('nunca_recibio')
    expect(diagnosePlatformChannel(
      { configured: false, lastInboundAt: null }, ahora, DEFAULT_SILENCE_HOURS,
    ).status).toBe('sin_canal')
  })

  // Sin número puesto no hay canal que pueda estar mudo: alertar aquí sería un
  // aviso permanente en una instalación recién montada. De eso avisa el
  // vigilante de credenciales, que sí sabe si hay locales esperándolo.
  it('no alerta por un número que todavía no se configuró', () => {
    const report = diagnoseChannels({
      businesses: [],
      activity: [],
      platform: { configured: false, lastInboundAt: null },
      now: ahora,
    })
    expect(report.platform.status).toBe('sin_canal')
    expect(report.alert).toBe(false)
  })

  // Lo que hace que esta alarma pese más que las de antes: si este número calla,
  // callan TODOS los locales a la vez, aunque la lista de negocios vaya vacía.
  it('alerta aunque no haya ni un negocio con canal propio', () => {
    const report = diagnoseChannels({
      businesses: [],
      activity: [],
      platform: { configured: true, lastInboundAt: haceHoras(30) },
      now: ahora,
    })
    expect(report.platform.status).toBe('silencio')
    expect(report.alert).toBe(true)
  })
})

describe('un local del marketplace no tiene canal propio que vigilar', () => {
  beforeEach(() => resetWebhookFailures())

  const delMarketplace = (extra = {}) => ({
    id: 'biz-mkt',
    name: 'Monster Pizza',
    active: true,
    suspended: false,
    whatsapp_provider: 'marketplace',
    whatsapp_number: null,
    ...extra,
  })

  it('tieneCanalPropio dice que no', () => {
    expect(tieneCanalPropio(delMarketplace())).toBe(false)
    expect(tieneCanalPropio(negocio())).toBe(true)
  })

  // LA REGRESIÓN. Hasta el 2026-08-23 este local salía en la lista y, como sus
  // entrantes se encolan sin `business_id`, `activity` venía siempre vacía: a
  // las 12 h caía en `silencio` y `alert` se quedaba en true para siempre.
  it('no sale en el semáforo por negocio ni enciende la alarma', () => {
    const report = diagnoseChannels({
      businesses: [delMarketplace()],
      activity: [],
      platform: { configured: true, lastInboundAt: haceHoras(0.1) },
      now: ahora,
    })
    expect(report.businesses).toEqual([])
    expect(report.alert).toBe(false)
  })

  // La configuración EXACTA de producción: el último entrante de Monster Pizza
  // fue a las 04:41 (cuando el número dejó de ser suyo) y el del número de
  // Umbani, minutos antes de la consulta.
  it('la configuración real de producción da tranquilidad, no alarma', () => {
    const report = diagnoseChannels({
      businesses: [delMarketplace({ id: 'e758ca17-1db8-4acd-8c45-f9dbe01389b9' })],
      activity: [],
      platform: { configured: true, lastInboundAt: haceHoras(0.1) },
      now: ahora,
      silenceHours: 12,
    })
    expect(report.platform.status).toBe('ok')
    expect(report.alert).toBe(false)
  })

  it('pero sigue vigilando al que SÍ tiene número propio', () => {
    const report = diagnoseChannels({
      businesses: [delMarketplace(), negocio({ id: 'biz-propio' })],
      activity: [{ businessId: 'biz-propio', lastInboundAt: haceHoras(40) }],
      platform: plataformaSana,
      now: ahora,
    })
    expect(report.businesses.map(b => b.businessId)).toEqual(['biz-propio'])
    expect(report.businesses[0].status).toBe('silencio')
    expect(report.alert).toBe(true)
  })
})
