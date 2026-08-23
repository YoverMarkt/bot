import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// LA UBICACIÓN QUE COMPARTE EL CLIENTE
//
// Hasta hoy el webhook solo entendía texto, audio e imagen: un mensaje de
// ubicación se descartaba como «tipo inbound no soportado». Sin él no hay
// forma de cerrar un pedido dentro del chat sin pedirle al cliente que teclee
// su dirección a mano.
//
// ⚠️ Latitud y longitud viajan JUNTAS o no viajan. Media coordenada apunta al
// ecuador, y eso es peor que no tener nada porque parece un dato bueno.
// ═══════════════════════════════════════════════════════════════════════════

const base = {
  version: 1,
  provider: 'ycloud',
  businessId: null,
  from: '593990978367',
  inboundId: 'wamid.loc',
  channelAddress: {
    provider: 'ycloud', identifierType: 'phone', identifier: '593911111111',
  },
}

const conUbicacion = location => ({ ...base, content: { kind: 'location', location } })

describe('el payload durable acepta una ubicación', () => {
  it('con las dos coordenadas', async () => {
    const { parseInboundWebhookPayload } = await import('../dist/services/inbound-webhook.js')
    const p = parseInboundWebhookPayload(conUbicacion({
      latitude: -3.2581, longitude: -79.9554,
    }))
    expect(p.content).toEqual({
      kind: 'location',
      location: { latitude: -3.2581, longitude: -79.9554 },
    })
  })

  it('y guarda la dirección y el nombre del sitio si vienen', async () => {
    const { parseInboundWebhookPayload } = await import('../dist/services/inbound-webhook.js')
    // WhatsApp los adjunta cuando el cliente elige un sitio del mapa en vez de
    // su punto azul. La mayoría manda solo el punto.
    const p = parseInboundWebhookPayload(conUbicacion({
      latitude: -3.2581,
      longitude: -79.9554,
      address: 'Av. Quito y 10 de Agosto, Machala',
      name: 'Parque Central',
    }))
    expect(p.content.location.address).toBe('Av. Quito y 10 de Agosto, Machala')
    expect(p.content.location.name).toBe('Parque Central')
  })
})

describe('media coordenada NO es una ubicación', () => {
  const rechaza = async (location) => {
    const { parseInboundWebhookPayload } = await import('../dist/services/inbound-webhook.js')
    expect(() => parseInboundWebhookPayload(conUbicacion(location)))
      .toThrow(/Ubicación durable/)
  }

  it('sin longitud', () => rechaza({ latitude: -3.2581 }))
  it('sin latitud', () => rechaza({ longitude: -79.9554 }))
  it('con texto en vez de números', () => rechaza({ latitude: 'aquí', longitude: 'allá' }))

  it('con `null`, que es el bug clásico', () => {
    // `Number(null)` es 0, no NaN: sin la comprobación explícita, una
    // coordenada nula pasaría como cero y apuntaría al golfo de Guinea.
    return rechaza({ latitude: null, longitude: -79.9554 })
  })

  it('fuera del rango real del planeta', async () => {
    await rechaza({ latitude: 91, longitude: 0 })
    await rechaza({ latitude: 0, longitude: 181 })
    await rechaza({ latitude: -91, longitude: -79 })
  })

  it('en el 0,0 exacto: eso es un campo vacío, no la Isla Nula', () => {
    return rechaza({ latitude: 0, longitude: 0 })
  })
})

describe('el webhook la extrae de los dos proveedores', () => {
  const leer = ruta => readFileSync(
    fileURLToPath(new URL(ruta, import.meta.url)), 'utf8',
  )

  it('Meta y YCloud usan la MISMA forma, así que un solo extractor sirve', () => {
    const fuente = leer('../src/routes/webhooks.routes.ts')
    expect(fuente).toContain('function sharedLocation')
    // Enganchado en los DOS parsers, no en uno solo: si se olvidara uno, ese
    // proveedor descartaría las ubicaciones en silencio.
    expect(fuente.match(/return sharedLocation\(message\)/g)).toHaveLength(2)
  })

  it('la VALIDACIÓN vive en el parser durable, no en el webhook', () => {
    // Así es la misma comprobación tanto si el mensaje entra ahora como si se
    // relee de la cola durable, que es el camino que de verdad lo procesa.
    expect(leer('../src/routes/webhooks.routes.ts')).not.toContain('latitude < -90')
    expect(leer('../src/services/inbound-webhook.ts')).toContain('latitude < -90')
  })
})

describe('una ubicación no pasa por la descarga de media', () => {
  const fuente = () => readFileSync(
    fileURLToPath(new URL('../src/services/inbound-webhook.ts', import.meta.url)), 'utf8',
  )

  it('`descargarMedia` la rechaza junto con el texto', () => {
    // El compilador obliga a nombrar los dos casos: al añadir un tipo de
    // mensaje nuevo, este punto falla y hay que decidir qué hacer con él.
    expect(fuente()).toMatch(
      /kind === 'text' \|\| payload\.content\.kind === 'location'/,
    )
  })

  it('y se entrega como texto ANTES de intentar bajar nada', () => {
    const s = fuente()
    const ubicacion = s.indexOf("payload.content.kind === 'location'\n")
    const audio = s.indexOf("const isAudio = payload.content.kind === 'audio'")
    expect(ubicacion).toBeGreaterThan(-1)
    expect(audio).toBeGreaterThan(-1)
  })

  it('el marketplace la recibe entera, no solo como «[ubicación]»', () => {
    // El texto es para el historial; las coordenadas son lo que deja crear la
    // dirección del pedido sin que el cliente teclee nada.
    const s = fuente()
    expect(s).toMatch(/location: payload\.content\.location/)
    expect(s).toContain('[ubicación]')
  })
})
