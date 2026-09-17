import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  PREP_TIME_POR_DEFECTO,
  businessTypesWithPrepTime,
  businessTypesWithTemplate,
  prepTimeForBusinessType,
  templateForBusinessType,
} from '../dist/services/business-templates.js'

// ═══════════════════════════════════════════════════════════════════════════
// PLANTILLAS POR TIPO DE NEGOCIO
//
// El riesgo real de este módulo no es que una plantilla esté mal escrita: es
// que su clave no coincida con ningún tipo del desplegable del panel. Entonces
// el tipo no se puede elegir, la plantilla no se aplica jamás, y nada falla —
// simplemente el negocio nace con el catálogo vacío y nadie se entera.
//
// Como el panel es otro paquete y no comparte código con el servidor, la única
// forma de vigilarlo es leer su archivo.
// ═══════════════════════════════════════════════════════════════════════════

const panelTypes = () => {
  const aqui = path.dirname(fileURLToPath(import.meta.url))
  const archivo = path.join(
    aqui, '..', '..', 'apps', 'admin', 'src', 'features', 'clients', 'business-types.ts',
  )
  const fuente = readFileSync(archivo, 'utf8')
  return [...fuente.matchAll(/\{\s*value:\s*'([^']+)'/g)].map(([, value]) => value
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''))
}

describe('plantillas por tipo de negocio', () => {
  it('encuentra los tipos del panel (si no, todo lo demás pasaría en falso)', () => {
    const tipos = panelTypes()
    // Tras la fase 5 el desplegable son 31: 24 de comida, 6 de retail y el
    // genérico. El umbral va al total REAL, no a un número redondo por debajo:
    // holgura de tres significa que pueden desaparecer tres tipos del panel sin
    // que nada avise. Retirar un tipo es un acto deliberado y debe bajar este
    // número a mano; añadir uno no lo rompe.
    expect(tipos.length).toBeGreaterThanOrEqual(31)
    expect(tipos).toContain('hamburgueseria')
  })

  it('cada plantilla corresponde a un tipo que el panel deja elegir', () => {
    const tipos = panelTypes()
    const huerfanas = businessTypesWithTemplate().filter(clave => !tipos.includes(clave))

    expect(
      huerfanas,
      huerfanas.length
        ? 'Estas plantillas no corresponden a ningún tipo del desplegable del\n'
          + 'panel, así que no se pueden aplicar nunca —el negocio nacería con el\n'
          + 'catálogo vacío sin que nada falle:\n'
          + `${huerfanas.map(t => `  · ${t}`).join('\n')}\n\n`
          + 'Suele ser una tilde o un plural de más. Compara con\n'
          + 'apps/admin/src/features/clients/business-types.ts'
        : '',
    ).toEqual([])
  })

  it('los tipos de comida del panel nacen con catálogo', () => {
    // Sin esto, añadir «hamburguesería» al desplegable y olvidar su plantilla
    // pasaría inadvertido: es el error probable al ampliar la lista.
    const conCarta = [
      'hamburgueseria', 'comida rapida', 'almuerzos', 'menu ejecutivo',
      'comida tipica', 'desayunos', 'asadero', 'parrillada', 'pollo asado',
      'marisqueria', 'sushi', 'comida mexicana', 'comida china',
      'comida saludable', 'heladeria', 'pasteleria', 'postres', 'batidos',
      'jugos', 'carniceria', 'emprendimiento de comida',
    ]
    const sinPlantilla = conCarta.filter(tipo => !templateForBusinessType(tipo))
    expect(sinPlantilla).toEqual([])
  })

  it('resuelve el tipo con tildes, mayúsculas y espacios', () => {
    const esperada = templateForBusinessType('hamburgueseria')
    expect(templateForBusinessType('Hamburguesería')).toBe(esperada)
    expect(templateForBusinessType('  HAMBURGUESERÍA  ')).toBe(esperada)
  })

  it('un tipo escrito a mano hereda la carta más específica que lo contiene', () => {
    // El admin puede escribir un tipo libre. «hamburguesería gourmet» debe
    // nacer con la carta de hamburguesería, no vacío.
    expect(templateForBusinessType('hamburguesería gourmet'))
      .toBe(templateForBusinessType('hamburgueseria'))

    // Y gana la coincidencia más larga: «comida rápida» no puede perder contra
    // una clave más corta que también esté contenida.
    expect(templateForBusinessType('restaurante de comida rápida'))
      .toBe(templateForBusinessType('comida rapida'))
  })

  it('los negocios sin carta no reciben ninguna', () => {
    // Los tres primeros están en el desplegable y no tienen carta; el último
    // es un tipo escrito a mano que no se parece a ninguno con plantilla.
    for (const tipo of ['ferretería', 'perfumería', 'negocio', 'lavandería']) {
      expect(templateForBusinessType(tipo), `${tipo} no debería traer carta`).toBeNull()
    }
    expect(templateForBusinessType('')).toBeNull()
    expect(templateForBusinessType(null)).toBeNull()
    expect(templateForBusinessType(undefined)).toBeNull()
  })

  it('ninguna plantilla viola las reglas que la base rechazaría', () => {
    // Un grupo con estos datos mal puestos revienta en el insert de la RPC, y
    // el negocio nacería sin catálogo con el error escondido en el registro.
    const problemas = []
    for (const tipo of businessTypesWithTemplate()) {
      const plantilla = templateForBusinessType(tipo)
      for (const categoria of plantilla.categorias) {
        if (!categoria.nombre?.trim() || categoria.nombre.length > 60) {
          problemas.push(`${tipo} → categoría «${categoria.nombre}» con nombre inválido`)
        }
        for (const grupo of categoria.grupos || []) {
          const min = grupo.min ?? 0
          const max = grupo.max ?? 1
          if (grupo.obligatorio && min < 1) {
            problemas.push(`${tipo} → «${grupo.nombre}» obligatorio sin mínimo`)
          }
          if (grupo.tipo === 'single' && max !== 1) {
            problemas.push(`${tipo} → «${grupo.nombre}» es single con máximo ${max}`)
          }
          if (min > max) problemas.push(`${tipo} → «${grupo.nombre}» tiene mínimo > máximo`)
          if (max < 1 || max > 100) {
            problemas.push(`${tipo} → «${grupo.nombre}» con máximo fuera de rango`)
          }
          if (!grupo.nombre?.trim() || grupo.nombre.length > 120) {
            problemas.push(`${tipo} → grupo con nombre inválido`)
          }
          // Un grupo obligatorio sin opciones no se puede cumplir: bloquearía
          // el producto entero en la mini app.
          if (grupo.obligatorio && !(grupo.opciones || []).length) {
            problemas.push(`${tipo} → «${grupo.nombre}» es obligatorio y no tiene opciones`)
          }
          for (const opcion of grupo.opciones || []) {
            if (!opcion.nombre?.trim() || opcion.nombre.length > 120) {
              problemas.push(`${tipo} → opción con nombre inválido en «${grupo.nombre}»`)
            }
          }
        }
      }
    }

    expect(problemas, problemas.join('\n')).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// TIEMPO DE PREPARACIÓN POR TIPO
//
// Mismo riesgo que las plantillas, y una consecuencia peor: este número no
// solo se muestra, decide desde qué hora se puede PROGRAMAR un pedido. Una
// clave que no exista en el desplegable deja al negocio con los 25 minutos
// por defecto sin que nada avise, y un asadero prometiendo lo que no cumple.
// ═══════════════════════════════════════════════════════════════════════════

describe('tiempo de preparación por tipo de negocio', () => {
  it('cada tipo con tiempo propio existe en el desplegable del panel', () => {
    const delPanel = panelTypes()
    const huerfanos = businessTypesWithPrepTime().filter(tipo => !delPanel.includes(tipo))
    expect(
      huerfanos,
      `Tipos con tiempo que el panel no ofrece: ${huerfanos.join(', ')}`,
    ).toEqual([])
  })

  it('devuelve los minutos del tipo, y el defecto cuando no lo conoce', () => {
    expect(prepTimeForBusinessType('heladería')).toBe(10)
    expect(prepTimeForBusinessType('pizzería')).toBe(25)
    expect(prepTimeForBusinessType('asadero')).toBe(40)
    // Sin tipo, o con uno escrito a mano que no se parece a ninguno conocido,
    // se cae al defecto en vez de inventar.
    expect(prepTimeForBusinessType('lavandería')).toBe(PREP_TIME_POR_DEFECTO)
    expect(prepTimeForBusinessType('')).toBe(PREP_TIME_POR_DEFECTO)
    expect(prepTimeForBusinessType(null)).toBe(PREP_TIME_POR_DEFECTO)
  })

  it('un tipo escrito a mano hereda el de su familia, y gana el más largo', () => {
    // Igual que las plantillas: «heladería artesanal» es una heladería.
    expect(prepTimeForBusinessType('heladería artesanal')).toBe(10)
    // «comida rápida» no puede perder contra un hipotético «comida».
    expect(prepTimeForBusinessType('comida rápida del centro')).toBe(20)
  })

  it('ningún tipo promete un tiempo que la base rechazaría', () => {
    // El CHECK de businesses_tiempos_check exige entre 1 y 480: un valor fuera
    // de rango reventaría el alta entera del negocio, no solo su tiempo.
    const malos = businessTypesWithPrepTime()
      .map(tipo => [tipo, prepTimeForBusinessType(tipo)])
      .filter(([, minutos]) => !Number.isInteger(minutos) || minutos < 1 || minutos > 480)
    expect(malos, `Tipos fuera del rango de la base: ${JSON.stringify(malos)}`).toEqual([])
  })
})

// ── El orden con el que nace un negocio ────────────────────────────────────
//
// Cada grupo de una plantilla llega a la base con su `sort`, y de ahí sale el
// orden en que el cliente ve las opciones y en que se lee su pedido.
//
// El orden ya estaba escrito y se tiraba: `grupos: [terminoDeLaCarne,
// extrasHamburguesa, retirarIngredientes]` dice cómo se piensa una
// hamburguesa —primero el término, luego lo que se agrega, al final lo que se
// quita— y como nadie rellenaba `orden`, la RPC los insertaba TODOS en cero.
// Con todo empatado caían al desempate alfabético: «Extras, Retira, Término».
describe('un negocio nuevo nace ordenado', () => {
  it('cada categoría, grupo y opción lleva su orden', () => {
    for (const tipo of businessTypesWithTemplate()) {
      const plantilla = templateForBusinessType(tipo)
      plantilla.categorias.forEach((categoria, posicion) => {
        expect(categoria.orden, `${tipo} → ${categoria.nombre}`).toBe(posicion)
        ;(categoria.grupos || []).forEach((grupo, puesto) => {
          expect(grupo.orden, `${tipo} → ${categoria.nombre} → ${grupo.nombre}`).toBe(puesto)
          ;(grupo.opciones || []).forEach((opcion, lugar) => {
            expect(opcion.orden, `${tipo} → ${grupo.nombre} → ${opcion.nombre}`).toBe(lugar)
          })
        })
      })
    }
  })

  // El caso que motivó todo: en una hamburguesería, el término va PRIMERO.
  // Por nombre saldría al final, detrás de «Extras» y «Retira ingredientes».
  it('en la hamburguesería el término va antes que los extras', () => {
    const hamburguesas = templateForBusinessType('hamburgueseria')
      .categorias.find(c => c.nombre === 'Hamburguesas')
    const porOrden = [...hamburguesas.grupos].sort((a, b) => a.orden - b.orden)

    expect(porOrden.map(g => g.nombre))
      .toEqual(['Término de la carne', 'Extras', 'Retira ingredientes'])
    // Y que de verdad NO es el alfabético, que es lo que salía antes.
    expect(porOrden.map(g => g.nombre))
      .not.toEqual([...porOrden.map(g => g.nombre)].sort((a, b) => a.localeCompare(b, 'es')))
  })

  // Las categorías que ya traen su orden a mano —`bebidas(3)`— no se renumeran:
  // así se puede intercalar una sin tocar las demás.
  it('un orden puesto a mano gana sobre la posición', () => {
    const comidaRapida = templateForBusinessType('comida rapida')
    const bebidas = comidaRapida.categorias.find(c => c.nombre === 'Bebidas')
    expect(bebidas.orden).toBe(4)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CADA LOCAL NACE ARMADO (2026-09-16)
//
// Hasta hoy un local nacía con categorías y grupos colgados de la CATEGORÍA,
// pero sin un solo producto. El dueño abría su panel y veía «Sopa, Segundo,
// Guarnición… lo heredan 0 productos»: piezas sueltas sin nada que enseñara
// cómo se juntan. Y en los almuerzos era peor que confuso — era IMPOSIBLE:
// `option_groups_parte_del_plato_check` exige que una parte del plato cuelgue
// de un PRODUCTO, así que la plantilla no podía producir el plato por partes
// que usa La Abuelita. Todo dueño de almuerzos acababa con los dos juegos de
// grupos, que es exactamente el lío de «tengo como 4 sopas».
//
// Ahora cada local de comida nace con UN producto de ejemplo, AGOTADO —su
// dueño lo ve y lo edita; nadie lo puede pedir—, armado como se arma de verdad
// en su tipo. Que nazca agotado lo impone la base y lo comprueban
// `verificar-esquema.sql` y `plantillas-reales.mjs`. Las listas que se repiten (los sabores de
// una pizzería) nacen como PLANTILLA y los grupos se enlazan a ella.
// ═══════════════════════════════════════════════════════════════════════════

const productosDe = plantilla => plantilla.categorias.flatMap(c => c.productos || [])
const productoDe = (tipo, nombre) => productosDe(templateForBusinessType(tipo))
  .find(p => p.nombre === nombre)

describe('cada local nace armado', () => {
  it('todo local de comida nace con al menos un producto de ejemplo', () => {
    const sinEjemplo = businessTypesWithTemplate()
      .filter(tipo => productosDe(templateForBusinessType(tipo)).length === 0)
    expect(sinEjemplo, `Nacen sin nada que enseñe cómo se arma: ${sinEjemplo.join(', ')}`)
      .toEqual([])
  })

  it('el almuerzo nace armado por partes en un PRODUCTO, nunca en la categoría', () => {
    for (const tipo of ['almuerzos', 'menu ejecutivo']) {
      const plantilla = templateForBusinessType(tipo)
      // Ni un grupo colgado de la categoría: son los que se duplicaban.
      const deCategoria = plantilla.categorias.flatMap(c => c.grupos || [])
      expect(deCategoria.map(g => g.nombre), tipo).toEqual([])

      const [plato] = productosDe(plantilla)
      expect(plato, tipo).toBeDefined()
      expect(plato.grupos.map(g => g.nombre), tipo).toEqual(['Sopa', 'Segundo', 'Bebida'])

      const [sopa, segundo, bebida] = plato.grupos
      for (const parte of [sopa, segundo]) {
        expect(parte.parte, `${tipo} → ${parte.nombre}`).toBe(true)
        expect(parte.tipo).toBe('quantity')
        // Se vende suelta: «Solo segundo» sin inventar otro producto.
        expect(parte.precioSuelto).toBeGreaterThan(0)
      }
      // La bebida NO es parte: va gratis y la base la topa a una por plato.
      expect(bebida.parte).toBeFalsy()
      expect(bebida.cobro).toBe('included')
      expect(bebida.tipo).toBe('quantity')
    }
  })

  it('la pizzería nace con su lista de sabores, y el combo deja elegir cada pizza', () => {
    const plantilla = templateForBusinessType('pizzeria')
    expect((plantilla.listas || []).map(l => l.nombre)).toContain('Sabores')

    const pizza = productoDe('pizzeria', 'Pizza')
    expect(pizza.grupos.find(g => g.nombre === 'Sabor')?.lista).toBe('Sabores')

    const combo = productosDe(plantilla).find(p => p.tipo === 'combo')
    expect(combo).toBeDefined()
    // La decisión del dueño: cada pizza del combo elige su sabor, de la MISMA
    // lista. Un sabor nuevo aparece en la pizza y en el combo a la vez.
    const pasosDeSabor = combo.grupos.filter(g => g.lista === 'Sabores')
    expect(pasosDeSabor.map(g => g.nombre))
      .toEqual(['Sabor de la 1.ª pizza', 'Sabor de la 2.ª pizza'])
    // Y sin el paso falso «1. Elige tu pizza», que es el que Monster Pizza
    // tenía y no elegía nada.
    expect(combo.grupos.some(g => /^\d/.test(g.nombre))).toBe(false)
  })

  it('la heladería elige sus bolas de una lista de sabores', () => {
    const plantilla = templateForBusinessType('heladeria')
    expect((plantilla.listas || []).map(l => l.nombre)).toContain('Sabores')
    const helado = productosDe(plantilla)[0]
    const sabores = helado.grupos.find(g => g.lista === 'Sabores')
    expect(sabores?.tipo).toBe('quantity')
    // Tantas bolas como dice el nombre, ni una más ni una menos.
    expect(sabores.min).toBe(sabores.max)
  })

  it('ningún producto de ejemplo ni lista rompe lo que la base exige', () => {
    const problemas = []
    for (const tipo of businessTypesWithTemplate()) {
      const plantilla = templateForBusinessType(tipo)
      const listas = new Map((plantilla.listas || []).map(l => [l.nombre, l]))

      for (const lista of plantilla.listas || []) {
        if (!(lista.opciones || []).length) problemas.push(`${tipo} → lista «${lista.nombre}» vacía`)
      }

      for (const categoria of plantilla.categorias) {
        for (const grupo of categoria.grupos || []) {
          // Una parte del plato solo puede colgar de un producto: la base lo
          // rechaza en una categoría y el local nacería sin catálogo.
          if (grupo.parte) problemas.push(`${tipo} → «${grupo.nombre}» es parte y cuelga de la categoría`)
        }
        for (const producto of categoria.productos || []) {
          if (!producto.nombre?.trim() || producto.nombre.length > 120) {
            problemas.push(`${tipo} → producto con nombre inválido`)
          }
          if (!(producto.precio > 0)) problemas.push(`${tipo} → «${producto.nombre}» sin precio`)
          for (const grupo of producto.grupos || []) {
            if (grupo.lista && !listas.has(grupo.lista)) {
              problemas.push(`${tipo} → «${grupo.nombre}» usa la lista «${grupo.lista}», que no existe`)
            }
            // Enlazado a una lista, sus opciones las pone la base. Si además
            // trajera las suyas se mezclarían dos orígenes en un grupo.
            if (grupo.lista && (grupo.opciones || []).length) {
              problemas.push(`${tipo} → «${grupo.nombre}» usa lista y trae opciones propias`)
            }
            if (grupo.obligatorio && !grupo.lista && !(grupo.opciones || []).length) {
              problemas.push(`${tipo} → «${grupo.nombre}» es obligatorio y no tiene opciones`)
            }
            if (grupo.parte && grupo.tipo !== 'quantity') {
              problemas.push(`${tipo} → «${grupo.nombre}» es parte y no se cuenta por porciones`)
            }
            if (grupo.precioSuelto != null && !grupo.parte) {
              problemas.push(`${tipo} → «${grupo.nombre}» tiene precio suelto sin ser parte`)
            }
            if (grupo.tipo === 'single' && (grupo.max ?? 1) !== 1) {
              problemas.push(`${tipo} → «${grupo.nombre}» es single con máximo ${grupo.max}`)
            }
            if (grupo.obligatorio && (grupo.min ?? 0) < 1) {
              problemas.push(`${tipo} → «${grupo.nombre}» obligatorio sin mínimo`)
            }
            if ((grupo.min ?? 0) > (grupo.max ?? 1)) {
              problemas.push(`${tipo} → «${grupo.nombre}» tiene mínimo > máximo`)
            }
          }
        }
      }
    }
    expect(problemas, problemas.join('\n')).toEqual([])
  })

  it('los productos, sus grupos y las listas nacen ordenados', () => {
    for (const tipo of businessTypesWithTemplate()) {
      const plantilla = templateForBusinessType(tipo)
      for (const categoria of plantilla.categorias) {
        ;(categoria.productos || []).forEach((producto, puesto) => {
          expect(producto.orden, `${tipo} → ${producto.nombre}`).toBe(puesto)
          ;(producto.grupos || []).forEach((grupo, lugar) => {
            expect(grupo.orden, `${tipo} → ${producto.nombre} → ${grupo.nombre}`).toBe(lugar)
          })
        })
      }
      for (const lista of plantilla.listas || []) {
        lista.opciones.forEach((opcion, lugar) => {
          expect(opcion.orden, `${tipo} → ${lista.nombre} → ${opcion.nombre}`).toBe(lugar)
        })
      }
    }
  })
})
