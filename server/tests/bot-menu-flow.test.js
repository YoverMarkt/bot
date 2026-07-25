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
  // Capacidad FIJA: ocupación base = tope (una doble para exactamente 2)
  { id: 'r3', name: 'Doble Estándar', base_rate: 40, pricing_model: 'per_unit', base_occupancy: 2, max_guests: 2 },
]

// Las opciones pueden ser texto simple o {title, description}: para las
// aserciones importa el título, que es lo que identifica la opción.
const titulos = options => options.map(o => (typeof o === 'string' ? o : o.title))
const detalle = (options, title) => {
  const found = options.find(o => (typeof o === 'string' ? o : o.title) === title)
  return typeof found === 'string' ? '' : (found?.description || '')
}

const enviar = (business, contact, message, extra = {}) => advanceMenuFlow({
  business, contact, message, products: [], ...extra,
})

describe('modo menú estilo banco (sin IA)', () => {
  it('da la bienvenida con el menú de capacidades reales, escriba lo que escriba el cliente', () => {
    resetMenuFlow(pizzeria.id, 'c1')
    const first = enviar(pizzeria, 'c1', 'quiero información de todo', { products: productos })
    expect(first.reply).toContain('Pizzería Don Luigi')
    expect(titulos(first.options)).toContain('🛒 Hacer un pedido')
    expect(titulos(first.options)).toContain('📋 Ver productos y precios')
    expect(titulos(first.options)).toContain('💬 Hablar con el equipo')
    expect(first.action).toBeUndefined()
  })

  it('arma un pedido completo solo con menús y el total sale del catálogo real', () => {
    resetMenuFlow(pizzeria.id, 'c2')
    const args = { products: productos }
    enviar(pizzeria, 'c2', 'hola', args)
    const categorias = enviar(pizzeria, 'c2', '🛒 Hacer un pedido', args)
    expect(titulos(categorias.options)).toContain('Pizzas')
    expect(titulos(categorias.options)).toContain('Bebidas')

    const lista = enviar(pizzeria, 'c2', 'Pizzas', args)
    expect(titulos(lista.options)).toContain('Pizza Hawaiana')
    expect(detalle(lista.options, 'Pizza Hawaiana')).toContain('$8.50')
    // El precio oferta manda sobre el precio normal, igual que el núcleo de dinero
    expect(detalle(lista.options, 'Pizza Pepperoni')).toContain('$7.50')

    enviar(pizzeria, 'c2', 'Pizza Hawaiana', args)
    const agregado = enviar(pizzeria, 'c2', '2', args)
    expect(agregado.reply).toContain('agregué 2x Pizza Hawaiana')
    expect(titulos(agregado.options)).toContain('✅ Finalizar pedido')

    enviar(pizzeria, 'c2', 'Bebidas', args)
    enviar(pizzeria, 'c2', 'Coca Cola 1.5L', args)
    enviar(pizzeria, 'c2', '1', args)
    const resumen = enviar(pizzeria, 'c2', '✅ Finalizar pedido', args)
    expect(resumen.reply).toContain('2x Pizza Hawaiana — $17.00')
    expect(resumen.reply).toContain('1x Coca Cola 1.5L — $2.50')
    expect(resumen.reply).toContain('Total: $19.50')

    const confirmado = enviar(pizzeria, 'c2', '✅ Confirmar pedido', args)
    expect(confirmado.action).toEqual(expect.objectContaining({ type: 'order', totalCents: 1950 }))
    expect(confirmado.reply).toContain('Pedido recibido')
  })

  it('usa la misma categoría canónica con tildes y puntuación en productos y modificadores', () => {
    const negocio = {
      id: 'categorias-con-tildes',
      name: 'Tienda Familiar',
      takes_orders: true,
      takes_bookings: false,
      lodging_enabled: false,
    }
    const catalogo = [
      {
        id: 'perfume-ninos',
        name: 'Colonia Infantil',
        price: 8,
        tags: ['perfumería & niños'],
        stock: 'disponible',
        active: true,
      },
      {
        id: 'te-frio',
        name: 'Té Helado',
        price: 2,
        tags: ['bebidas frías'],
        stock: 'disponible',
        active: true,
      },
    ]
    const args = {
      products: catalogo,
      modifiers: [{
        category_tag: 'PERFUMERÍA & NIÑOS',
        group_label: 'Aroma',
        name: 'Suave',
        description: 'Sin alcohol',
      }],
    }

    resetMenuFlow(negocio.id, 'acentos-a')
    enviar(negocio, 'acentos-a', 'hola', args)
    const categorias = enviar(negocio, 'acentos-a', '🛒 Hacer un pedido', args)
    expect(titulos(categorias.options)).toContain('Perfumería & niños')
    expect(titulos(categorias.options)).toContain('Bebidas frías')

    const aromas = enviar(negocio, 'acentos-a', 'Perfumería & niños', args)
    expect(titulos(aromas.options)).toContain('Suave')
    const productosPerfumeria = enviar(negocio, 'acentos-a', 'Suave', args)
    expect(titulos(productosPerfumeria.options)).toContain('Colonia Infantil')

    resetMenuFlow(negocio.id, 'acentos-b')
    enviar(negocio, 'acentos-b', 'hola', args)
    enviar(negocio, 'acentos-b', '📋 Ver productos y precios', args)
    const bebidas = enviar(negocio, 'acentos-b', 'Bebidas frías', args)
    expect(titulos(bebidas.options)).toContain('Té Helado')
  })

  it('repite el último pedido con los precios de HOY y descarta lo agotado', () => {
    resetMenuFlow(pizzeria.id, 'rep1')
    // La Hawaiana subió de $8.50 a $9.99 desde el pedido anterior y la Coca se agotó
    const catalogoHoy = [
      { id: 'p1', name: 'Pizza Hawaiana', price: 9.99, tags: ['pizzas'], stock: 'disponible', active: true },
      { id: 'p3', name: 'Coca Cola 1.5L', price: 2.5, tags: ['bebidas'], stock: 'agotado', active: true },
    ]
    const args = {
      products: catalogoHoy,
      lastOrderItems: [
        { product_id: 'p1', product_name: 'Pizza Hawaiana', quantity: 2 },
        { product_id: 'p3', product_name: 'Coca Cola 1.5L', quantity: 1 },
      ],
    }

    const bienvenida = enviar(pizzeria, 'rep1', 'hola', args)
    expect(titulos(bienvenida.options)).toContain('🔄 Repetir mi último pedido')

    const repetido = enviar(pizzeria, 'rep1', '🔄 Repetir mi último pedido', args)
    // Precio de HOY (9.99 x2 = 19.98), jamás el histórico de 8.50
    expect(repetido.reply).toContain('2x Pizza Hawaiana — $19.98')
    expect(repetido.reply).toContain('Total: $19.98')
    // Lo agotado se descarta y se avisa: no se vende lo que no hay
    expect(repetido.reply).toContain('Coca Cola 1.5L')
    expect(repetido.reply).toContain('Ya no tenemos')

    const confirmado = enviar(pizzeria, 'rep1', '✅ Confirmar pedido', args)
    expect(confirmado.action).toEqual(expect.objectContaining({ type: 'order', totalCents: 1998 }))
  })

  it('pagina las categorías cuando pasan de 10, respetando el tope de WhatsApp', () => {
    // 12 categorías: no caben en una lista de WhatsApp (máximo 10 filas)
    const catalogoGrande = Array.from({ length: 12 }, (_, index) => ({
      id: `p${index}`,
      name: `Producto ${index}`,
      price: 5,
      tags: [`categoria${index}`],
      stock: 'disponible',
      active: true,
    }))
    resetMenuFlow(pizzeria.id, 'pag1')
    const args = { products: catalogoGrande }
    enviar(pizzeria, 'pag1', 'hola', args)
    const pagina1 = enviar(pizzeria, 'pag1', '🛒 Hacer un pedido', args)

    // 9 categorías + "Ver más" + "Volver" = 11 títulos; las filas que van a la
    // lista de WhatsApp son las 9 + Ver más = 10, justo el tope
    const t1 = titulos(pagina1.options)
    expect(t1.filter(x => x.startsWith('Categoria')).length).toBe(9)
    expect(t1).toContain('➡️ Ver más')
    expect(detalle(pagina1.options, 'Categoria0')).toContain('1 producto')

    const pagina2 = enviar(pizzeria, 'pag1', '➡️ Ver más', args)
    const t2 = titulos(pagina2.options)
    expect(t2.filter(x => x.startsWith('Categoria')).length).toBe(3)
    expect(t2).not.toContain('➡️ Ver más')
  })

  it('no ofrece repetir pedido si el cliente no tiene uno anterior', () => {
    resetMenuFlow(pizzeria.id, 'rep2')
    const bienvenida = enviar(pizzeria, 'rep2', 'hola', { products: productos })
    expect(titulos(bienvenida.options)).not.toContain('🔄 Repetir mi último pedido')
  })

  it('acepta el número de la lista como en el banco y repite el menú si no entiende', () => {
    resetMenuFlow(pizzeria.id, 'c3')
    const args = { products: productos }
    const bienvenida = enviar(pizzeria, 'c3', 'hola', args)
    const porNumero = enviar(pizzeria, 'c3', '1', args)
    expect(titulos(porNumero.options)).toContain('Pizzas')

    const raro = enviar(pizzeria, 'c3', 'quiero un descuento del 50%', args)
    expect(raro.reply).toContain('No te entendí')
    expect(bienvenida.options.length).toBeGreaterThan(0)
  })

  it('responde los saludos naturales con una bienvenida cordial y el nombre del negocio', () => {
    const args = {
      products: [],
      roomTypes: habitaciones,
      botPrompt: 'Eres Andrea, la recepcionista virtual de {{nombre_negocio}}, un hostal acogedor.',
    }
    const saludos = [
      'Hola buenas tardes',
      '¡Buenos días!',
      'Buenas noches, quisiera información',
      'Muy buenas',
    ]

    saludos.forEach((saludo, index) => {
      const contact = `saludo-${index}`
      resetMenuFlow(hostal.id, contact)
      enviar(hostal, contact, 'hola', args)
      enviar(hostal, contact, '🛏️ Ver habitaciones', args)

      const respuesta = enviar(hostal, contact, saludo, args)
      expect(respuesta.reply).toContain('¡Hola! 👋')
      expect(respuesta.reply).toContain('Soy Andrea')
      expect(respuesta.reply).toContain('recepcionista virtual de Hostal')
      expect(respuesta.reply).not.toContain('No te entendí')
      expect(titulos(respuesta.options)).toEqual(['🛏️ Ver habitaciones'])
    })

    resetMenuFlow(hostal.id, 'saludo-configurado')
    const configurado = enviar(hostal, 'saludo-configurado', 'hola', {
      ...args,
      botPrompt: 'Saludo inicial: "Bienvenido a {{nombre_negocio}}. Es un placer atenderle."',
    })
    expect(configurado.reply).toContain('Bienvenido a Hostal Vista Andina. Es un placer atenderle.')
  })

  it('entiende frases naturales sobre habitaciones desde el menú principal', () => {
    const args = { products: [], roomTypes: habitaciones }
    const mensajes = [
      'De las habitaciones',
      'Necesito información de una habitación',
      'Quiero ver los cuartos',
      'Información del hospedaje',
      'Busco alojamiento',
      'Hola\nNecesito\nInformación\nDe las habitaciones',
    ]

    mensajes.forEach((message, index) => {
      const contact = `intencion-habitaciones-${index}`
      resetMenuFlow(hostal.id, contact)
      enviar(hostal, contact, 'hola', args)

      const respuesta = enviar(hostal, contact, message, args)
      expect(respuesta.reply).toBe('Estas son nuestras habitaciones 👇')
      expect(respuesta.reply).not.toContain('No te entendí')
      expect(titulos(respuesta.options)).toContain('Matrimonial')
      expect(titulos(respuesta.options)).toContain('Familiar')
      expect(respuesta.action).toBeUndefined()
    })
  })

  it('recibe al huésped SOLO con habitaciones y cotiza desde la habitación elegida', () => {
    resetMenuFlow(hostal.id, 'c4')
    const args = { products: [], roomTypes: habitaciones }
    const bienvenida = enviar(hostal, 'c4', 'hola', args)
    // Decisión del dueño: primero las habitaciones, sin cotizar ni equipo
    expect(titulos(bienvenida.options)).toEqual(['🛏️ Ver habitaciones'])

    const cuartos = enviar(hostal, 'c4', '🛏️ Ver habitaciones', args)
    expect(titulos(cuartos.options)).toContain('Matrimonial')
    expect(detalle(cuartos.options, 'Matrimonial')).toContain('$45.00/noche')
    // La descripción lidera con la capacidad total de la habitación
    expect(detalle(cuartos.options, 'Matrimonial')).toContain('Para 2 huésped')
    // Tarifa por persona: se muestra "desde", el total exacto lo da la cotización
    expect(detalle(cuartos.options, 'Familiar')).toContain('desde $70.00/noche')

    const detalleHab = enviar(hostal, 'c4', 'Matrimonial', args)
    expect(detalleHab.reply).toContain('Matrimonial')
    expect(detalleHab.reply).toContain('Incluye: wifi, desayuno, baño privado')
    expect(detalleHab.reply).toContain('hasta 2 persona(s)')
    expect(detalleHab.reply).toContain('Tarifa: $45.00/noche')
    // El botón de cotizar aparece recién al elegir la habitación
    expect(titulos(detalleHab.options)).toContain('📅 Cotizar estadía')

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

    // Matrimonial (cap. 2): con 2 adultos ya se llena, así que NO pregunta
    // niños; cotiza directo con 0 (la habitación acota las opciones)
    const cotizacion = enviar(hostal, 'c4', '2', args)

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
    expect(titulos(cotizacion.options)).toContain('🛎️ Solicitar esta habitación')

    // Cierre del flujo: solicitar la habitación con el nombre del huésped
    const nombre = enviar(hostal, 'c4', '🛎️ Solicitar esta habitación', args)
    expect(nombre.reply).toContain('nombre')
    const solicitud = enviar(hostal, 'c4', 'Carlos Pérez', args)
    expect(solicitud.action).toEqual({ type: 'stay_request', roomTypeId: 'r1', contactName: 'Carlos Pérez' })
    expect(solicitud.reply).toContain('Matrimonial')
    expect(solicitud.reply).toContain('Carlos Pérez')
  })

  it('registra la solicitud al tocar el botón nativo por NÚMERO tras la cotización', () => {
    // En WhatsApp el botón envía el NÚMERO de opción, no el título. Tras la
    // cotización, "1" debe ser "Solicitar esta habitación" (no la opción 1 del
    // menú principal): antes se perdía y el hold nunca se creaba.
    resetMenuFlow(hostal.id, 'nativo')
    const args = { products: [], roomTypes: habitaciones }
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
    const entrada = masDias(hoyEcuador(), 45)
    const salida = masDias(entrada, 1)
    const dia = iso => Number(iso.slice(8, 10))
    const mes = iso => MESES[Number(iso.slice(5, 7)) - 1]
    const frase = mes(entrada) === mes(salida)
      ? `del ${dia(entrada)} al ${dia(salida)} de ${mes(entrada)}`
      : `del ${dia(entrada)} de ${mes(entrada)} al ${dia(salida)} de ${mes(salida)}`

    enviar(hostal, 'nativo', 'hola', args)
    enviar(hostal, 'nativo', '🛏️ Ver habitaciones', args)
    enviar(hostal, 'nativo', 'Matrimonial', args)
    enviar(hostal, 'nativo', '📅 Cotizar estadía', args)
    enviar(hostal, 'nativo', frase, args)
    const cotizacion = enviar(hostal, 'nativo', '2', args) // 2 adultos (cap. 2) → cotiza
    // La opción 1 tras la cotización es "Solicitar esta habitación"
    expect(titulos(cotizacion.options)[0]).toBe('🛎️ Solicitar esta habitación')

    // El cliente TOCA el botón → el canal manda el número "1", no el título
    const nombre = enviar(hostal, 'nativo', '1', args)
    expect(nombre.reply).toContain('nombre')
    const solicitud = enviar(hostal, 'nativo', 'Ana Torres', args)
    expect(solicitud.action).toEqual({ type: 'stay_request', roomTypeId: 'r1', contactName: 'Ana Torres' })
  })

  it('acota adultos y niños a la capacidad real de la habitación', () => {
    resetMenuFlow(hostal.id, 'cap')
    const args = { products: [], roomTypes: habitaciones }
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
    const entrada = masDias(hoyEcuador(), 50)
    const salida = masDias(entrada, 2)
    const dia = iso => Number(iso.slice(8, 10))
    const mes = iso => MESES[Number(iso.slice(5, 7)) - 1]
    const frase = mes(entrada) === mes(salida)
      ? `del ${dia(entrada)} al ${dia(salida)} de ${mes(entrada)}`
      : `del ${dia(entrada)} de ${mes(entrada)} al ${dia(salida)} de ${mes(salida)}`

    enviar(hostal, 'cap', 'hola', args)
    enviar(hostal, 'cap', '🛏️ Ver habitaciones', args)
    enviar(hostal, 'cap', 'Familiar', args) // capacidad 4
    enviar(hostal, 'cap', '📅 Cotizar estadía', args)
    const adultos = enviar(hostal, 'cap', frase, args)
    // Familiar (cap. 4): ofrece 1..4 adultos, nunca más que la capacidad
    expect(titulos(adultos.options)).toEqual(['1', '2', '3', '4'])

    // Con 1 adulto todavía caben 3 → sí pregunta niños, hasta 3
    const ninos = enviar(hostal, 'cap', '1', args)
    expect(titulos(ninos.options)).toEqual(['0', '1', '2', '3'])
    expect(ninos.action).toBeUndefined()

    // 2 niños → cotiza 1 adulto + 2 niños con la habitación elegida
    const cotizacion = enviar(hostal, 'cap', '2', args)
    expect(cotizacion.action).toEqual({
      type: 'stay_quote',
      quote: { checkIn: entrada, checkOut: salida, roomsCount: 1, adults: 1, children: 2, roomTypeId: 'r2' },
    })
  })

  it('pagina la lista de habitaciones cuando pasan de 8, respetando el tope de WhatsApp', () => {
    // 11 habitaciones: no caben en una lista de WhatsApp (máximo 10 filas)
    const muchas = Array.from({ length: 11 }, (_, index) => ({
      id: `h${index}`,
      name: `Habitación ${index}`,
      base_rate: 30 + index,
      pricing_model: 'per_unit',
      base_occupancy: 1,
      max_guests: 2,
    }))
    resetMenuFlow(hostal.id, 'pagcuartos')
    const args = { products: [], roomTypes: muchas }
    enviar(hostal, 'pagcuartos', 'hola', args)

    const pagina1 = enviar(hostal, 'pagcuartos', '🛏️ Ver habitaciones', args)
    const t1 = titulos(pagina1.options)
    // 8 habitaciones + Ver más + Volver = 10 filas, justo el tope de WhatsApp
    expect(t1.filter(x => x.startsWith('Habitación')).length).toBe(8)
    expect(t1).toContain('➡️ Ver más')
    expect(t1).toContain('⬅️ Volver')
    expect(pagina1.options.length).toBe(10)

    const pagina2 = enviar(hostal, 'pagcuartos', '➡️ Ver más', args)
    const t2 = titulos(pagina2.options)
    expect(t2.filter(x => x.startsWith('Habitación')).length).toBe(3)
    expect(t2).not.toContain('➡️ Ver más')

    // Se puede elegir una habitación de la segunda página
    const detalleHab = enviar(hostal, 'pagcuartos', 'Habitación 10', args)
    expect(detalleHab.reply).toContain('Habitación 10')
  })

  it('en una habitación de capacidad fija no pregunta por personas: cotiza directo', () => {
    resetMenuFlow(hostal.id, 'fija')
    const args = { products: [], roomTypes: habitaciones }
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
    const entrada = masDias(hoyEcuador(), 55)
    const salida = masDias(entrada, 1)
    const dia = iso => Number(iso.slice(8, 10))
    const mes = iso => MESES[Number(iso.slice(5, 7)) - 1]
    const frase = mes(entrada) === mes(salida)
      ? `del ${dia(entrada)} al ${dia(salida)} de ${mes(entrada)}`
      : `del ${dia(entrada)} de ${mes(entrada)} al ${dia(salida)} de ${mes(salida)}`

    enviar(hostal, 'fija', 'hola', args)
    enviar(hostal, 'fija', '🛏️ Ver habitaciones', args)
    enviar(hostal, 'fija', 'Doble Estándar', args) // base 2 = tope 2 → fija
    enviar(hostal, 'fija', '📅 Cotizar estadía', args)
    // Escritas las fechas, cotiza al toque con la capacidad (2), sin preguntar
    const cotizacion = enviar(hostal, 'fija', frase, args)
    expect(cotizacion.action).toEqual({
      type: 'stay_quote',
      quote: { checkIn: entrada, checkOut: salida, roomsCount: 1, adults: 2, children: 0, roomTypeId: 'r3' },
    })
    // Ya ofrece solicitar la habitación (no preguntó adultos ni niños)
    expect(titulos(cotizacion.options)).toContain('🛎️ Solicitar esta habitación')
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

  it('pizza: elige SABOR (con ingredientes) y luego TAMAÑO, precio exacto y sabor pegado', () => {
    const pizzeria2 = { id: 'monster-pizza', name: 'Monster Pizza', takes_orders: true, takes_bookings: false, lodging_enabled: false }
    const pizzaProducts = [
      { id: 'ps1', name: 'Pizza Personal', price: 2.75, tags: ['pizzas'], stock: 'disponible', active: true },
      { id: 'ps2', name: 'Pizza Familiar', price: 10.50, tags: ['pizzas'], stock: 'disponible', active: true },
      { id: 'b1', name: 'Cola 1 Litro', price: 1.50, tags: ['bebidas'], stock: 'disponible', active: true },
    ]
    const sabores = [
      { category_tag: 'pizzas', group_label: 'Sabor', name: 'Hawaiana', description: 'Jamón y piña' },
      { category_tag: 'pizzas', group_label: 'Sabor', name: 'Monster', description: 'Pepperoni, carne y champiñones' },
    ]
    const args = { products: pizzaProducts, modifiers: sabores }

    resetMenuFlow(pizzeria2.id, 'pz1')
    enviar(pizzeria2, 'pz1', 'hola', args)
    const cats = enviar(pizzeria2, 'pz1', '🛒 Hacer un pedido', args)
    expect(titulos(cats.options)).toContain('Pizzas')

    // Al elegir Pizzas (categoría con sabores) primero pregunta el SABOR con ingredientes
    const flavors = enviar(pizzeria2, 'pz1', 'Pizzas', args)
    expect(flavors.reply).toContain('Elige el sabor')
    expect(titulos(flavors.options)).toContain('Hawaiana')
    expect(detalle(flavors.options, 'Hawaiana')).toContain('Jamón y piña')

    // Elegido el sabor, ahora el TAMAÑO con su precio real
    const sizes = enviar(pizzeria2, 'pz1', 'Hawaiana', args)
    expect(sizes.reply).toContain('tamaño')
    expect(titulos(sizes.options)).toContain('Pizza Familiar')
    expect(detalle(sizes.options, 'Pizza Familiar')).toContain('$10.50')

    enviar(pizzeria2, 'pz1', 'Pizza Familiar', args)
    const added = enviar(pizzeria2, 'pz1', '1', args)
    expect(added.reply).toContain('Pizza Familiar — Hawaiana')

    const resumen = enviar(pizzeria2, 'pz1', '✅ Finalizar pedido', args)
    expect(resumen.reply).toContain('Pizza Familiar — Hawaiana')
    expect(resumen.reply).toContain('Total: $10.50')

    const confirmado = enviar(pizzeria2, 'pz1', '✅ Confirmar pedido', args)
    expect(confirmado.action).toEqual(expect.objectContaining({ type: 'order', totalCents: 1050 }))
    // El pedido lleva el tamaño (para el precio) y el sabor como modificador
    expect(confirmado.action.items).toEqual([{ name: 'Pizza Familiar', qty: 1, note: 'Hawaiana' }])

    // Una categoría SIN sabores (bebidas) va directo a los productos
    resetMenuFlow(pizzeria2.id, 'pz2')
    enviar(pizzeria2, 'pz2', 'hola', args)
    enviar(pizzeria2, 'pz2', '🛒 Hacer un pedido', args)
    const bebidas = enviar(pizzeria2, 'pz2', 'Bebidas', args)
    expect(titulos(bebidas.options)).toContain('Cola 1 Litro')
    expect(bebidas.reply).not.toContain('sabor')
  })

  it('hospedaje: ofrece "Ver fotos y videos" solo si la habitación tiene media y las envía (fotos primero, video al final)', () => {
    resetMenuFlow(hostal.id, 'media-hab')
    const conMedia = [
      {
        id: 'rm1', name: 'Suite Vista', base_rate: 60, pricing_model: 'per_unit', max_guests: 2,
        media_urls: [
          'https://res.cloudinary.com/demo/image/upload/foto1.jpg',
          'https://res.cloudinary.com/demo/video/upload/tour.mp4',
          'https://res.cloudinary.com/demo/image/upload/foto2.jpg',
        ],
      },
      // Sin media: no debe ofrecer el paso de fotos
      { id: 'rm2', name: 'Sencilla', base_rate: 30, pricing_model: 'per_unit', max_guests: 1 },
    ]
    const args = { products: [], roomTypes: conMedia }
    enviar(hostal, 'media-hab', 'hola', args)
    enviar(hostal, 'media-hab', '🛏️ Ver habitaciones', args)

    const conFotos = enviar(hostal, 'media-hab', 'Suite Vista', args)
    expect(titulos(conFotos.options)).toContain('📷 Ver fotos y videos')
    expect(conFotos.reply).toContain('¿Quieres ver las fotos y videos')

    const enviadas = enviar(hostal, 'media-hab', '📷 Ver fotos y videos', args)
    // Fotos primero, el video al final; solo URLs HTTPS
    expect(enviadas.media).toEqual([
      { url: 'https://res.cloudinary.com/demo/image/upload/foto1.jpg', isVideo: false },
      { url: 'https://res.cloudinary.com/demo/image/upload/foto2.jpg', isVideo: false },
      { url: 'https://res.cloudinary.com/demo/video/upload/tour.mp4', isVideo: true },
    ])
    // Tras enviarlas, el cliente puede seguir con la cotización (sin repetir el botón de fotos)
    expect(titulos(enviadas.options)).toContain('📅 Cotizar estadía')
    expect(titulos(enviadas.options)).not.toContain('📷 Ver fotos y videos')

    // Volver a la lista y abrir la habitación SIN media: no ofrece el paso de fotos
    enviar(hostal, 'media-hab', '⬅️ Volver', args)
    const sinFotos = enviar(hostal, 'media-hab', 'Sencilla', args)
    expect(titulos(sinFotos.options)).not.toContain('📷 Ver fotos y videos')
  })

  it('pedido: un producto con foto pasa por su detalle para ver qué comprará; sin foto va directo a la cantidad', () => {
    const pizzeria3 = { id: 'pizza-media', name: 'Pizza Media', takes_orders: true, takes_bookings: false, lodging_enabled: false }
    const conFoto = [
      { id: 'pm1', name: 'Pizza Deluxe', price: 12, tags: ['pizzas'], stock: 'disponible', active: true, image_url: 'https://res.cloudinary.com/demo/image/upload/deluxe.jpg', video_url: 'https://res.cloudinary.com/demo/video/upload/deluxe.mp4' },
      { id: 'pm2', name: 'Pizza Simple', price: 8, tags: ['pizzas'], stock: 'disponible', active: true },
    ]
    const args = { products: conFoto }

    resetMenuFlow(pizzeria3.id, 'pm-a')
    enviar(pizzeria3, 'pm-a', 'hola', args)
    enviar(pizzeria3, 'pm-a', '🛒 Hacer un pedido', args)
    enviar(pizzeria3, 'pm-a', 'Pizzas', args)
    // Con foto: al elegirla se muestra el detalle con el paso de fotos y "Pedirlo"
    const detalleProd = enviar(pizzeria3, 'pm-a', 'Pizza Deluxe', args)
    expect(titulos(detalleProd.options)).toContain('📷 Ver fotos y videos')
    expect(titulos(detalleProd.options)).toContain('🛒 Pedirlo')

    const fotos = enviar(pizzeria3, 'pm-a', '📷 Ver fotos y videos', args)
    expect(fotos.media).toEqual([
      { url: 'https://res.cloudinary.com/demo/image/upload/deluxe.jpg', isVideo: false },
      { url: 'https://res.cloudinary.com/demo/video/upload/deluxe.mp4', isVideo: true },
    ])

    // Sin foto: al elegirla va directo a la cantidad (ruta rápida, sin detalle)
    resetMenuFlow(pizzeria3.id, 'pm-b')
    enviar(pizzeria3, 'pm-b', 'hola', args)
    enviar(pizzeria3, 'pm-b', '🛒 Hacer un pedido', args)
    enviar(pizzeria3, 'pm-b', 'Pizzas', args)
    const cantidad = enviar(pizzeria3, 'pm-b', 'Pizza Simple', args)
    expect(cantidad.reply).toContain('¿Cuántas unidades')
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
    expect(titulos(bienvenida.options)).toContain('📅 Agendar una cita')

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
