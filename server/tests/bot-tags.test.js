import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const tags = require('../dist/services/bot-tags')

describe('análisis de etiquetas del bot', () => {
  it('limpia marcadores y enlaces internos de media', () => {
    const parsed = tags.parseBotOutput(
      'Aquí está  ##IMG##https://cdn.example/a.jpg## ##CATALOG## '
      + '[IMAGE:oculta] https://res.cloudinary.com/demo/image/upload/a.jpg Listo',
    )

    expect(parsed.finalText).toBe('Aquí está Listo')
    expect(parsed.finalText).not.toContain('##')
    expect(parsed.finalText).not.toContain('http')
  })

  it('extrae el pedido sin montos y lo clasifica como venta', () => {
    const parsed = tags.parseBotOutput(
      'Gracias ## PEDIDO : Producto A x2; Producto B x1 ##',
    )

    expect(parsed.finalText).toBe('Gracias')
    expect(parsed.orderPayload).toBe('Producto A x2; Producto B x1')
    expect(parsed.hasSale).toBe(true)
  })

  it('detecta cuando la IA imita el vocabulario exclusivo de los resúmenes oficiales', () => {
    expect(tags.impersonatesOfficialSummary('💰 *Total oficial: $200.00*')).toBe(true)
    expect(tags.impersonatesOfficialSummary('🧾 *Resumen de su pedido*\nPizza x1')).toBe(true)
    expect(tags.impersonatesOfficialSummary('El Perfume Floral cuesta $12.50 y hay stock 😊')).toBe(false)
    expect(tags.impersonatesOfficialSummary('Con gusto le cotizo, ¿para qué fechas sería?')).toBe(false)
    expect(tags.impersonatesOfficialSummary('')).toBe(false)
  })

  it('conserva cierres legacy y frases inequívocas como respaldo', () => {
    expect(tags.parseBotOutput('Pedido confirmado ##VENTA##')).toMatchObject({
      finalText: 'Pedido confirmado',
      orderPayload: null,
      hasSale: true,
    })
    expect(tags.parseBotOutput('Gracias por su compra')).toMatchObject({
      finalText: 'Gracias por su compra',
      hasSale: true,
    })
    expect(tags.parseBotOutput('¿Desea proceder con la compra?').hasSale).toBe(false)
  })

  it('distingue handoff explícito de incertidumbre textual', () => {
    expect(tags.parseBotOutput('##HANDOFF##')).toMatchObject({
      hasHandoffTag: true,
      isUncertain: true,
    })
    expect(tags.parseBotOutput('No tengo ese dato todavía')).toMatchObject({
      hasHandoffTag: false,
      isUncertain: true,
    })
    expect(tags.parseBotOutput('Tengo toda la información')).toMatchObject({
      hasHandoffTag: false,
      isUncertain: false,
    })
  })

  it('detecta insultos por palabras completas sin falsos positivos', () => {
    expect(tags.isInsultMessage('Eres un imbécil')).toBe(true)
    expect(tags.isInsultMessage('Este frasco está bonito')).toBe(false)
    expect(tags.isInsultMessage('El casco está disponible')).toBe(false)
  })

  it('distingue solicitudes de foto, video o ambas', () => {
    expect(tags.detectMediaRequest('Muéstrame una foto')).toEqual({
      wantsImage: true, wantsVideo: false,
    })
    expect(tags.detectMediaRequest('¿Tienen vídeos?')).toEqual({
      wantsImage: false, wantsVideo: true,
    })
    expect(tags.detectMediaRequest('Enséñame fotos y videos')).toEqual({
      wantsImage: true, wantsVideo: true,
    })
  })

  it('sigue enganchado al orquestador, y este al negocio resuelto', () => {
    // ⚠️ Esta prueba miraba además `bot-actions.ts` —que ejecutaba el pedido
    // por chat y escribía `business_id: business.id` en cada acción—, y se
    // retiró el 2026-09-16 con el modo menú, su único llamador. Lo que sigue
    // valiendo es la cadena que queda: el orquestador engancha las etiquetas y
    // la entrada engancha al orquestador.
    const service = fs.readFileSync(new URL('../src/services/bot-tags.ts', import.meta.url), 'utf8')
    const conversation = fs.readFileSync(new URL('../src/services/bot-conversation.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).not.toContain('@ts-nocheck')
    expect(conversation).toContain("require('./bot-tags')")
    expect(entry).toContain("require('./bot-conversation')")
    expect(conversation).not.toContain("require('./bot-actions')")
    // Todo lo que hace el orquestador cuelga del negocio que resolvió el canal:
    // nunca de un id que venga en el mensaje.
    expect(conversation).toContain('business.id')
  })
})
