import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { advanceMenuFlow, resetMenuFlow } = require('../dist/services/bot-menu-flow')

const pizzeria = {
  id: 'pizzeria-test',
  name: 'Pizzería Don Luigi',
  takes_orders: true,
  takes_bookings: false,
}

const productos = [
  { id: 'p1', name: 'Pizza Hawaiana', price: 8.5, tags: ['pizzas'], stock: 'disponible', active: true },
  { id: 'p2', name: 'Pizza Pepperoni', price: 9, price_sale: 7.5, tags: ['pizzas'], stock: 'disponible', active: true },
  { id: 'p3', name: 'Coca Cola 1.5L', price: 2.5, tags: ['bebidas'], stock: 'disponible', active: true },
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
    // ⚠️ Antes esto era un PROMPT de IA del que el código pescaba un saludo con
    // expresiones regulares. Desde el 2026-08-21 el dueño escribe el saludo y
    // se manda tal cual — `{{negocio}}` es lo único que se sustituye.
    const args = {
      products: productos,
      welcomeMessage: '¡Hola! 👋 Soy Andrea, la asistente virtual de {{negocio}}.',
    }
    const saludos = [
      'Hola buenas tardes',
      '¡Buenos días!',
      'Buenas noches, quisiera información',
      'Muy buenas',
    ]

    saludos.forEach((saludo, index) => {
      const contact = `saludo-${index}`
      resetMenuFlow(pizzeria.id, contact)
      enviar(pizzeria, contact, 'hola', args)
      enviar(pizzeria, contact, '🛒 Hacer un pedido', args)

      const respuesta = enviar(pizzeria, contact, saludo, args)
      expect(respuesta.reply).toContain('¡Hola! 👋')
      expect(respuesta.reply).toContain('Soy Andrea')
      expect(respuesta.reply).toContain('asistente virtual de Pizzería')
      expect(respuesta.reply).not.toContain('No te entendí')
      expect(titulos(respuesta.options)).toContain('🛒 Hacer un pedido')
    })

    resetMenuFlow(pizzeria.id, 'saludo-configurado')
    const configurado = enviar(pizzeria, 'saludo-configurado', 'hola', {
      ...args,
      welcomeMessage: 'Bienvenido a {{negocio}}. Es un placer atenderle.',
    })
    expect(configurado.reply).toContain('Bienvenido a Pizzería Don Luigi. Es un placer atenderle.')

    // Sin saludo escrito, uno por defecto con el nombre: quedarse callado sería
    // peor que saludar genérico.
    resetMenuFlow(pizzeria.id, 'sin-saludo')
    const porDefecto = enviar(pizzeria, 'sin-saludo', 'hola', {
      products: productos, welcomeMessage: null,
    })
    expect(porDefecto.reply).toContain('Pizzería Don Luigi')
  })

  it('pizza: elige SABOR (con ingredientes) y luego TAMAÑO, precio exacto y sabor pegado', () => {
    const pizzeria2 = { id: 'monster-pizza', name: 'Monster Pizza', takes_orders: true, takes_bookings: false }
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

  it('pedido: un producto con foto pasa por su detalle para ver qué comprará; sin foto va directo a la cantidad', () => {
    const pizzeria3 = { id: 'pizza-media', name: 'Pizza Media', takes_orders: true, takes_bookings: false }
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
    // El id 1 visible tras la media corresponde a "Pedirlo", no vuelve a abrir
    // fotos/videos. Debe avanzar a cantidad igual que el título exacto.
    const cantidadTrasFotos = enviar(pizzeria3, 'pm-a', '1', args)
    expect(cantidadTrasFotos.reply).toContain('¿Cuántas unidades')
    expect(cantidadTrasFotos.media).toBeUndefined()

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

})
