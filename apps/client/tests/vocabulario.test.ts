import { describe, expect, it } from 'vitest'
import { vocabularioDe } from '../src/features/catalog/vocabulario'

// ═══════════════════════════════════════════════════════════════════════════
// EL CATÁLOGO HABLA EL OFICIO DEL LOCAL
// ═══════════════════════════════════════════════════════════════════════════
//
// Se entregó el 2026-09-14 SIN pruebas —el panel no tenía ninguna— y se
// verificó compilando la función a mano. Esto es esa verificación, escrita.

describe('vocabularioDe', () => {
  it('cada oficio ve ejemplos de SU carta', () => {
    expect(vocabularioDe('almuerzos').ejemploProducto).toContain('Almuerzo')
    expect(vocabularioDe('heladeria').ejemploProducto).toContain('Helado')
    expect(vocabularioDe('marisqueria').ejemploProducto).toContain('Ceviche')
    expect(vocabularioDe('pizzeria').ejemploProducto).toContain('Pizza')
  })

  it('⚠️ el tipo CON TILDE resuelve igual: así está en producción', () => {
    // El alta guarda la etiqueta escrita («pizzería») y las plantillas usan la
    // clave sin tilde («pizzeria»). Comparar en crudo dejaba a Monster Pizza
    // con el vocabulario genérico — y el fallo era invisible: nada se rompe,
    // solo se lee peor.
    expect(vocabularioDe('pizzería')).toEqual(vocabularioDe('pizzeria'))
    expect(vocabularioDe('heladería')).toEqual(vocabularioDe('heladeria'))
  })

  it('tolera el plural y las mayúsculas', () => {
    expect(vocabularioDe('Pizzerías')).toEqual(vocabularioDe('pizzeria'))
    expect(vocabularioDe('HELADERIA')).toEqual(vocabularioDe('heladeria'))
  })

  it('⚠️ un tipo desconocido cae al GENÉRICO, nunca al de otro oficio', () => {
    // Un ejemplo neutro ayuda poco; uno equivocado desorienta, que es justo el
    // problema que esto resuelve.
    const generico = vocabularioDe('barbería')
    expect(generico.ejemploProducto).toBe('Ej: Plato del día')
    expect(generico).toEqual(vocabularioDe(null))
    expect(generico).toEqual(vocabularioDe(''))
    expect(generico).not.toEqual(vocabularioDe('pizzeria'))
  })

  it('cada oficio nombra sus tamaños como se dicen ahí', () => {
    expect(vocabularioDe('heladeria').tamanos).toBe('Presentaciones')
    expect(vocabularioDe('asadero').tamanos).toBe('Presas')
    expect(vocabularioDe('carniceria').tamanos).toBe('Cortes')
  })

  it('ningún oficio se queda sin los cuatro textos', () => {
    for (const tipo of [
      'almuerzos', 'desayunos', 'heladeria', 'pizzeria', 'hamburgueseria',
      'marisqueria', 'asadero', 'parrillada', 'sushi', 'pasteleria', 'postres',
      'batidos', 'jugos', 'carniceria', 'panaderia', 'cafeteria', 'restaurante',
    ]) {
      const v = vocabularioDe(tipo)
      for (const campo of ['ejemploProducto', 'tamanos', 'ejemploTamano', 'ejemploGrupo', 'ejemploOpciones'] as const) {
        expect(String(v[campo]).trim().length, `${tipo}.${campo}`).toBeGreaterThan(2)
      }
    }
  })

  it('⚠️ y NINGUNO que no sea pizzería menciona pizza', () => {
    // Era el pedido literal del dueño: «no puede ser posible que un local de
    // almuerzos diga pizza».
    for (const tipo of ['almuerzos', 'heladeria', 'marisqueria', 'asadero', 'panaderia', 'sushi']) {
      const texto = Object.values(vocabularioDe(tipo)).join(' ').toLowerCase()
      expect(texto, tipo).not.toContain('pizza')
    }
  })
})
