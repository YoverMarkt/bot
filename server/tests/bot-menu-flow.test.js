import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { advanceMenuFlow, parseStayRange, resetMenuFlow } = require('../dist/services/bot-menu-flow')

const hoyEcuador = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })
const masDias = (iso, dias) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + dias * 86_400_000)
  .toISOString().slice(0, 10)

const pizzeria = {
  id: 'pizzeria-test',
  name: 'Pizzería Don Luigi',
  takes_orders: true,
  takes_bookings: false,
  lodging_enabled: false,
}

const productos = [
  { id: 'p1', name: 'Pizza Hawaiana', price: 8.5, tags: ['pizzas'], stock: 'disponible', active: true },
  { id: 'p2', name: 'Pizza Pepperoni', price: 9, price_sale: 7.5, tags: ['pizzas'], stock: 'disponible', active: true },
  { id: 'p3', name: 'Coca Cola 1.5L', price: 2.5, tags: ['bebidas'], stock: 'disponible', active: true },
]

const hostal = {
  id: 'hostal-test',
  name: 'Hostal Vista Andina',
  takes_orders: false,
  takes_bookings: false,
  lodging_enabled: true,
}

const habitaciones = [
  { id: 'r1', name: 'Matrimonial', description: 'Cama queen con vista', amenities: ['wifi', 'desayuno', 'baño privado'], base_rate: 45, pricing_model: 'per_unit', max_guests: 2 },
  { id: 'r2', name: 'Familiar', description: 'Dos ambientes', base_rate: 70, pricing_model: 'per_person', max_guests: 4 },
]

const enviar = (business, contact, message, extra = {}) => advanceMenuFlow({
  business, contact, message, products: [], ...extra,
})

describe('modo menú estilo banco (sin IA)', () => {
  it('da la bienvenida con el menú de capacidades reales, escriba lo que escriba el cliente', () => {
    resetMenuFlow(pizzeria.id, 'c1')
    const first = enviar(pizzeria, 'c1', 'quiero información de todo', { products: productos })
    expect(first.reply).toContain('Pizzería Don Luigi')
    expect(first.options).toContain('🛒 Hacer un pedido')
    expect(first.options).toContain('📋 Ver productos y precios')
    expect(first.options).toContain('💬 Hablar con el equipo')
    expect(first.action).toBeUndefined()
  })

  it('arma un pedido completo solo con menús y el total sale del catálogo real', () => {
    resetMenuFlow(pizzeria.id, 'c2')
    const args = { products: productos }
    enviar(pizzeria, 'c2', 'hola', args)
    const categorias = enviar(pizzeria, 'c2', '🛒 Hacer un pedido', args)
    expect(categorias.options).toContain('Pizzas')
    expect(categorias.options).toContain('Bebidas')

    const lista = enviar(pizzeria, 'c2', 'Pizzas', args)
    expect(lista.options).toContain('Pizza Hawaiana — $8.50')
    // El precio oferta manda sobre el precio normal, igual que el núcleo de dinero
    expect(lista.options).toContain('Pizza Pepperoni — $7.50')

    enviar(pizzeria, 'c2', 'Pizza Hawaiana — $8.50', args)
    const agregado = enviar(pizzeria, 'c2', '2', args)
    expect(agregado.reply).toContain('agregué 2x Pizza Hawaiana')
    expect(agregado.options).toContain('✅ Finalizar pedido')

    enviar(pizzeria, 'c2', 'Bebidas', args)
    enviar(pizzeria, 'c2', 'Coca Cola 1.5L — $2.50', args)
    enviar(pizzeria, 'c2', '1', args)
    const resumen = enviar(pizzeria, 'c2', '✅ Finalizar pedido', args)
    expect(resumen.reply).toContain('2x Pizza Hawaiana — $17.00')
    expect(resumen.reply).toContain('1x Coca Cola 1.5L — $2.50')
    expect(resumen.reply).toContain('Total: $19.50')

    const confirmado = enviar(pizzeria, 'c2', '✅ Confirmar pedido', args)
    expect(confirmado.action).toEqual(expect.objectContaining({ type: 'order', totalCents: 1950 }))
    expect(confirmado.reply).toContain('Pedido recibido')
  })

  it('acepta el número de la lista como en el banco y repite el menú si no entiende', () => {
    resetMenuFlow(pizzeria.id, 'c3')
    const args = { products: productos }
    const bienvenida = enviar(pizzeria, 'c3', 'hola', args)
    const porNumero = enviar(pizzeria, 'c3', '1', args)
    expect(porNumero.options).toContain('Pizzas')

    const raro = enviar(pizzeria, 'c3', 'quiero un descuento del 50%', args)
    expect(raro.reply).toContain('No te entendí')
    expect(bienvenida.options.length).toBeGreaterThan(0)
  })

  it('recibe al huésped SOLO con habitaciones y cotiza desde la habitación elegida', () => {
    resetMenuFlow(hostal.id, 'c4')
    const args = { products: [], roomTypes: habitaciones }
    const bienvenida = enviar(hostal, 'c4', 'hola', args)
    // Decisión del dueño: primero las habitaciones, sin cotizar ni equipo
    expect(bienvenida.options).toEqual(['🛏️ Ver habitaciones'])

    const cuartos = enviar(hostal, 'c4', '🛏️ Ver habitaciones', args)
    expect(cuartos.options).toContain('Matrimonial — $45.00/noche')
    // Tarifa por persona: se muestra "desde", el total exacto lo da la cotización
    expect(cuartos.options).toContain('Familiar — desde $70.00/noche')

    const detalle = enviar(hostal, 'c4', 'Matrimonial — $45.00/noche', args)
    expect(detalle.reply).toContain('Matrimonial')
    expect(detalle.reply).toContain('Incluye: wifi, desayuno, baño privado')
    expect(detalle.reply).toContain('hasta 2 persona(s)')
    expect(detalle.reply).toContain('Tarifa: $45.00/noche')
    // El botón de cotizar aparece recién al elegir la habitación
    expect(detalle.options).toContain('📅 Cotizar estadía')

    // Fechas escritas por el huésped CON MES, confirmadas con el calendario real
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
    const entrada = masDias(hoyEcuador(), 40)
    const salida = masDias(entrada, 2)
    const dia = iso => Number(iso.slice(8, 10))
    const mes = iso => MESES[Number(iso.slice(5, 7)) - 1]
    const frase = mes(entrada) === mes(salida)
      ? `del ${dia(entrada)} al ${dia(salida)} de ${mes(entrada)}`
      : `del ${dia(entrada)} de ${mes(entrada)} al ${dia(salida)} de ${mes(salida)}`

    const fechas = enviar(hostal, 'c4', '📅 Cotizar estadía', args)
    // La habitación elegida acompaña la cotización y NO se pregunta cuántas
    // habitaciones: eso lo calcula el servidor según personas y capacidad
    expect(fechas.reply).toContain('Matrimonial')
    expect(fechas.reply).toContain('CON EL MES')

    // Sin mes → se rechaza y se pide el mes
    const sinMes = enviar(hostal, 'c4', 'del 24 al 26', args)
    expect(sinMes.reply).toContain('MES')
    expect(sinMes.action).toBeUndefined()

    const confirmadas = enviar(hostal, 'c4', frase, args)
    expect(confirmadas.reply).toContain('¡Perfecto! Del')
    expect(confirmadas.reply).toContain('adultos')
    expect(confirmadas.reply).not.toContain('habitaciones')

    enviar(hostal, 'c4', '2', args)
    const cotizacion = enviar(hostal, 'c4', '0', args)

    // La cotización viaja con la habitación elegida para que el servidor
    // muestre SOLO esa habitación (las demás, únicamente si no hay cupo)
    expect(cotizacion.action).toEqual({
      type: 'stay_quote',
      quote: {
        checkIn: entrada,
        checkOut: salida,
        roomsCount: 1,
        adults: 2,
        children: 0,
        roomTypeId: 'r1',
      },
    })
    expect(cotizacion.options).toContain('🛎️ Solicitar esta habitación')

    // Cierre del flujo: solicitar la habitación con el nombre del huésped
    const nombre = enviar(hostal, 'c4', '🛎️ Solicitar esta habitación', args)
    expect(nombre.reply).toContain('nombre')
    const solicitud = enviar(hostal, 'c4', 'Carlos Pérez', args)
    expect(solicitud.action).toEqual({ type: 'stay_request', roomTypeId: 'r1', contactName: 'Carlos Pérez' })
    expect(solicitud.reply).toContain('Matrimonial')
    expect(solicitud.reply).toContain('Carlos Pérez')
  })

  it('entiende los formatos reales de fechas y exige el mes cuando falta', () => {
    const hoy = '2026-07-19'
    // El caso canónico del dueño
    expect(parseStayRange('del 24 al 26 de julio', hoy)).toEqual({ ok: true, checkIn: '2026-07-24', checkOut: '2026-07-26' })
    // Día de semana decorativo y meses distintos
    expect(parseStayRange('el viernes 24 de julio al 2 de agosto', hoy)).toEqual({ ok: true, checkIn: '2026-07-24', checkOut: '2026-08-02' })
    // La salida hereda el mes; si queda antes, es el mes siguiente
    expect(parseStayRange('del 30 de julio al 2', hoy)).toEqual({ ok: true, checkIn: '2026-07-30', checkOut: '2026-08-02' })
    // Cruce de año: enero ya pasó este año → el próximo
    expect(parseStayRange('del 30 de diciembre al 2 de enero', hoy)).toEqual({ ok: true, checkIn: '2026-12-30', checkOut: '2027-01-02' })
    // Días de semana puros y relativos, resueltos por el calendario
    expect(parseStayRange('del lunes al miercoles', hoy)).toEqual({ ok: true, checkIn: '2026-07-20', checkOut: '2026-07-22' })
    expect(parseStayRange('de hoy a mañana', hoy)).toEqual({ ok: true, checkIn: '2026-07-19', checkOut: '2026-07-20' })
    // Numérico con mes incluido y rango con guion
    expect(parseStayRange('del 24/07 al 26/07', hoy)).toEqual({ ok: true, checkIn: '2026-07-24', checkOut: '2026-07-26' })
    expect(parseStayRange('24-26 de julio', hoy)).toEqual({ ok: true, checkIn: '2026-07-24', checkOut: '2026-07-26' })
    // Typos y variantes reales: "de de" repetido, sin "de", mes adelante
    expect(parseStayRange('20 al 22 de de julio', hoy)).toEqual({ ok: true, checkIn: '2026-07-20', checkOut: '2026-07-22' })
    expect(parseStayRange('del 20 al 22 julio', hoy)).toEqual({ ok: true, checkIn: '2026-07-20', checkOut: '2026-07-22' })
    expect(parseStayRange('del 30 al 2 de de agosto', hoy)).toEqual({ ok: true, checkIn: '2026-07-30', checkOut: '2026-08-02' })
    expect(parseStayRange('julio 20 al 22', hoy)).toEqual({ ok: true, checkIn: '2026-07-20', checkOut: '2026-07-22' })
    // Rechazos: sin mes, falta una fecha, rango imposible
    expect(parseStayRange('del 24 al 26', hoy)).toEqual({ ok: false, reason: 'sin_mes' })
    expect(parseStayRange('el 24 de julio', hoy)).toEqual({ ok: false, reason: 'falta_salida' })
    expect(parseStayRange('del 26 de julio al 26 de julio', hoy)).toEqual({ ok: false, reason: 'rango' })
    expect(parseStayRange('no se todavia', hoy)).toEqual({ ok: false, reason: 'no_entendi' })
  })

  it('deriva al equipo cuando el cliente lo pide y con la opción del menú', () => {
    resetMenuFlow(pizzeria.id, 'c5')
    const args = { products: productos }
    enviar(pizzeria, 'c5', 'hola', args)
    const porTexto = enviar(pizzeria, 'c5', 'asesor', args)
    expect(porTexto.action).toEqual({ type: 'handoff' })

    resetMenuFlow(pizzeria.id, 'c6')
    enviar(pizzeria, 'c6', 'hola', args)
    const porOpcion = enviar(pizzeria, 'c6', '💬 Hablar con el equipo', args)
    expect(porOpcion.action).toEqual({ type: 'handoff' })
  })

  it('agenda una cita con la agenda real: día, hora y nombre', () => {
    const barberia = { id: 'barberia-test', name: 'Barbería', takes_orders: false, takes_bookings: true }
    const slots = {
      '2099-01-04': { label: 'lunes 4 de enero', slots: ['10:00', '11:00'] },
      '2099-01-05': { label: 'martes 5 de enero', slots: ['09:00'] },
    }
    resetMenuFlow(barberia.id, 'c7')
    const args = { products: [], availableSlots: slots }
    const bienvenida = enviar(barberia, 'c7', 'hola', args)
    expect(bienvenida.options).toContain('📅 Agendar una cita')

    const dias = enviar(barberia, 'c7', '📅 Agendar una cita', args)
    expect(dias.options).toContain('lunes 4 de enero')
    const horas = enviar(barberia, 'c7', 'lunes 4 de enero', args)
    expect(horas.options).toContain('10:00')
    enviar(barberia, 'c7', '10:00', args)
    const cita = enviar(barberia, 'c7', 'Carlos Pérez', args)
    expect(cita.action).toEqual({ type: 'booking', date: '2099-01-04', time: '10:00', name: 'Carlos Pérez' })
    expect(cita.reply).toContain('Carlos Pérez')
  })
})
