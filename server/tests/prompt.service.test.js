import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const promptService = require('../dist/services/prompt')

const business = {
  name: 'Negocio A',
  type: 'tienda',
  address: 'Calle Uno',
  phone: '0990000001',
  hours: 'Lunes a viernes',
  slogan: 'Siempre contigo',
  description: 'Descripción del negocio A',
  social: '@negocioa',
  payment_methods: 'Transferencia',
}

const product = {
  name: 'Producto A',
  brand: 'Marca A',
  price: '12.50',
  stock: 'disponible',
  tags: ['especial'],
  image_url: 'https://media.example.com/a.jpg',
}

describe('constructor tipado del prompt', () => {
  it('inyecta únicamente los datos recibidos del negocio y su catálogo', () => {
    const result = promptService.buildPrompt(
      business,
      [product],
      { shipping: 'Envío local', returns: 'Siete días', discounts: 'Ninguno' },
      false,
      'producto a',
    )

    expect(result).toContain('Nombre: Negocio A')
    expect(result).toContain('Dirección: Calle Uno')
    expect(result).toContain('- Producto A (Marca A) — $12.50')
    expect(result).toContain('Envíos: Envío local')
    expect(result).not.toContain('Negocio B')
    expect(result).not.toContain('Producto B')
  })

  it('reemplaza variables conocidas y conserva las desconocidas', () => {
    const result = promptService.buildPrompt(business, [], {
      bot_prompt: 'Soy {{ nombre_bot }} de {{NOMBRE_NEGOCIO}} en {{direccion}}. {{variable_futura}} [Negocio] [Nombre]',
    })

    expect(result).toContain(
      'Soy Asistente de Negocio A en Calle Uno. {{variable_futura}} Negocio A Asistente',
    )
  })

  it('solo habilita reservas con slots reales y un negocio que acepta citas', () => {
    const slots = {
      '2026-07-20': { label: 'Lunes 20', slots: ['09:00', '10:00'] },
    }
    const enabled = promptService.buildPrompt(
      { ...business, takes_bookings: true }, [product], {}, false, 'reservar', slots,
    )
    const disabled = promptService.buildPrompt(
      { ...business, takes_bookings: false }, [product], {}, false, 'reservar', slots,
    )
    const withoutSlots = promptService.buildPrompt(
      { ...business, takes_bookings: true }, [product], {}, false, 'reservar', null,
    )

    expect(enabled).toContain('Lunes 20 (2026-07-20): 09:00, 10:00')
    expect(enabled).toContain('##BOOK:NOMBRE|YYYY-MM-DD|HH:MM|SERVICIO##')
    expect(disabled).toContain('no recibe citas ni reservas mediante el bot')
    expect(disabled).not.toContain('Lunes 20 (2026-07-20)')
    expect(withoutSlots).toContain('no hay horarios disponibles')
    expect(withoutSlots).toContain('NO escribas ##BOOK##')
    expect(withoutSlots).not.toContain('no recibe citas ni reservas mediante el bot')
  })

  it('conserva las reglas duras de dinero y el modo informativo', () => {
    const salesPrompt = promptService.buildPrompt(
      { ...business, takes_orders: true }, [product], {},
    )
    const informationalPrompt = promptService.buildPrompt(
      { ...business, takes_orders: false }, [product], {},
    )

    expect(salesPrompt).toContain('##PEDIDO:nombre del producto x cantidad##')
    expect(salesPrompt).toContain('NUNCA escribas tú un total ni sumes precios')
    expect(informationalPrompt).toContain('modo INFORMATIVO')
    expect(informationalPrompt).toContain('precios unitarios, descripciones, stock')
    expect(informationalPrompt).toContain('NO es una compra y NO se deriva')
    expect(informationalPrompt).toContain('intención transaccional explícita')
    expect(informationalPrompt).toContain('##HANDOFF##')
    expect(informationalPrompt).not.toContain('##PEDIDO:nombre del producto x cantidad##')
    expect(informationalPrompt).toContain('No pidas dirección, método de pago')
    expect(informationalPrompt).not.toContain(
      'Para cerrar una compra, pide nombre, dirección y método de pago',
    )
    expect(salesPrompt).toContain(
      'NUNCA escribas más de una acción entre ##BOOK##, ##PEDIDO##',
    )
  })

  it('habilita hospedaje sin delegar cálculos ni reutilizar pedidos o citas', () => {
    const lodgingPrompt = promptService.buildPrompt(
      {
        ...business,
        type: 'hostal',
        takes_bookings: false,
        takes_orders: false,
        lodging_enabled: true,
      },
      [product],
      {},
    )

    expect(lodgingPrompt).toContain(
      '##STAY_QUOTE:YYYY-MM-DD|YYYY-MM-DD|HABITACIONES|ADULTOS|NIÑOS##',
    )
    const hoyEcuador = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Guayaquil',
    })
    expect(lodgingPrompt).toContain(`HOY es ${hoyEcuador}`)
    expect(lodgingPrompt).toContain('fechas FUTURAS a partir de hoy')
    expect(lodgingPrompt).toContain(
      '##STAY_REQUEST:TIPO_DE_HABITACION|NOMBRE_DEL_CONTACTO##',
    )
    expect(lodgingPrompt).toContain(
      'NUNCA calcules noches, habitaciones, disponibilidad, impuestos, tarifas ni totales',
    )
    expect(lodgingPrompt).toContain('pendiente del equipo autorizado')
    expect(lodgingPrompt).toContain(
      '##STAY_QUOTE## y ##STAY_REQUEST## son excluyentes',
    )
    expect(lodgingPrompt).toContain(
      'incluso si el cliente dice que quiere reservar',
    )
    expect(lodgingPrompt).not.toContain(
      '##PEDIDO:nombre del producto x cantidad##',
    )
    expect(lodgingPrompt).not.toContain(
      '##BOOK:NOMBRE|YYYY-MM-DD|HH:MM|SERVICIO##',
    )
  })

  it('adapta voz, fuera de horario y postventa sin filtrar enlaces', () => {
    const voicePrompt = promptService.buildPrompt(business, [product], {}, true)
    const closedSchedule = Array.from({ length: 7 }, (_, day) => ({
      day_of_week: day,
      open_time: '00:00:00',
      close_time: '00:00:00',
      is_active: true,
    }))
    const closedPrompt = promptService.buildPrompt(
      business, [product], {}, false, '', null, closedSchedule, false, true,
    )

    expect(voicePrompt).toContain('Es una llamada de voz: sin markdown ni emojis')
    expect(voicePrompt).not.toContain('este producto tiene una foto disponible')
    expect(closedPrompt).toContain('FUERA del horario de atención')
    expect(closedPrompt).toContain('ACABA DE COMPLETAR una compra')
    expect(closedPrompt).not.toContain(product.image_url)
  })

  it('mantiene etiquetas y servicio sin comprobaciones anuladas', () => {
    const service = fs.readFileSync(new URL('../src/services/prompt.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('##BOOK:NOMBRE|YYYY-MM-DD|HH:MM|SERVICIO##')
    expect(service).toContain('##PEDIDO:nombre del producto x cantidad##')
    expect(service).toContain('##HANDOFF##')
    expect(service).not.toContain('@ts-nocheck')
    expect(entry).toContain("require('./prompt')")
  })
})
