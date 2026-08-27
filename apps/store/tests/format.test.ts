import { describe, expect, it } from 'vitest'
import { hora12 } from '../src/lib/format'

describe('hora12', () => {
  // ⚠️ Las dos que rompen cualquier versión ingenua, y son justo las que este
  // negocio tiene: Monster Pizza abre 09:00 y cierra 03:00.
  it('medianoche es 12 AM y mediodía es 12 PM, no «0»', () => {
    expect(hora12('00:00')).toBe('12:00 AM')
    expect(hora12('00:30')).toBe('12:30 AM')
    expect(hora12('12:00')).toBe('12:00 PM')
    expect(hora12('12:45')).toBe('12:45 PM')
  })

  it('la mañana y la tarde salen del módulo 12', () => {
    expect(hora12('09:00')).toBe('9:00 AM')
    expect(hora12('03:00')).toBe('3:00 AM')
    expect(hora12('11:59')).toBe('11:59 AM')
    expect(hora12('13:05')).toBe('1:05 PM')
    expect(hora12('23:15')).toBe('11:15 PM')
  })

  // Sin cero delante en la hora, pero SÍ en los minutos.
  it('no pone cero a la izquierda en la hora y sí en los minutos', () => {
    expect(hora12('09:05')).toBe('9:05 AM')
    expect(hora12('08:00')).not.toContain('08')
  })

  // Mejor enseñar la hora cruda que un «NaN:00 AM» delante del cliente.
  it('una hora que no se entiende se devuelve tal cual', () => {
    for (const malo of ['', null, undefined, 'abierto', '99:99']) {
      expect(hora12(malo)).toBe(String(malo ?? '').trim())
    }
  })
})
