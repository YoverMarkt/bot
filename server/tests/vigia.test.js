import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  HORAS_DE_SILENCIO,
  RECORDATORIO_MS,
  decidirAviso,
  evaluarSalud,
  redactarResumen,
} from '../../.github/scripts/vigia.mjs'

const require = createRequire(import.meta.url)
const canal = require('../dist/services/channel-health')

// ═══════════════════════════════════════════════════════════════════════════
// EL VIGÍA EXTERNO
// ═══════════════════════════════════════════════════════════════════════════
//
// Corre en GitHub Actions, fuera del servidor, porque es el único sitio desde
// el que se puede avisar de que el proceso murió. Lo que se prueba aquí es lo
// que de verdad puede salir mal en una alarma:
//
//   · que no avise cuando debería (una caída silenciosa), y
//   · que avise tanto que se acabe ignorando (96 correos al día).

const SANA = {
  ok: true,
  version: 'abc1234',
  canario: { at: '2026-09-18T04:21:51.021Z', revisados: 2, locales: 2, cerrados: 0, fallos: 0 },
  webhook_inbox: { running: true, ready: true, in_flight: 0 },
  inbound_channel: { last_inbound_at: '2026-09-18T03:42:03Z', hours_since_last_inbound: 1.2, recent_failures: 0, last_failure: null },
}

describe('evaluarSalud', () => {
  it('da por sana una producción que va bien', () => {
    expect(evaluarSalud({ salud: SANA, detalle: null })).toEqual({ sano: true, motivos: [] })
  })

  it('sin respuesta, la producción está caída', () => {
    const { sano, motivos } = evaluarSalud({ salud: null, detalle: null })
    expect(sano).toBe(false)
    expect(motivos[0]).toContain('no contesta')
  })

  it('distingue al proxy caído de nuestro propio servidor', () => {
    // Railway contesta su JSON de error cuando el servicio no está arriba.
    const { sano, motivos } = evaluarSalud({
      salud: { status: 'error', code: 404, message: 'Application not found' },
      detalle: null,
    })
    expect(sano).toBe(false)
    expect(motivos.join(' ')).toContain('no es nuestro')
    // Lo que NO puede decir es que el proceso contestó, porque no contestó.
    expect(motivos.join(' ')).not.toContain('NO puede trabajar')
  })

  it('detecta que el proceso no puede trabajar', () => {
    const { sano, motivos } = evaluarSalud({ salud: { ...SANA, ok: false }, detalle: null })
    expect(sano).toBe(false)
    expect(motivos.join(' ')).toContain('NO puede trabajar')
  })

  it('detecta la cola de webhooks parada', () => {
    const { motivos } = evaluarSalud({
      salud: { ...SANA, ok: false, webhook_inbox: { running: false, ready: false } },
      detalle: null,
    })
    expect(motivos.join(' ')).toContain('no está corriendo')
  })

  it('suena cuando el canario encontró fallos, aunque el proceso viva', () => {
    // Este es el caso de julio de 2026: `ok` en verde y nadie podía comprar.
    const { sano, motivos } = evaluarSalud({
      salud: { ...SANA, canario: { ...SANA.canario, fallos: 3 } },
      detalle: null,
    })
    expect(sano).toBe(false)
    expect(motivos.join(' ')).toContain('canario encontró 3')
  })

  it('suena cuando el webhook está rechazando entregas', () => {
    const { sano, motivos } = evaluarSalud({
      salud: {
        ...SANA,
        inbound_channel: {
          ...SANA.inbound_channel,
          recent_failures: 4,
          last_failure: { provider: 'ycloud', status: 503, reason: 'cola llena' },
        },
      },
      detalle: null,
    })
    expect(sano).toBe(false)
    expect(motivos.join(' ')).toContain('ycloud 503')
  })

  describe('el silencio del canal', () => {
    const conHoras = horas => evaluarSalud({
      salud: { ...SANA, inbound_channel: { ...SANA.inbound_channel, hours_since_last_inbound: horas } },
      detalle: null,
    })

    it('aguanta una noche cerrada sin gritar', () => {
      // 13 h del último pedido al primero del día siguiente son NORMALES en un
      // local de comida; un domingo flojo pasa de 20.
      expect(conHoras(13).sano).toBe(true)
      expect(conHoras(20.5).sano).toBe(true)
      expect(conHoras(23.9).sano).toBe(true)
    })

    it('suena al pasar el límite', () => {
      expect(conHoras(24).sano).toBe(false)
      expect(conHoras(30).motivos.join(' ')).toContain('Canal en silencio')
    })
  })

  it('añade lo que solo se ve con token: saldo y credenciales', () => {
    const { sano, motivos } = evaluarSalud({
      salud: SANA,
      detalle: {
        ok: false,
        problemas: [
          { categoria: 'canal', codigo: 'saldo_bajo', veces: 209, ultima_vez: '2026-09-18T04:00:00Z' },
        ],
      },
    })
    expect(sano).toBe(false)
    expect(motivos.join(' ')).toContain('saldo_bajo')
  })

  it('un detalle ausente no inventa problemas', () => {
    // Sin token, o con el endpoint todavía sin desplegar, el vigía sigue
    // sirviendo para lo principal.
    expect(evaluarSalud({ salud: SANA, detalle: null }).sano).toBe(true)
    expect(evaluarSalud({ salud: SANA, detalle: { ok: true, problemas: [] } }).sano).toBe(true)
  })
})

describe('decidirAviso — la regla que evita los 96 correos al día', () => {
  it('avisa cuando algo que estaba bien se rompe', () => {
    expect(decidirAviso({ sano: false, anteriorFueFallo: false, ultimoFalloHaceMs: null }))
      .toEqual({ avisar: true, tipo: 'se-rompio' })
  })

  it('se calla mientras siga roto y el aviso sea reciente', () => {
    const haceUnaHora = 60 * 60 * 1000
    expect(decidirAviso({ sano: false, anteriorFueFallo: true, ultimoFalloHaceMs: haceUnaHora }))
      .toEqual({ avisar: false, tipo: 'sigue-roto' })
  })

  it('vuelve a avisar pasadas 4 h para que no se olvide', () => {
    expect(decidirAviso({ sano: false, anteriorFueFallo: true, ultimoFalloHaceMs: RECORDATORIO_MS }))
      .toEqual({ avisar: true, tipo: 'recordatorio' })
  })

  it('no se queda callado si no pudo consultar su historia', () => {
    // Más vale un correo de más que un silencio por no saber.
    expect(decidirAviso({ sano: false, anteriorFueFallo: true, ultimoFalloHaceMs: null }).avisar)
      .toBe(true)
  })

  it('la recuperación no manda correo, pero se marca', () => {
    expect(decidirAviso({ sano: true, anteriorFueFallo: true, ultimoFalloHaceMs: 1000 }))
      .toEqual({ avisar: false, tipo: 'recuperado' })
  })

  it('un día normal no molesta a nadie', () => {
    expect(decidirAviso({ sano: true, anteriorFueFallo: false, ultimoFalloHaceMs: null }))
      .toEqual({ avisar: false, tipo: 'sigue-bien' })
  })
})

describe('el resumen que se lee en GitHub', () => {
  it('lleva el motivo y el commit que estaba corriendo', () => {
    const texto = redactarResumen({
      tipo: 'se-rompio',
      motivos: ['Producción no contesta: el proceso puede estar caído.'],
      salud: SANA,
    })
    expect(texto).toContain('Producción ha caído')
    expect(texto).toContain('no contesta')
    expect(texto).toContain('abc1234')
  })

  it('sirve aunque no haya habido respuesta que resumir', () => {
    const texto = redactarResumen({ tipo: 'se-rompio', motivos: ['nada contestó'], salud: null })
    expect(texto).toContain('Producción ha caído')
  })
})

describe('guardián: los dos umbrales de silencio son el mismo', () => {
  it('el vigía usa el mismo número que el servidor', () => {
    // Si alguien ajusta `DEFAULT_SILENCE_HOURS` y se olvida del vigía, los dos
    // dirían cosas distintas sobre el mismo canal. Esta prueba obliga a tocar
    // los dos sitios a la vez.
    expect(HORAS_DE_SILENCIO).toBe(canal.DEFAULT_SILENCE_HOURS)
  })
})
