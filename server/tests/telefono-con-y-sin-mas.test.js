import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../dist/db')

// ═══════════════════════════════════════════════════════════════════════════
// EL MISMO NÚMERO, GUARDADO DE DOS FORMAS
// ═══════════════════════════════════════════════════════════════════════════
//
// Un pedido hecho por la mini app guarda `593990978367` —el CHECK de la
// sesión exige solo dígitos— y el MISMO cliente escribiendo por WhatsApp llega
// como `+593990978367`. Buscar con `=` no encuentra nada, y no falla: devuelve
// vacío, que es peor, porque parece que ese cliente nunca pidió.
//
// Costó un rato el 2026-08-12: el comprobante que llegaba por el chat no se
// adjuntaba a ningún pedido, el bot respondía con el enlace del menú a quien
// acababa de pagar, y NO había ningún error que mirar en el registro.
//
// ⚠️ Esto NO toca el envío. `ycloud.sendText` pasa el número tal cual llega y
// no pasa por aquí: lo que se normaliza es la BÚSQUEDA en la base. Los avisos
// al cliente ya salían con el número sin `+` y llegaban — se comprobó contra
// los pedidos reales que tienen `customer_notified_status` puesto.

describe('variantes del teléfono para buscar en la base', () => {
  it('busca con el «+» y sin él, venga como venga', () => {
    // Como llega por WhatsApp…
    expect(db.variantesDelTelefono('+593990978367'))
      .toEqual(['+593990978367', '593990978367'])
    // …y como lo guarda la mini app.
    expect(db.variantesDelTelefono('593990978367'))
      .toEqual(['593990978367', '+593990978367'])
  })

  it('limpia espacios y guiones, que la gente escribe de todo', () => {
    const variantes = db.variantesDelTelefono(' +593 99-097-8367 ')
    expect(variantes).toContain('593990978367')
    expect(variantes).toContain('+593990978367')
  })

  it('no repite: una lista con duplicados sería una consulta más lenta', () => {
    for (const entrada of ['+593990978367', '593990978367', '593 990 978 367']) {
      const variantes = db.variantesDelTelefono(entrada)
      expect(new Set(variantes).size, entrada).toBe(variantes.length)
    }
  })

  it('sin nada que buscar devuelve una lista vacía, no un comodín', () => {
    // Con `[]`, un `.in()` no encuentra nada — que es lo correcto. Devolver
    // algo como `['']` haría coincidir filas con el teléfono vacío.
    expect(db.variantesDelTelefono('')).toEqual([])
    expect(db.variantesDelTelefono('   ')).toEqual([])
  })

  it('lo que no tiene dígitos se busca tal cual, sin inventar un «+»', () => {
    expect(db.variantesDelTelefono('mostrador')).toEqual(['mostrador'])
  })
})
