import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const freno = require('../dist/config/tareas-de-fondo')

// ═══════════════════════════════════════════════════════════════════════════
// EL FRENO DE LAS TAREAS DE FONDO
// ═══════════════════════════════════════════════════════════════════════════
//
// `server/.env` apunta a la base de producción, así que encender el servidor en
// un portátil dispara contra los datos de los clientes: el worker procesa sus
// mensajes, y a los 30 segundos `expireUnpaidOrders` empieza a CANCELAR sus
// pedidos.
//
// Aquí se prueban las dos mitades del trato, y la segunda importa tanto como la
// primera:
//
//   1. que en local contra una base remota NO arranque nada, y
//   2. que **en producción no cambie absolutamente nada**.
//
// Un freno que se pase de listo y apague las tareas en producción deja la
// facturación sin generar y los pedidos sin expirar — mucho peor que el
// problema que vino a resolver.

const PRODUCCION = 'https://isepwpmwdajavmbnsckc.supabase.co'
const LOCAL = 'http://127.0.0.1:54321'

describe('en producción no se toca nada', () => {
  it('con NODE_ENV=production las tareas arrancan', () => {
    const decision = freno.decidirTareasDeFondo({
      NODE_ENV: 'production',
      SUPABASE_URL: PRODUCCION,
    })
    expect(decision.permitido).toBe(true)
  })

  it('en Railway las tareas arrancan', () => {
    // Railway inyecta estas variables solo; `BASE_URL` es la señal principal.
    for (const entorno of [
      { BASE_URL: 'https://web-production-3433c.up.railway.app' },
      { RAILWAY_ENVIRONMENT: 'production' },
      { RAILWAY_ENVIRONMENT_NAME: 'production' },
    ]) {
      const decision = freno.decidirTareasDeFondo({ ...entorno, SUPABASE_URL: PRODUCCION })
      expect(decision.permitido).toBe(true)
    }
  })
})

describe('en local contra la base REAL, el freno actúa', () => {
  it('no arranca nada', () => {
    const decision = freno.decidirTareasDeFondo({ SUPABASE_URL: PRODUCCION })
    expect(decision.permitido).toBe(false)
    expect(decision.motivo).toContain('REMOTA')
  })

  it('lo explica en voz alta, no en silencio', () => {
    // Un freno que actúa sin decirlo es un misterio de dos horas: «¿por qué no
    // se procesan los mensajes?».
    const decision = freno.decidirTareasDeFondo({ SUPABASE_URL: PRODUCCION })
    const texto = freno.explicarDecision(decision).join('\n')
    expect(texto).toContain('APAGADAS')
    expect(texto).toContain('CANCELAR pedidos')
    expect(texto).toContain(freno.ESCAPE_ENV)
  })

  it('se puede pedir a propósito', () => {
    const decision = freno.decidirTareasDeFondo({
      SUPABASE_URL: PRODUCCION,
      [freno.ESCAPE_ENV]: 'si',
    })
    expect(decision.permitido).toBe(true)
  })

  it('el escape exige la palabra exacta', () => {
    for (const valor of ['', 'no', 'true', '1', 'quizá']) {
      const decision = freno.decidirTareasDeFondo({
        SUPABASE_URL: PRODUCCION,
        [freno.ESCAPE_ENV]: valor,
      })
      expect(decision.permitido).toBe(false)
    }
  })
})

describe('en local contra una base local, todo corre', () => {
  it('las tareas arrancan, que es donde se quiere probarlas', () => {
    const decision = freno.decidirTareasDeFondo({ SUPABASE_URL: LOCAL })
    expect(decision.permitido).toBe(true)
    expect(decision.motivo).toContain('local')
  })

  it('reconoce las formas en que se ve el Supabase local', () => {
    for (const url of [
      'http://127.0.0.1:54321',
      'http://localhost:54321',
      'http://host.docker.internal:54321',
      'http://kong:8000',
    ]) {
      expect(freno.apuntaAUnaBaseLocal(url)).toBe(true)
    }
  })

  it('una URL remota o ilegible NO cuenta como local', () => {
    // Ante la duda se frena: equivocarse hacia aquí cuesta un arranque sin
    // tareas; hacia el otro lado, pedidos cancelados.
    for (const url of [PRODUCCION, 'no-es-una-url', '', undefined]) {
      expect(freno.apuntaAUnaBaseLocal(url)).toBe(false)
    }
  })
})

describe('guardián: el freno está ENCHUFADO en el arranque', () => {
  const arranque = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('las tareas peligrosas viven dentro del if', () => {
    // Que el módulo exista y esté probado no sirve de nada si el arranque no
    // lo consulta — el fallo de siempre en este proyecto.
    const condicion = arranque.indexOf('if (tareas.permitido) {')
    expect(condicion).toBeGreaterThan(-1)

    const bloque = arranque.slice(condicion)
    for (const tarea of [
      'webhookInboxWorker.start()',
      'expireUnpaidOrders',
      'generateCurrentMonthBilling',
      'settleCommissions',
      'cleanupWebhookInbox',
      'checkCredentials',
      'vigilarElCaminoDelCliente',
      'setupTelegram',
    ]) {
      expect(bloque).toContain(tarea)
      // Y que no haya quedado además una copia suelta fuera del if.
      expect(arranque.slice(0, condicion)).not.toContain(`  ${tarea}(`)
    }
  })
})
