import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// TODA LLAMADA A LA BASE TIENE TIEMPO LÍMITE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Causa raíz del incidente del 2026-08-23, que dejó al marketplace mudo.
//
// `createClient(url, key)` a secas usa el `fetch` global de Node, y **el fetch
// de Node NO TIENE TIEMPO LÍMITE**. Una conexión colgada no falla: espera para
// siempre. `complete_webhook_event` se colgaba entre Railway y Supabase —sin
// una consulta lenta ni un bloqueo en `pg_stat_activity`, porque la petición
// no llegaba a PostgreSQL— y a los ~110 s cortaba el borde de Cloudflare.
//
// El evento se quedaba reservado, la cola es FIFO por conversación, y todos
// los mensajes siguientes del cliente se quedaban esperando. Al reintentarlo
// se reprocesaba: el cliente recibía la misma respuesta cada tres minutos.

const fuente = readFileSync(
  fileURLToPath(new URL('../src/db/client.ts', import.meta.url)),
  'utf8',
)

describe('el cliente de Supabase no puede colgarse para siempre', () => {
  it('createClient recibe un fetch propio, no el global de Node', () => {
    expect(fuente).toMatch(/global:\s*\{\s*fetch:/)
  })

  it('ese fetch lleva AbortSignal.timeout', () => {
    expect(fuente).toContain('AbortSignal.timeout')
  })

  // ⚠️ Si el llamador ya trae su propia señal, la suya tiene que seguir
  // funcionando: combinarlas, no pisarla.
  it('respeta la señal de quien llama en vez de descartarla', () => {
    expect(fuente).toContain('AbortSignal.any')
  })

  it('el límite es configurable sin desplegar, y con topes', () => {
    expect(fuente).toContain('SUPABASE_TIMEOUT_MS')
    // Ni tres segundos (cortaría reportes legítimos) ni infinito.
    expect(fuente).toMatch(/crudo >= 1_000 && crudo <= 120_000/)
  })

  it('el valor por defecto deja margen a las consultas pesadas', () => {
    // Lo medido en el camino caliente son ~180 ms: 30 s solo actúa cuando
    // algo va de verdad mal.
    expect(fuente).toContain('30_000')
  })
})

describe('el límite funciona de verdad', () => {
  it('AbortSignal.timeout aborta, y combinado con otro también', async () => {
    // No es una prueba del cliente sino del mecanismo: si esto dejara de
    // cumplirse en una versión de Node, el arreglo sería decorativo.
    const propia = AbortSignal.timeout(20)
    const ajena = new AbortController().signal
    const combinada = AbortSignal.any([ajena, propia])
    expect(combinada.aborted).toBe(false)
    await new Promise(seguir => setTimeout(seguir, 60))
    expect(combinada.aborted).toBe(true)
  })

  it('y la señal del llamador sigue mandando', () => {
    const control = new AbortController()
    const combinada = AbortSignal.any([control.signal, AbortSignal.timeout(60_000)])
    control.abort()
    expect(combinada.aborted).toBe(true)
  })
})
