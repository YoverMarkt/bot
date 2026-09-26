import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  VENTANA_DE_AGRUPADO_MS,
  alEntrarUnMensaje,
  avisarQueEntroUnMensaje,
  esperaAntesDeProcesar,
} = require('../dist/lib/despertador-de-la-cola')

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const leer = ruta => readFileSync(`${serverDir}/${ruta}`, 'utf8')

afterEach(() => alEntrarUnMensaje(null))

// ═══════════════════════════════════════════════════════════════════════════
// EL WEBHOOK DESPIERTA AL WORKER EN VEZ DE ESPERAR SU SONDEO
// ═══════════════════════════════════════════════════════════════════════════

describe('cuánto espera cada mensaje antes de procesarse', () => {
  it('lo ELEGIDO entra al instante: botón o fila de lista', () => {
    expect(esperaAntesDeProcesar({
      content: { kind: 'text', text: 'Ver catálogo', interactivo: true },
    })).toBe(0)
  })

  it('lo ESCRITO espera la ventana de agrupado, con margen', () => {
    const espera = esperaAntesDeProcesar({ content: { kind: 'text', text: 'hola' } })
    expect(espera).toBeGreaterThan(VENTANA_DE_AGRUPADO_MS)
    // Pero no tanto como para volver a parecerse al segundo del sondeo.
    expect(espera).toBeLessThan(500)
  })

  it('una foto, un audio o una ubicación no se agrupan', () => {
    expect(esperaAntesDeProcesar({ content: { kind: 'image' } })).toBe(0)
    expect(esperaAntesDeProcesar({ content: { kind: 'audio' } })).toBe(0)
    expect(esperaAntesDeProcesar({ content: { kind: 'location' } })).toBe(0)
  })

  it('la ventana es la MISMA que la del SQL que encola', () => {
    // ⚠️ Si el SQL la cambia y esto no, despertar llega antes de que el texto
    // esté disponible y el cliente vuelve a esperar el segundo del sondeo —
    // sin que nada falle, que es lo peor.
    const schema = leer('schema.sql')
    const inicio = schema.indexOf('create or replace function public.enqueue_webhook_event')
    expect(inicio, 'schema.sql ya no define enqueue_webhook_event').toBeGreaterThan(-1)
    const cuerpo = schema.slice(inicio, schema.indexOf('$$;', inicio))
    const ventana = /v_quiet_until\s*:=\s*v_received_at\s*\+\s*interval\s*'(\d+)\s*milliseconds'/.exec(cuerpo)
    expect(ventana, 'no se encontró la ventana de agrupado en el SQL').not.toBeNull()
    expect(Number(ventana[1])).toBe(VENTANA_DE_AGRUPADO_MS)
  })
})

describe('el aviso de que entró un mensaje', () => {
  it('llega a quien escucha, con la espera que toca', () => {
    const escuchar = vi.fn()
    alEntrarUnMensaje(escuchar)
    avisarQueEntroUnMensaje({ content: { kind: 'text', text: 'Pizzas', interactivo: true } })
    avisarQueEntroUnMensaje({ content: { kind: 'text', text: 'quiero una pizza' } })
    expect(escuchar).toHaveBeenNthCalledWith(1, 0)
    expect(escuchar).toHaveBeenNthCalledWith(2, VENTANA_DE_AGRUPADO_MS + 50)
  })

  it('sin nadie escuchando no pasa nada: el sondeo de siempre lo recoge', () => {
    expect(() => avisarQueEntroUnMensaje({ content: { kind: 'text', text: 'hola' } }))
      .not.toThrow()
  })

  it('si despertar falla, el webhook NO falla: el mensaje ya está guardado', () => {
    alEntrarUnMensaje(() => { throw new Error('worker parado') })
    expect(() => avisarQueEntroUnMensaje({ content: { kind: 'image' } })).not.toThrow()
  })
})

describe('camino real: el worker de producción escucha de verdad', () => {
  // ⚠️ Cinco veces en este proyecto el CI estuvo verde sobre código al que
  // nadie llegaba. Que el despertador exista no sirve si `index.ts` no le
  // apunta el worker, o si el webhook no lo llama.
  it('index.ts apunta el worker justo después de arrancarlo, dentro del freno', () => {
    const index = leer('src/index.ts')
    const freno = index.indexOf('if (tareas.permitido) {')
    const arranque = index.indexOf('webhookInboxWorker.start()', freno)
    const apunte = index.indexOf('alEntrarUnMensaje(espera => webhookInboxWorker.despertar(espera))', freno)
    expect(freno).toBeGreaterThan(-1)
    expect(arranque).toBeGreaterThan(freno)
    expect(apunte).toBeGreaterThan(arranque)
  })

  it('el webhook avisa en el embudo por el que pasan Meta y YCloud', () => {
    const ruta = leer('src/routes/webhooks.routes.ts')
    const embudo = ruta.slice(
      ruta.indexOf('async function enqueueResolvedInbound('),
      ruta.indexOf('function loggedError('),
    )
    expect(embudo).toContain('avisarQueEntroUnMensaje(payload)')
    // Los dos proveedores siguen pasando por ahí.
    expect(ruta.match(/await enqueueResolvedInbound\(/g)).toHaveLength(2)
  })
})
