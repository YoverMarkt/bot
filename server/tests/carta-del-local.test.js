import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  crearLectorDeCartas, sanearPropuesta, validarCarta, LIMITES,
} = require('../dist/services/carta-del-local.js')

// ═══════════════════════════════════════════════════════════════════════════
// LA CARTA DEL LOCAL, LEÍDA DE SU FOTO
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño sube la foto de la carta en el superadmin al dar de alta un local;
// la IA propone y él revisa. Lo que estas pruebas fijan:
//   · la propuesta: lo impreso entra; un precio dudoso queda VACÍO, no se
//     adivina; el precio «para llevar» se aparta y no se usa.
//   · lo revisado: estricto, porque son precios que un cliente va a pagar.
//   · el lector: gpt-4o (medido), todas las fotos en una llamada, nunca lanza.

// La respuesta REAL de gpt-4o con la carta de La Abuelita (2026-09-24).
const LEIDA_DE_LA_ABUELITA = {
  categorias: [{
    nombre: 'Menú del Día',
    productos: [{
      nombre: 'Almuerzos', precio: 3, descripcion: null, variantes: [],
      listas: [
        { titulo: 'Sopas', opciones: ['Caldo de hueso de res', 'Crema de zapallo'] },
        { titulo: 'Segundos', opciones: ['Ceviche', 'Pollo en salsa de champiñones',
          'Carne de cerdo horneado', 'Moro de costilla', 'Pollo apanado', 'Pescado apanado'] },
        { titulo: 'Bebida', opciones: ['Mora', 'Naranjilla', 'Te helado', 'Quaker'] },
      ],
    }],
  }],
  otros_precios: [{ producto: 'Almuerzos', texto: 'Para llevar: $3,50' }],
  ignorado: ['LA ABUELITA 2', 'restaurant', 'PEDIDOS: 097 861 9700'],
}

describe('la propuesta: lo que la IA leyó, saneado', () => {
  it('la carta de La Abuelita entra entera, con «para llevar» apartado', () => {
    const propuesta = sanearPropuesta(LEIDA_DE_LA_ABUELITA)
    const [almuerzo] = propuesta.categorias[0].productos
    expect(almuerzo.nombre).toBe('Almuerzos')
    expect(almuerzo.precio).toBe(3)
    expect(almuerzo.listas.map(l => [l.titulo, l.opciones.length]))
      .toEqual([['Sopas', 2], ['Segundos', 6], ['Bebida', 4]])
    // El dueño: «el precio que dice para llevar eso no vale». Se ENSEÑA como
    // aviso para que lo vea, pero no es el precio del producto.
    expect(propuesta.otrosPrecios).toEqual([{ producto: 'Almuerzos', texto: 'Para llevar: $3,50' }])
    // Teléfonos y direcciones no llegan a la propuesta.
    expect(JSON.stringify(propuesta)).not.toContain('097 861 9700')
  })

  it('un precio dudoso queda VACÍO para rellenarlo, nunca se adivina', () => {
    const propuesta = sanearPropuesta({ categorias: [{ nombre: 'Pizzas', productos: [
      { nombre: 'Hawaiana', precio: '$5,99' },
      { nombre: 'Pepperoni', precio: 'consultar' },
      { nombre: 'Mixta', precio: -3 },
      { nombre: 'Familiar', precio: 250_000 },
      { nombre: '   ', precio: 4 },
    ] }] })
    expect(propuesta.categorias[0].productos.map(p => [p.nombre, p.precio])).toEqual([
      ['Hawaiana', 5.99], ['Pepperoni', null], ['Mixta', null], ['Familiar', null],
    ])
  })

  it('los tamaños conservan su precio, y lo que no tiene nombre no entra', () => {
    const propuesta = sanearPropuesta({ categorias: [
      { nombre: 'Pizzas', productos: [{ nombre: 'Hawaiana', variantes: [
        { nombre: 'Personal', precio: 5.99 }, { nombre: 'Mediana', precio: '11.99' }, { precio: 3 },
      ] }] },
      { nombre: 'Vacía', productos: [] },
      'basura',
    ] })
    expect(propuesta.categorias).toHaveLength(1)
    expect(propuesta.categorias[0].productos[0].variantes).toEqual([
      { nombre: 'Personal', precio: 5.99 }, { nombre: 'Mediana', precio: 11.99 },
    ])
  })

  it('una respuesta que no es un objeto deja una propuesta vacía, sin lanzar', () => {
    expect(sanearPropuesta(null)).toEqual({ categorias: [], otrosPrecios: [] })
    expect(sanearPropuesta('texto')).toEqual({ categorias: [], otrosPrecios: [] })
  })
})

describe('lo revisado: estricto, porque son precios que se cobran', () => {
  // La Abuelita tal como la aprobaría el dueño: con SU precio de $3.50.
  const revisadaDeLaAbuelita = () => ({
    categorias: [{
      nombre: 'Almuerzos',
      productos: [{
        nombre: 'Almuerzo del día', precio: 3.5, descripcion: '',
        variantes: [],
        listas: [
          { titulo: 'Sopa', opciones: ['Caldo de hueso de res', 'Crema de zapallo'] },
          { titulo: 'Bebida', opciones: ['Mora', 'Naranjilla'], obligatoria: false },
        ],
      }],
    }],
  })

  it('deja la carta con la forma que carga la base: listas como grupos de «elige una»', () => {
    const resultado = validarCarta(revisadaDeLaAbuelita())
    expect(resultado.ok).toBe(true)
    expect(resultado.productos).toBe(1)
    const [producto] = resultado.menu.categorias[0].productos
    expect(producto).toMatchObject({ nombre: 'Almuerzo del día', precio: 3.5, tipo: 'configurable' })
    expect(producto.grupos).toEqual([
      { nombre: 'Sopa', tipo: 'single', obligatorio: true, min: 1, max: 1, orden: 0,
        opciones: [{ nombre: 'Caldo de hueso de res', orden: 0 }, { nombre: 'Crema de zapallo', orden: 1 }] },
      { nombre: 'Bebida', tipo: 'single', obligatorio: false, min: 0, max: 1, orden: 1,
        opciones: [{ nombre: 'Mora', orden: 0 }, { nombre: 'Naranjilla', orden: 1 }] },
    ])
    // Lo que la carta NO dice no se inventa: ni partes del plato, ni gratis,
    // ni recargos.
    expect(JSON.stringify(producto.grupos)).not.toMatch(/parte|precioSuelto|recargo|gratis|cobro/)
  })

  it('con tamaños, el producto vale lo que el más barato y cada tamaño lo suyo', () => {
    const resultado = validarCarta({ categorias: [{ nombre: 'Pizzas', productos: [{
      nombre: 'Hawaiana', precio: null,
      variantes: [{ nombre: 'Mediana', precio: 11.99 }, { nombre: 'Personal', precio: 5.99 }],
    }] }] })
    expect(resultado.ok).toBe(true)
    const [pizza] = resultado.menu.categorias[0].productos
    expect(pizza.precio).toBe(5.99)
    expect(pizza.tipo).toBe('simple')
    expect(pizza.variantes).toEqual([
      { nombre: 'Mediana', precio: 11.99, orden: 0 }, { nombre: 'Personal', precio: 5.99, orden: 1 },
    ])
  })

  it('un precio que falta no se guarda como cero: se devuelve para corregirlo', () => {
    const carta = revisadaDeLaAbuelita()
    carta.categorias[0].productos[0].precio = null
    const resultado = validarCarta(carta)
    expect(resultado.ok).toBe(false)
    expect(resultado.errores).toEqual(['Almuerzos › Almuerzo del día: falta el precio'])
  })

  it('un tamaño sin precio tampoco pasa', () => {
    const resultado = validarCarta({ categorias: [{ nombre: 'Pizzas', productos: [{
      nombre: 'Hawaiana', variantes: [{ nombre: 'Personal', precio: 5.99 }, { nombre: 'Mediana', precio: null }],
    }] }] })
    expect(resultado.ok).toBe(false)
    expect(resultado.errores).toContain('Pizzas › Hawaiana › Mediana: falta el precio')
  })

  it('nombres repetidos se rechazan: un tamaño acabaría en el producto equivocado', () => {
    const resultado = validarCarta({ categorias: [
      { nombre: 'Pizzas', productos: [{ nombre: 'Hawaiana', precio: 5 }, { nombre: 'hawaiana', precio: 6 }] },
      { nombre: 'PIZZAS', productos: [{ nombre: 'Mixta', precio: 7 }] },
    ] })
    expect(resultado.ok).toBe(false)
    expect(resultado.errores).toEqual(expect.arrayContaining([
      'Pizzas › hawaiana: está repetido en la categoría',
      'PIZZAS: la categoría está repetida',
    ]))
  })

  it('una lista sin opciones o un nombre demasiado largo se señalan donde están', () => {
    const resultado = validarCarta({ categorias: [{ nombre: 'Almuerzos', productos: [{
      nombre: 'x'.repeat(LIMITES.producto + 5), precio: 3,
      listas: [{ titulo: 'Sopa', opciones: ['  '] }],
    }] }] })
    expect(resultado.ok).toBe(false)
    expect(resultado.errores.join('\n')).toMatch(/el nombre pasa de 120 letras/)
    expect(resultado.errores.join('\n')).toMatch(/Sopa: no tiene opciones/)
  })

  it('una categoría que se quedó sin productos se omite; una carta vacía no pasa', () => {
    const carta = revisadaDeLaAbuelita()
    carta.categorias.push({ nombre: 'Postres', productos: [] })
    const resultado = validarCarta(carta)
    expect(resultado.ok).toBe(true)
    expect(resultado.menu.categorias.map(c => c.nombre)).toEqual(['Almuerzos'])

    expect(validarCarta({ categorias: [] })).toEqual({ ok: false, errores: ['La carta no tiene productos'] })
    expect(validarCarta('no es una carta').ok).toBe(false)
  })
})

describe('el lector: gpt-4o, todas las fotos, y nunca lanza', () => {
  const lectorCon = ({ contenido, clave = 'sk-prueba', falla } = {}) => {
    const crear = vi.fn(async () => {
      if (falla) throw new Error(falla)
      return { choices: [{ message: { content: contenido } }] }
    })
    const leer = crearLectorDeCartas({
      settings: { get: async () => clave },
      crearCliente: () => ({ chat: { completions: { create: crear } } }),
      logger: { log: () => {} },
    })
    return { leer, crear }
  }
  const foto = (texto = 'foto') => ({ buffer: Buffer.from(texto), mimetype: 'image/jpeg' })

  it('lee con gpt-4o y manda TODAS las fotos en una sola llamada', async () => {
    const { leer, crear } = lectorCon({ contenido: JSON.stringify(LEIDA_DE_LA_ABUELITA) })
    const resultado = await leer([foto('pagina-1'), foto('pagina-2')])

    expect(resultado.ok).toBe(true)
    expect(resultado.propuesta.categorias[0].productos[0].nombre).toBe('Almuerzos')
    const [peticion, opciones] = crear.mock.calls[0]
    // ⚠️ No el mini: con la carta real pegó «Sopas» como producto de $3.
    expect(peticion.model).toBe('gpt-4o')
    expect(peticion.temperature).toBe(0)
    const imagenes = peticion.messages[1].content.filter(parte => parte.type === 'image_url')
    expect(imagenes).toHaveLength(2)
    expect(imagenes[0].image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from('pagina-1').toString('base64')}`)
    expect(opciones.timeout).toBeGreaterThan(0)
  })

  it('sin clave de OpenAI lo dice, sin llamar a nadie', async () => {
    const { leer, crear } = lectorCon({ clave: null })
    expect(await leer([foto()])).toEqual({ ok: false, motivo: 'sin_credencial' })
    expect(crear).not.toHaveBeenCalled()
  })

  it('una foto sin productos, un JSON roto o un modelo caído vuelven como motivo', async () => {
    expect(await lectorCon({ contenido: '{"categorias":[]}' }).leer([foto()]))
      .toEqual({ ok: false, motivo: 'sin_productos' })
    expect(await lectorCon({ contenido: 'no es json' }).leer([foto()]))
      .toEqual({ ok: false, motivo: 'json_invalido' })
    expect(await lectorCon({ contenido: '' }).leer([foto()]))
      .toEqual({ ok: false, motivo: 'respuesta_vacia' })
    expect(await lectorCon({ falla: 'timeout' }).leer([foto()]))
      .toEqual({ ok: false, motivo: 'fallo_del_modelo' })
  })
})
