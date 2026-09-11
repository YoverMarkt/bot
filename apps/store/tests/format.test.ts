import { describe, expect, it } from 'vitest'
import { cuandoAbre, hora12, rangoDeHoy } from '../src/lib/format'

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

// ═══════════════════════════════════════════════════════════════════════════
// CUÁNDO ABRE, DICHO COMO LO DIRÍA UNA PERSONA
//
// El dueño vio a la 01:10 de un miércoles: «Cerrado · 8:00 AM – 2:00 AM». El
// estado era correcto, pero el rango se lee como una contradicción. Cerrado,
// lo único que sirve es a qué hora volver.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuandoAbre', () => {
  it('dice hoy, mañana o el día que toque', () => {
    expect(cuandoAbre({ open: '08:00', inDays: 0, dayName: 'Miércoles' }))
      .toBe('Abre hoy 8:00 AM')
    expect(cuandoAbre({ open: '08:00', inDays: 1, dayName: 'Jueves' }))
      .toBe('Abre mañana 8:00 AM')
    // En minúscula: va dentro de una frase, no empieza oración.
    expect(cuandoAbre({ open: '11:30', inDays: 6, dayName: 'Domingo' }))
      .toBe('Abre el domingo 11:30 AM')
  })

  it('en AM/PM, que es como se dice una hora aquí', () => {
    expect(cuandoAbre({ open: '13:00', inDays: 0, dayName: 'Lunes' }))
      .toBe('Abre hoy 1:00 PM')
    expect(cuandoAbre({ open: '00:00', inDays: 1, dayName: 'Lunes' }))
      .toBe('Abre mañana 12:00 AM')
  })

  // ⚠️ El servidor solo manda `nextOpen` con la tienda cerrada, y una versión
  // vieja del servidor no lo manda nunca. La app no puede romperse por eso:
  // se queda sin la frase, no sin pantalla. Comprobado en captura contra
  // producción antes de desplegar el servidor nuevo.
  it('sin dato no inventa nada', () => {
    expect(cuandoAbre(null)).toBe(null)
    expect(cuandoAbre(undefined)).toBe(null)
    expect(cuandoAbre({ open: '', inDays: 0, dayName: 'Lunes' })).toBe(null)
  })
})

describe('rangoDeHoy', () => {
  it('enseña el rango del día en 12 horas', () => {
    expect(rangoDeHoy({ open: '08:00', close: '22:00' })).toBe('8:00 AM – 10:00 PM')
  })

  it('con 24 horas lo DICE en vez de pintar un rango', () => {
    // ⚠️ El caso que motivó la marca. El servidor manda igual el par de horas
    // —para que una app vieja siga pintando algo— así que si esto mirara las
    // horas en vez de `allDay`, el cliente leería «12:00 AM – 11:59 PM» y
    // tendría que deducir que eso significa que nunca cierran.
    expect(rangoDeHoy({ open: '00:00', close: '23:59', allDay: true })).toBe('24 horas')
  })

  it('sin horario no inventa nada', () => {
    expect(rangoDeHoy(null)).toBe(null)
    expect(rangoDeHoy(undefined)).toBe(null)
    expect(rangoDeHoy({ open: '', close: '22:00' })).toBe(null)
  })
})
