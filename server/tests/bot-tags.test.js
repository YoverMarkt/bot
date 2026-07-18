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

  it('extrae una reserva válida y retira la etiqueta antes de responder', () => {
    const parsed = tags.parseBotOutput(
      'Perfecto ##BOOK: Ana |fecha 2026-07-20|hora 9:30| Corte Premium ##',
    )

    expect(parsed.finalText).toBe('Perfecto')
    expect(parsed.booking).toEqual({
      contactName: ' Ana ',
      bookingDateRaw: 'fecha 2026-07-20',
      bookingTimeRaw: 'hora 9:30',
      service: ' Corte Premium ',
      bookingDate: '2026-07-20',
      bookingTime: '9:30',
    })
  })

  it('retira reservas inválidas pero no inventa fecha ni hora', () => {
    const parsed = tags.parseBotOutput(
      'Lo revisamos ##BOOK:Ana|mañana|en la tarde|Corte## ##BOOKING##',
    )

    expect(parsed.finalText).toBe('Lo revisamos')
    expect(parsed.booking.bookingDate).toBeNull()
    expect(parsed.booking.bookingTime).toBeNull()
  })

  it('extrae el pedido sin montos y lo clasifica como venta', () => {
    const parsed = tags.parseBotOutput(
      'Gracias ## PEDIDO : Producto A x2; Producto B x1 ##',
    )

    expect(parsed.finalText).toBe('Gracias')
    expect(parsed.orderPayload).toBe('Producto A x2; Producto B x1')
    expect(parsed.hasSale).toBe(true)
  })

  it('reporta ambas acciones para que el orquestador resuelva el conflicto', () => {
    const parsed = tags.parseBotOutput(
      'Listo ##BOOK:Ana|2026-07-20|09:30|Corte## ##PEDIDO:Shampoo x1##',
    )

    expect(parsed.finalText).toBe('Listo')
    expect(parsed.booking).toMatchObject({
      contactName: 'Ana', bookingDate: '2026-07-20', bookingTime: '09:30',
    })
    expect(parsed.orderPayload).toBe('Shampoo x1')
    expect(parsed.hasActionConflict).toBe(false)
  })

  it('detecta cuando la IA imita el vocabulario exclusivo de los resúmenes oficiales', () => {
    expect(tags.impersonatesOfficialSummary('🏨 *Opciones de hospedaje*\n1. Doble $120')).toBe(true)
    expect(tags.impersonatesOfficialSummary('💰 *Total oficial: $200.00*')).toBe(true)
    expect(tags.impersonatesOfficialSummary('🧾 *Resumen de su pedido*\nPizza x1')).toBe(true)
    expect(tags.impersonatesOfficialSummary('El Perfume Floral cuesta $12.50 y hay stock 😊')).toBe(false)
    expect(tags.impersonatesOfficialSummary('Con gusto le cotizo, ¿para qué fechas sería?')).toBe(false)
    expect(tags.impersonatesOfficialSummary('')).toBe(false)
  })

  it('extrae una cotización de hospedaje estricta sin calcular nada', () => {
    const parsed = tags.parseBotOutput(
      'Voy a consultar ##STAY_QUOTE:2026-08-10|2026-08-13|2|2|1##',
    )

    expect(parsed.finalText).toBe('Voy a consultar')
    expect(parsed.lodgingQuote).toEqual({
      checkInRaw: '2026-08-10',
      checkOutRaw: '2026-08-13',
      roomsRaw: '2',
      adultsRaw: '2',
      childrenRaw: '1',
      checkIn: '2026-08-10',
      checkOut: '2026-08-13',
      roomsCount: 2,
      adults: 2,
      children: 1,
    })
    expect(parsed.lodgingRequest).toBeNull()
    expect(parsed.hasActionConflict).toBe(false)
  })

  it('retira una cotización inválida sin normalizar fechas ni personas', () => {
    const parsed = tags.parseBotOutput(
      'Consulto ##STAY_QUOTE:2026-02-30|mañana|0|0|treinta##',
    )

    expect(parsed.finalText).toBe('Consulto')
    expect(parsed.lodgingQuote).toMatchObject({
      checkIn: null,
      checkOut: null,
      roomsCount: null,
      adults: null,
      children: null,
    })
  })

  it('extrae la opción elegida y el contacto para una solicitud pendiente', () => {
    const parsed = tags.parseBotOutput(
      'Solicito la opción ##STAY_REQUEST:Habitación Doble|Ana Pérez##',
    )

    expect(parsed.finalText).toBe('Solicito la opción')
    expect(parsed.lodgingRequest).toEqual({
      roomTypeIdOrName: 'Habitación Doble',
      contactName: 'Ana Pérez',
    })
    expect(parsed.hasActionConflict).toBe(false)
  })

  it('marca STAY como incompatible con otras acciones o handoff', () => {
    const quoteAndOrder = tags.parseBotOutput(
      '##STAY_QUOTE:2026-08-10|2026-08-13|1|2|0## '
      + '##PEDIDO:Habitación Doble x1##',
    )
    const requestAndHandoff = tags.parseBotOutput(
      '##STAY_REQUEST:Habitación Doble|Ana## ##HANDOFF##',
    )
    const quoteAndLegacyOrder = tags.parseBotOutput(
      '##STAY_QUOTE:2026-08-10|2026-08-13|1|2|0## ##PEDIDO##',
    )

    expect(quoteAndOrder.hasActionConflict).toBe(true)
    expect(requestAndHandoff.hasActionConflict).toBe(true)
    expect(quoteAndLegacyOrder.hasActionConflict).toBe(true)
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

  it('mantiene acciones multi-tenant en el orquestador TypeScript', () => {
    const service = fs.readFileSync(new URL('../src/services/bot-tags.ts', import.meta.url), 'utf8')
    const actions = fs.readFileSync(new URL('../src/services/bot-actions.ts', import.meta.url), 'utf8')
    const conversation = fs.readFileSync(new URL('../src/services/bot-conversation.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).not.toContain('@ts-nocheck')
    expect(conversation).toContain("require('./bot-tags')")
    expect(conversation).toContain("require('./bot-actions')")
    expect(entry).toContain("require('./bot-conversation')")
    expect(actions).toContain('database.createBooking(business.id')
    expect(actions).toContain('business_id: business.id')
    expect(actions).toContain('database.recordAiGap(')
    expect(actions).not.toContain('@ts-nocheck')
  })
})
