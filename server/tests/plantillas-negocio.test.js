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
    expect(tipos.length).toBeGreaterThanOrEqual(30)
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
    for (const tipo of ['ferretería', 'perfumería', 'barbería', 'hotel', 'inmobiliaria']) {
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
    // Sin tipo, con un tipo desconocido o con una barbería —que no usa esto—
    // se cae al defecto en vez de inventar.
    expect(prepTimeForBusinessType('barbería')).toBe(PREP_TIME_POR_DEFECTO)
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
