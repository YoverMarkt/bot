import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { advanceMenuFlow, resetMenuFlow } = require('../dist/services/bot-menu-flow')

// ═══════════════════════════════════════════════════════════════════════════
// PEDIR VARIOS DE LO MISMO CON DISTINTO RELLENO, SIN GASTAR UN MENSAJE DE MÁS
// ═══════════════════════════════════════════════════════════════════════════
//
// El caso que lo obligó: una almuercería. «4 almuerzos, 3 con caldo de res y
// 1 con crema; de segundo 1 ceviche, 1 pescado y 2 pollo». Hasta el 2026-09-07
// eso costaba recorrer el flujo entero CUATRO veces —producto, sopa, segundo,
// bebida, cantidad— porque el chat solo sabía preguntar grupos `single`.
//
// Con el techo del marketplace en 25 respuestas por hora y Meta cobrando cada
// saliente desde el 1 de octubre, un pedido familiar rozaba el techo. Repartir
// cantidades no es una comodidad: es lo que hace que ese pedido quepa.
//
// Las tres reglas que se comprueban aquí, y que son de donde sale el ahorro:
//   1. La ÚLTIMA opción nunca se pregunta: se calcula con lo que resta.
//   2. Cuando no queda nada por repartir, el resto de preguntas se salta.
//   3. Con dos unidades, «¿iguales?» convierte dos configuraciones en una.

const local = { id: 'almuerzos-test', name: 'La Abuelita', takes_orders: true }

const productos = [
  { id: 'almuerzo', name: 'Almuerzo del día', price: 3.5, stock: 'disponible', active: true },
  // El plato suelto: mismo catálogo, pero sin contadores ni bebida incluida.
  { id: 'solo-sopa', name: 'Solo sopa', price: 1.5, stock: 'disponible', active: true },
]

// El catálogo real del cartel: 2 sopas, 6 segundos, 4 bebidas. Los tres son
// contadores e `included`, así que ninguna elección mueve un centavo.
const grupos = [
  { id: 'g-sopa', product_id: 'almuerzo', name: 'Sopa', selection_type: 'quantity', required: true, min_selectable: 1, max_selectable: 100, sort: 0 },
  { id: 'g-segundo', product_id: 'almuerzo', name: 'Segundo', selection_type: 'quantity', required: true, min_selectable: 1, max_selectable: 100, sort: 1 },
  { id: 'g-suelta', product_id: 'solo-sopa', name: 'Sopa', selection_type: 'single', required: true, min_selectable: 1, max_selectable: 1, sort: 0 },
]

const opciones = [
  { id: 'o-res', option_group_id: 'g-sopa', name: 'Caldo de hueso de res', price_adjustment: 0, sort: 0 },
  { id: 'o-zapallo', option_group_id: 'g-sopa', name: 'Crema de zapallo', price_adjustment: 0, sort: 1 },
  { id: 'o-ceviche', option_group_id: 'g-segundo', name: 'Ceviche', price_adjustment: 0, sort: 0 },
  { id: 'o-champi', option_group_id: 'g-segundo', name: 'Pollo en salsa de champiñones', price_adjustment: 0, sort: 1 },
  { id: 'o-cerdo', option_group_id: 'g-segundo', name: 'Carne de cerdo horneado', price_adjustment: 0, sort: 2 },
  { id: 'o-moro', option_group_id: 'g-segundo', name: 'Moro de costilla', price_adjustment: 0, sort: 3 },
  { id: 'o-apanado', option_group_id: 'g-segundo', name: 'Pollo apanado', price_adjustment: 0, sort: 4 },
  { id: 'o-pescado', option_group_id: 'g-segundo', name: 'Pescado apanado', price_adjustment: 0, sort: 5 },
  { id: 'o-res-suelta', option_group_id: 'g-suelta', name: 'Caldo de hueso de res', price_adjustment: 0, sort: 0 },
  { id: 'o-zapallo-suelta', option_group_id: 'g-suelta', name: 'Crema de zapallo', price_adjustment: 0, sort: 1 },
]

const args = { products: productos, optionGroups: grupos, options: opciones }
const titulos = options => options.map(o => (typeof o === 'string' ? o : o.title))
const enviar = (contacto, mensaje) => advanceMenuFlow({
  business: local, contact: contacto, message: mensaje, ...args,
})

/** Deja al cliente en la pantalla de «¿cuántos?», que es de donde sale todo. */
const hastaLaCantidad = (contacto) => {
  resetMenuFlow(local.id, contacto)
  enviar(contacto, 'hola')
  enviar(contacto, '🛒 Hacer un pedido')
  return enviar(contacto, 'Almuerzo del día')
}

/** Confirma el pedido y devuelve la acción con lo que se le manda a la base. */
const confirmar = (contacto) => {
  enviar(contacto, '✅ Finalizar pedido')
  return enviar(contacto, '✅ Confirmar pedido').action
}

describe('el reparto de un pedido de varios', () => {
  it('caso 1 — una sola unidad no pregunta cantidades: elige y ya', () => {
    const cantidad = hastaLaCantidad('uno')
    expect(cantidad.reply).toContain('¿Cuántos')
    // Hasta seis: con cuatro filas WhatsApp ya manda lista (los botones se
    // acaban en tres) y una lista admite diez, así que ofrecer solo tres
    // costaba dos mensajes de más en el pedido familiar.
    expect(titulos(cantidad.options)).toEqual(['1', '2', '3', '4', '5', '6', '✍️ Otra cantidad', '⬅️ Volver'])

    const sopa = enviar('uno', '1')
    // Con UNA unidad el contador se pregunta como cualquier otra elección:
    // nada de «1 × Caldo», que sería ruido en el pedido más común de todos.
    expect(titulos(sopa.options)).toEqual(['Caldo de hueso de res', 'Crema de zapallo'])

    const segundo = enviar('uno', 'Caldo de hueso de res')
    expect(titulos(segundo.options)).toContain('Pollo apanado')

    const agregado = enviar('uno', 'Pollo apanado')
    expect(agregado.reply).toContain('agregué 1x Almuerzo del día')
    expect(agregado.reply).toContain('Caldo de hueso de res')
    expect(agregado.reply).toContain('Pollo apanado')

    const accion = confirmar('uno')
    expect(accion.totalCents).toBe(350)
    expect(accion.items[0].options).toHaveLength(2)
    // Cantidad 1 explícita: el grupo ES un contador, así que la RPC la admite.
    expect(accion.items[0].options.every(o => o.quantity === 1)).toBe(true)
  })

  it('caso 2 — dos iguales se configuran UNA vez, no dos', () => {
    hastaLaCantidad('dos')
    const pregunta = enviar('dos', '2')
    expect(pregunta.reply).toContain('¿Serán iguales?')
    expect(titulos(pregunta.options)).toEqual(['✅ Sí, iguales', '🍽️ Diferentes', '⬅️ Volver'])

    // «Iguales»: una pasada por cada grupo y las dos porciones a la misma
    // opción. Sin este atajo serían cuatro preguntas en vez de dos.
    const sopa = enviar('dos', '✅ Sí, iguales')
    // Nombre CORTO en el título (una fila admite 24 caracteres) y completo
    // en la descripción, que es lo que hace que el atajo quepa.
    expect(titulos(sopa.options)).toContain('2 × Caldo')

    enviar('dos', '2 × Caldo')
    const agregado = enviar('dos', '2 × Pollo apanado')
    expect(agregado.reply).toContain('agregué 2x Almuerzo del día')

    const accion = confirmar('dos')
    expect(accion.totalCents).toBe(700)
    expect(accion.items[0].qty).toBe(2)
    expect(accion.items[0].options).toEqual([
      { optionId: 'o-res', groupName: 'Sopa', name: 'Caldo de hueso de res', quantity: 2 },
      { optionId: 'o-apanado', groupName: 'Segundo', name: 'Pollo apanado', quantity: 2 },
    ])
  })

  it('caso 3 — cuatro repartidos: la última opción se CALCULA, no se pregunta', () => {
    hastaLaCantidad('cuatro')
    const sopas = enviar('cuatro', '4')
    // ⚠️ Con DOS sopas y cuatro almuerzos, los cinco repartos posibles caben
    // en un mensaje, así que se ofrecen enteros y no hay «Combinar»: el
    // reparto de las sopas cuesta UN toque en vez de dos.
    expect(titulos(sopas.options)).toEqual([
      '4 × Caldo', '3 Caldo + 1 Crema', '2 Caldo + 2 Crema',
      '1 Caldo + 3 Crema', '4 × Crema', '⬅️ Volver',
    ])

    const segundos = enviar('cuatro', '3 Caldo + 1 Crema')
    expect(segundos.reply).toContain('Segundo para 4')

    // ── Segundos: seis opciones, así que se pregunta cuál y cuántas ─────
    const cual = enviar('cuatro', '🔀 Combinar')
    expect(cual.reply).toContain('faltan 4')
    expect(titulos(cual.options)).toContain('Pollo en salsa de champiñones')

    enviar('cuatro', 'Ceviche')
    const trasCeviche = enviar('cuatro', '1')
    expect(trasCeviche.reply).toContain('faltan 3')

    enviar('cuatro', 'Pescado apanado')
    enviar('cuatro', '1')
    // Quedan 2 porciones y cuatro platos posibles: hay que decir de cuál. Al
    // pedir 2 se agota el reparto y los otros tres no se preguntan.
    enviar('cuatro', 'Pollo en salsa de champiñones')
    const agregado = enviar('cuatro', '2')
    expect(agregado.reply).toContain('agregué 4x Almuerzo del día')

    const accion = confirmar('cuatro')
    expect(accion.totalCents).toBe(1400)
    expect(accion.items[0].qty).toBe(4)
    const porGrupo = nombre => accion.items[0].options
      .filter(o => o.groupName === nombre)
      .map(o => `${o.quantity}× ${o.name}`)
    expect(porGrupo('Sopa')).toEqual(['3× Caldo de hueso de res', '1× Crema de zapallo'])
    expect(porGrupo('Segundo')).toEqual([
      '1× Ceviche', '1× Pescado apanado', '2× Pollo en salsa de champiñones',
    ])
    // Las porciones de cada grupo suman EXACTAMENTE las unidades pedidas: sin
    // esto la cocina recibe cuatro bandejas y tres segundos.
    for (const grupo of ['Sopa', 'Segundo']) {
      const suma = accion.items[0].options
        .filter(o => o.groupName === grupo)
        .reduce((total, o) => total + o.quantity, 0)
      expect(suma, `las porciones de ${grupo} tienen que sumar 4`).toBe(4)
    }
  })

  it('salta las preguntas que sobran cuando ya no queda nada por repartir', () => {
    hastaLaCantidad('salta')
    enviar('salta', '4')
    enviar('salta', '2 Caldo + 2 Crema')

    // Segundos: si el primero se lleva las 4 porciones, no se pregunta por
    // ninguno de los otros cinco — son cinco mensajes que no se mandan.
    enviar('salta', '🔀 Combinar')
    enviar('salta', 'Ceviche')
    const agregado = enviar('salta', '4')
    expect(agregado.reply).toContain('agregué 4x Almuerzo del día')

    const accion = confirmar('salta')
    const segundos = accion.items[0].options.filter(o => o.groupName === 'Segundo')
    expect(segundos).toHaveLength(1)
    expect(segundos[0]).toMatchObject({ name: 'Ceviche', quantity: 4 })
    // Y las que valieron 0 NO se mandan: la RPC contaría una elección que el
    // cliente no hizo y el dueño vería «0× Moro de costilla» en su comanda.
    expect(accion.items[0].options.some(o => o.quantity === 0)).toBe(false)
  })

  it('un grupo de UNA sola opción no se pregunta: se resuelve solo', () => {
    // La palanca del dueño para abaratar su flujo. Con «Jugo del día» como
    // única bebida, ese paso cuesta cero mensajes; con cuatro sabores puede
    // costar cinco, y en un pedido familiar eso es la diferencia entre caber
    // y no caber en el techo de 25 respuestas por hora.
    const conBebida = {
      products: productos,
      optionGroups: [...grupos, { id: 'g-bebida', product_id: 'almuerzo', name: 'Bebida', selection_type: 'quantity', required: true, min_selectable: 1, max_selectable: 100, sort: 2 }],
      options: [...opciones, { id: 'o-jugo', option_group_id: 'g-bebida', name: 'Jugo del día', price_adjustment: 0, sort: 0 }],
    }
    resetMenuFlow(local.id, 'unica')
    const paso = m => advanceMenuFlow({
      business: local, contact: 'unica', message: m, ...conBebida,
    })
    paso('hola')
    paso('🛒 Hacer un pedido')
    paso('Almuerzo del día')
    paso('2')
    paso('✅ Sí, iguales')
    paso('2 × Caldo')
    // Tras el segundo, la bebida NO se pregunta: va directo al carrito.
    const agregado = paso('2 × Pollo apanado')
    expect(agregado.reply).toContain('agregué 2x Almuerzo del día')
    expect(agregado.reply).toContain('Jugo del día')

    paso('✅ Finalizar pedido')
    const accion = paso('✅ Confirmar pedido').action
    const bebida = accion.items[0].options.find(o => o.groupName === 'Bebida')
    // Se resolvió sola y con las porciones correctas: dos almuerzos, dos jugos.
    expect(bebida).toMatchObject({ optionId: 'o-jugo', quantity: 2 })
  })

  it('«Otra cantidad» pide el número y deja de mirar la lista', () => {
    hastaLaCantidad('muchos')
    const pide = enviar('muchos', '✍️ Otra cantidad')
    expect(pide.reply).toContain('Escríbeme cuántos')

    // ⚠️ Y una vez pedido el número deja de mirarse la lista: si no, este «8»
    // volvería a casar por posición y la pregunta se repetiría para siempre.
    const sopas = enviar('muchos', '8')
    expect(sopas.reply).toContain('Sopa para 8')
    expect(titulos(sopas.options)).toContain('8 × Caldo')
  })
})

describe('lo que NO puede cambiar para el resto del catálogo', () => {
  const simple = { id: 'tienda-test', name: 'Tienda', takes_orders: true }
  const sueltos = [
    { id: 's1', name: 'Agua', price: 0.75, stock: 'disponible', active: true },
  ]

  it('un producto SIN contadores sigue preguntando la cantidad al final', () => {
    resetMenuFlow(simple.id, 'viejo')
    const paso = m => advanceMenuFlow({
      business: simple, contact: 'viejo', message: m, products: sueltos,
    })
    paso('hola')
    paso('🛒 Hacer un pedido')
    const cantidad = paso('Agua')
    // La pantalla de siempre: «¿Cuántas unidades…?» con «Otra cantidad».
    expect(cantidad.reply).toContain('¿Cuántas unidades')
    expect(titulos(cantidad.options)).toContain('✍️ Otra cantidad')

    const agregado = paso('3')
    expect(agregado.reply).toContain('agregué 3x Agua')
  })

  it('un grupo `single` se elige una vez y NO viaja con cantidad', () => {
    const conSingle = {
      products: [{ id: 'p', name: 'Café', price: 1.5, stock: 'disponible', active: true }],
      optionGroups: [{ id: 'g', product_id: 'p', name: 'Tamaño', selection_type: 'single', required: true, min_selectable: 1, max_selectable: 1, sort: 0 }],
      options: [{ id: 'o', option_group_id: 'g', name: 'Grande', price_adjustment: 0, sort: 0 }],
    }
    resetMenuFlow('cafe-test', 'c')
    const paso = m => advanceMenuFlow({
      business: { id: 'cafe-test', name: 'Café', takes_orders: true },
      contact: 'c', message: m, ...conSingle,
    })
    paso('hola')
    paso('🛒 Hacer un pedido')
    paso('Café')
    paso('Grande')
    paso('2')
    paso('✅ Finalizar pedido')
    const accion = paso('✅ Confirmar pedido').action
    // ⚠️ Sin `quantity`: `create_storefront_order` rechaza el pedido entero
    // con «no se elige por cantidad» si llega un número donde no toca.
    expect(accion.items[0].options).toEqual([
      { optionId: 'o', groupName: 'Tamaño', name: 'Grande' },
    ])
  })
})

describe('la experiencia completa, como una app de pedidos', () => {
  const paso = (contacto, mensaje) => advanceMenuFlow({
    business: local, contact: contacto, message: mensaje, ...args,
  })

  it('la carta del día se enseña ANTES de elegir, en un solo mensaje', () => {
    resetMenuFlow(local.id, 'carta')
    paso('carta', 'hola')
    const carta = paso('carta', '🛒 Hacer un pedido')
    // Lo que está escrito en el cartel del local: qué hay hoy y a cuánto.
    // Antes había que elegir «Almuerzo» a ciegas y descubrir las sopas después.
    expect(carta.reply).toContain('Caldo de hueso de res')
    expect(carta.reply).toContain('Pescado apanado')
    expect(carta.reply).toContain('$3.50')
    // Y no se repite al volver a entrar por «Ver más» ni en la bienvenida.
    expect(paso('carta', 'hola').reply).not.toContain('Pescado apanado')
  })

  it('el carrito se ve DESPUÉS de cada añadido, agrupado y con total', () => {
    resetMenuFlow(local.id, 'carrito')
    paso('carrito', 'hola')
    paso('carrito', '🛒 Hacer un pedido')
    paso('carrito', 'Almuerzo del día')
    paso('carrito', '2')
    paso('carrito', '✅ Sí, iguales')
    paso('carrito', '2 × Caldo')
    const visto = paso('carrito', '2 × Pollo apanado')

    expect(visto.reply).toContain('🛒 *Tu pedido*')
    expect(visto.reply).toContain('*2 × Almuerzo del día* — $7.00')
    // Agrupado por su grupo, no siete elecciones en una línea corrida.
    expect(visto.reply).toContain('Sopa: 2× Caldo de hueso de res')
    expect(visto.reply).toContain('Segundo: 2× Pollo apanado')
    expect(visto.reply).toContain('*Total: $7.00*')
    expect(titulos(visto.options)).toEqual([
      '➕ Agregar algo', '✅ Finalizar pedido', '✏️ Quitar algo', '🏠 Menú principal',
    ])
  })

  it('se puede quitar UNA línea sin perder el pedido entero', () => {
    resetMenuFlow(local.id, 'quitar')
    paso('quitar', 'hola')
    paso('quitar', '🛒 Hacer un pedido')
    paso('quitar', 'Almuerzo del día')
    paso('quitar', '1')
    paso('quitar', 'Caldo de hueso de res')
    paso('quitar', 'Pollo apanado')
    paso('quitar', '➕ Agregar algo')
    paso('quitar', 'Solo sopa')
    paso('quitar', 'Crema de zapallo')
    paso('quitar', '1')

    const lista = paso('quitar', '✏️ Quitar algo')
    expect(titulos(lista.options)).toEqual(['1. Almuerzo del día', '2. Solo sopa', '⬅️ Volver'])

    // ⚠️ Antes la única salida era «Vaciar carrito»: un error de un toque
    // costaba rehacer el pedido entero.
    const tras = paso('quitar', '2. Solo sopa')
    expect(tras.reply).toContain('Quité *Solo sopa*')
    expect(tras.reply).toContain('*Total: $3.50*')
    expect(tras.reply).not.toContain('Solo sopa* — $1.50')
  })

  it('todos los repartos posibles caben en UN mensaje cuando son pocos', () => {
    resetMenuFlow(local.id, 'combi')
    paso('combi', 'hola')
    paso('combi', '🛒 Hacer un pedido')
    paso('combi', 'Almuerzo del día')
    const sopas = paso('combi', '4')
    // ⚠️ Nombre corto en el título (24 caracteres es el tope de una fila) y
    // completo en la descripción. Con «2 × Caldo de hueso de res» (25) el
    // atajo no cabía y el cliente acababa en «¿Cuántos…?» con [1] de única
    // respuesta posible.
    expect(titulos(sopas.options)).toEqual([
      '4 × Caldo', '3 Caldo + 1 Crema', '2 Caldo + 2 Crema',
      '1 Caldo + 3 Crema', '4 × Crema', '⬅️ Volver',
    ])
    const descripcion = sopas.options.find(o => o.title === '3 Caldo + 1 Crema')?.description
    expect(descripcion).toBe('3 Caldo de hueso de res + 1 Crema de zapallo')

    // Con SEIS segundos son 21 repartos y no caben: ahí se reparte por pasos.
    paso('combi', '3 Caldo + 1 Crema')
    const segundos = advanceMenuFlow({ business: local, contact: 'combi', message: 'x', ...args })
    expect(titulos(segundos.options)).toContain('🔀 Combinar')
  })
})
